#!/usr/bin/env node
/*
 * iD Tech Classroom Monitor — control hub (Node.js, zero dependencies).
 *
 *   node server/server.js            # listens on 0.0.0.0:8765
 *   PORT=9000 node server/server.js  # custom port
 *
 * Responsibilities:
 *   - serve the web app (login / instructor monitor / admin panel) at /
 *   - REST  POST /api/login            issue a session token
 *   - REST  GET  /api/public           what the login page needs to know
 *   - WS    /ws/agent                  student laptops connect here
 *   - WS    /ws/dashboard              instructor + admin UIs connect here
 *
 * Org model (persisted to data/config.json):
 *   Location -> Building -> Class ;   Computer (agent) -> Building (physical),
 *   optionally assigned to a Class. The Location dimension is the worldwide
 *   scaling axis (beta uses only "Stanford").
 *
 * TODO(scale): swap the JSON file for Postgres/Redis; add TLS (wss://) and
 *   per-instructor tenancy; ship the agent as a signed boot service via MDM.
 */

"use strict";

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = parseInt(process.env.PORT || "8765", 10);
const ENROLL_TOKEN = process.env.IDT_ENROLL_TOKEN || ""; // optional agent secret
const DASHBOARD_DIR = path.join(__dirname, "..", "dashboard");
const DATA_DIR = path.join(__dirname, "..", "data");
const CONFIG_PATH = process.env.IDT_CONFIG_PATH || path.join(DATA_DIR, "config.json");
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// ==========================================================================
// Persistent config (org tree + assignments + auth)
// ==========================================================================
function genId(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
}

let config = {
  locations: [], // [{ id, name, aliases:[], buildings:[{ id, name, aliases:[], classes:[{id,name,instructor,room}] }] }]
  assignments: {}, // deviceId -> classId
  layouts: {}, // layoutKey -> { deviceId: {x,y} }  (seating-chart positions, 0..1)
  schedules: [], // [{ id, name, time:"HH:MM", days:[0-6], target, commands:[{action,params}], enabled, lastFired }]
  auth: {}, // { adminHash, adminSalt, instructorCode }
};

function loadConfig() {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    config.locations ||= [];
    config.assignments ||= {};
    config.layouts ||= {};
    config.schedules ||= [];
    config.auth ||= {};
  } catch (_) {
    // first run — seed a Stanford location so the UI isn't empty
    config = {
      locations: [
        { id: genId("loc"), name: "Stanford", aliases: ["stanford"], buildings: [] },
      ],
      assignments: {},
      layouts: {},
      schedules: [],
      auth: {},
    };
  }

  // bootstrap admin password if not set (env var, else a loud default)
  if (!config.auth.adminHash) {
    const initial = process.env.IDT_ADMIN_PASSWORD || "changeme";
    setAdminPassword(initial);
    if (!process.env.IDT_ADMIN_PASSWORD) {
      console.log(
        '[hub] WARNING: admin password defaulted to "changeme". ' +
          "Set IDT_ADMIN_PASSWORD or change it in the admin panel."
      );
    }
  }
  saveConfig();
}

let saveTimer = null;
function saveConfig() {
  // debounce disk writes a touch to coalesce rapid edits
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    } catch (err) {
      console.error("[hub] failed to save config:", err.message);
    }
  }, 100);
}

// ---- auth helpers --------------------------------------------------------
function hashPassword(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 64).toString("hex");
}
function setAdminPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  config.auth.adminSalt = salt;
  config.auth.adminHash = hashPassword(pw, salt);
}
function checkAdminPassword(pw) {
  if (!config.auth.adminHash) return false;
  const attempt = Buffer.from(hashPassword(pw, config.auth.adminSalt), "hex");
  const stored = Buffer.from(config.auth.adminHash, "hex");
  return attempt.length === stored.length && crypto.timingSafeEqual(attempt, stored);
}

const sessions = new Map(); // token -> { role, expires }
function issueToken(role) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { role, expires: Date.now() + SESSION_TTL_MS });
  return token;
}
function validateToken(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return s;
}

// ---- org lookups ---------------------------------------------------------
const norm = (s) => String(s || "").trim().toLowerCase();

function findLocation(id) {
  return config.locations.find((l) => l.id === id) || null;
}
function findBuilding(id) {
  for (const loc of config.locations) {
    const b = loc.buildings.find((x) => x.id === id);
    if (b) return { location: loc, building: b };
  }
  return null;
}
function findClass(id) {
  for (const loc of config.locations)
    for (const b of loc.buildings) {
      const c = b.classes.find((x) => x.id === id);
      if (c) return { location: loc, building: b, klass: c };
    }
  return null;
}

// Resolve a location/building reported by an agent, creating them (and
// recording the reported name as an alias) so the tree self-populates.
function resolveLocationBuilding(locationName, buildingName) {
  const ln = norm(locationName) || "unassigned";
  const bn = norm(buildingName) || "unassigned";

  let loc = config.locations.find(
    (l) => norm(l.name) === ln || (l.aliases || []).some((a) => norm(a) === ln)
  );
  if (!loc) {
    loc = { id: genId("loc"), name: locationName || "Unassigned", aliases: [ln], buildings: [] };
    config.locations.push(loc);
  } else if (!(loc.aliases || []).some((a) => norm(a) === ln)) {
    (loc.aliases ||= []).push(ln);
  }

  let bld = loc.buildings.find(
    (b) => norm(b.name) === bn || (b.aliases || []).some((a) => norm(a) === bn)
  );
  if (!bld) {
    bld = { id: genId("bld"), name: buildingName || "Unassigned", aliases: [bn], code: "8676", classes: [] };
    loc.buildings.push(bld);
  } else if (!(bld.aliases || []).some((a) => norm(a) === bn)) {
    (bld.aliases ||= []).push(bn);
  }

  return { locationId: loc.id, buildingId: bld.id, building: bld };
}

// Class a device is currently assigned to (validated against its building).
function deviceClassId(deviceId, buildingId) {
  const cid = config.assignments[deviceId];
  if (!cid) return null;
  const found = findClass(cid);
  if (!found || found.building.id !== buildingId) return null;
  return cid;
}

// ==========================================================================
// Minimal RFC 6455 WebSocket connection (server side)
// ==========================================================================
class WSConn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.closed = false;
    this.onmessage = null;
    this.onclose = null;
    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("close", () => this._markClosed());
    socket.on("error", () => this._markClosed());
  }
  _markClosed() {
    if (this.closed) return;
    this.closed = true;
    if (this.onclose) this.onclose();
  }
  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    let frame;
    while ((frame = this._tryParseFrame()) !== null) {
      const { opcode, payload } = frame;
      if (opcode === 0x8) return this.close();
      if (opcode === 0x9) this._sendFrame(payload, 0xa); // ping -> pong
      else if (opcode === 0x1 && this.onmessage) {
        try {
          this.onmessage(payload.toString("utf8"));
        } catch (_) {
          /* ignore handler errors */
        }
      }
    }
  }
  _tryParseFrame() {
    const buf = this.buf;
    if (buf.length < 2) return null;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      len = buf.readUInt32BE(offset) * 2 ** 32 + buf.readUInt32BE(offset + 4);
      offset += 8;
    }
    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.slice(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return null;
    let payload = buf.slice(offset, offset + len);
    if (masked) {
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
      payload = out;
    }
    this.buf = buf.slice(offset + len);
    return { opcode, payload };
  }
  _sendFrame(payload, opcode) {
    if (this.closed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
      header.writeUInt32BE(len >>> 0, 6);
    }
    header[0] = 0x80 | opcode;
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch (_) {
      /* socket gone */
    }
  }
  sendJSON(obj) {
    this._sendFrame(Buffer.from(JSON.stringify(obj), "utf8"), 0x1);
  }
  close() {
    if (this.closed) return;
    try {
      this._sendFrame(Buffer.alloc(0), 0x8);
      this.socket.end();
    } catch (_) {
      /* ignore */
    }
    this._markClosed();
  }
}

// ==========================================================================
// Live device registry (not persisted — reflects connected agents)
// ==========================================================================
const devices = new Map(); // deviceId -> record
const agentWs = new Map(); // deviceId -> WSConn
const wsDevice = new Map(); // WSConn -> deviceId
const dashboards = new Set(); // authenticated WSConns { role }
// Enforced warning/transition overlays are authoritative on the hub while it
// is running. Informational messages remain dismissible one-shot commands.
const activeMessages = new Map(); // deviceId -> { id, kind, text, expires_at }

function registerAgent(ws, info) {
  const deviceId = String(info.device_id || `unknown-${Date.now()}`);
  const { locationId, buildingId, building } = resolveLocationBuilding(
    info.location,
    info.building
  );

  // Optional class hint: if the laptop was started with --class and the admin
  // hasn't assigned it yet, auto-create that class and assign it (friendly for
  // first-time setup; admin assignment always takes precedence afterwards).
  const hint = (info.klass || "").trim();
  if (hint && !config.assignments[deviceId]) {
    let cls = building.classes.find((c) => norm(c.name) === norm(hint));
    if (!cls) {
      cls = { id: genId("cls"), name: hint, instructor: "", room: "" };
      building.classes.push(cls);
    }
    config.assignments[deviceId] = cls.id;
  }

  const prev = devices.get(deviceId) || {};
  devices.set(deviceId, {
    device_id: deviceId,
    hostname: info.hostname || deviceId,
    os: info.os || "unknown",
    locationId,
    buildingId,
    online: true,
    last_seen: Date.now() / 1000,
    windows: prev.windows || [],
    processes: prev.processes || [],
    blocked: prev.blocked || [],
    blockedSites: prev.blockedSites || [],
    sitesAvailable: prev.sitesAvailable,
  });
  agentWs.set(deviceId, ws);
  wsDevice.set(ws, deviceId);
  saveConfig();
  return deviceId;
}

function updateDevice(ws, data) {
  const deviceId = wsDevice.get(ws);
  const rec = deviceId && devices.get(deviceId);
  if (!rec) return null;
  for (const key of ["windows", "processes", "blocked", "blockedSites", "sitesAvailable"])
    if (key in data) rec[key] = data[key];
  rec.online = true;
  rec.last_seen = Date.now() / 1000;
  return deviceId;
}

function disconnectAgent(ws) {
  const deviceId = wsDevice.get(ws);
  if (deviceId) {
    wsDevice.delete(ws);
    agentWs.delete(deviceId);
    const rec = devices.get(deviceId);
    if (rec) {
      rec.online = false;
      rec.last_seen = Date.now() / 1000;
    }
  }
  return deviceId;
}

// ---- state broadcast -----------------------------------------------------
function orgView() {
  // strip internal aliases from what we ship to the browser
  return config.locations.map((loc) => ({
    id: loc.id,
    name: loc.name,
    buildings: loc.buildings.map((b) => ({
      id: b.id,
      name: b.name,
      code: b.code || "8676",
      classes: b.classes.map((c) => ({
        id: c.id,
        name: c.name,
        instructor: c.instructor || "",
        room: c.room || "",
      })),
    })),
  }));
}

function activeMessageFor(deviceId) {
  const message = activeMessages.get(deviceId);
  if (!message) return null;
  if (message.expires_at && message.expires_at <= Date.now() / 1000) return null;
  return { ...message };
}

function devicesView() {
  const out = {};
  for (const rec of devices.values()) {
    out[rec.device_id] = {
      device_id: rec.device_id,
      hostname: rec.hostname,
      os: rec.os,
      locationId: rec.locationId,
      buildingId: rec.buildingId,
      classId: deviceClassId(rec.device_id, rec.buildingId),
      online: rec.online,
      last_seen: rec.last_seen,
      windows: rec.windows,
      processes: rec.processes,
      blocked: rec.blocked,
      blockedSites: rec.blockedSites || [],
      sitesAvailable: rec.sitesAvailable,
      activeMessage: activeMessageFor(rec.device_id),
    };
  }
  return out;
}

function stateMessage() {
  return {
    type: "state",
    org: orgView(),
    devices: devicesView(),
    layouts: config.layouts,
    schedules: config.schedules,
    instructorCodeRequired: !!config.auth.instructorCode,
  };
}

function broadcastState() {
  const msg = stateMessage();
  for (const ws of [...dashboards]) {
    if (ws.closed) dashboards.delete(ws);
    else ws.sendJSON(msg);
  }
}

// ---- command routing -----------------------------------------------------
function matchesTarget(deviceId, rec, target) {
  const scope = (target && target.scope) || "device";
  if (scope === "all") return true;
  if (scope === "device") return deviceId === target.deviceId;
  if (scope === "location") return rec.locationId === target.locationId;
  if (scope === "building") return rec.buildingId === target.buildingId;
  if (scope === "class") return deviceClassId(deviceId, rec.buildingId) === target.classId;
  return false;
}

function deviceIdsFor(target) {
  const out = [];
  for (const [deviceId, rec] of devices) {
    if (matchesTarget(deviceId, rec, target || {})) out.push(deviceId);
  }
  return out;
}

function targetsFor(target) {
  return deviceIdsFor(target)
    .map((deviceId) => agentWs.get(deviceId))
    .filter(Boolean);
}

const MESSAGE_KINDS = new Set(["info", "warning", "transition"]);
function normalizeMessageParams(params) {
  const source = params || {};
  const kind = MESSAGE_KINDS.has(source.kind) ? source.kind : "info";
  const text = String(source.text || "").trim().slice(0, 4000);
  const requestedTimeout = Number(source.timeout_sec);
  const timeout_sec = Number.isFinite(requestedTimeout)
    ? Math.max(0, Math.min(86400, Math.floor(requestedTimeout)))
    : 0;
  return { kind, text, timeout_sec };
}

function sendMessageState(deviceId) {
  const ws = agentWs.get(deviceId);
  if (!ws) return false;
  ws.sendJSON({
    type: "command",
    action: "message_state",
    params: { message: activeMessageFor(deviceId) },
  });
  return true;
}

function sendCommand(target, action, params) {
  if (action === "message") {
    const message = normalizeMessageParams(params);
    if (!message.text) return 0;

    if (message.kind === "warning" || message.kind === "transition") {
      const deviceIds = deviceIdsFor(target);
      const authoritative = {
        id: genId("msg"),
        kind: message.kind,
        text: message.text,
        expires_at: message.timeout_sec ? Date.now() / 1000 + message.timeout_sec : 0,
      };
      let sent = 0;
      for (const deviceId of deviceIds) {
        activeMessages.set(deviceId, authoritative);
        if (sendMessageState(deviceId)) sent++;
      }
      console.log(
        `[hub] ${message.kind} message ${authoritative.id} activated for ${deviceIds.length} computer(s)`
      );
      broadcastState();
      return sent;
    }

    const command = { type: "command", action: "message", params: message };
    let sent = 0;
    for (const ws of targetsFor(target)) {
      ws.sendJSON(command);
      sent++;
    }
    console.log(`[hub] informational message sent to ${sent} computer(s)`);
    return sent;
  }

  if (action === "clear_message") {
    const deviceIds = deviceIdsFor(target);
    let sent = 0;
    let changed = false;
    for (const deviceId of deviceIds) {
      if (activeMessages.delete(deviceId)) changed = true;
      if (sendMessageState(deviceId)) sent++;
    }
    console.log(`[hub] enforced message cleared for ${deviceIds.length} computer(s)`);
    if (changed) broadcastState();
    return sent;
  }

  const command = { type: "command", action, params: params || {} };
  let sent = 0;
  for (const ws of targetsFor(target)) {
    ws.sendJSON(command);
    sent++;
  }
  return sent;
}

// ==========================================================================
// Admin org mutations
// ==========================================================================
function applyOrgOp(op) {
  switch (op.op) {
    case "addLocation":
      config.locations.push({ id: genId("loc"), name: op.name || "New Location", aliases: [], buildings: [] });
      break;
    case "renameLocation": {
      const loc = findLocation(op.id);
      if (loc && op.name) loc.name = op.name;
      break;
    }
    case "deleteLocation": {
      const loc = findLocation(op.id);
      if (loc) {
        for (const b of loc.buildings) for (const c of b.classes) unassignClass(c.id);
        config.locations = config.locations.filter((l) => l.id !== op.id);
      }
      break;
    }
    case "addBuilding": {
      const loc = findLocation(op.locationId);
      if (loc) loc.buildings.push({ id: genId("bld"), name: op.name || "New Building", aliases: [], code: "8676", classes: [] });
      break;
    }
    case "renameBuilding": {
      const f = findBuilding(op.id);
      if (f && op.name) f.building.name = op.name;
      break;
    }
    case "setBuildingCode": {
      const f = findBuilding(op.id);
      if (f) f.building.code = String(op.code || "").replace(/\D/g, "").slice(0, 4);
      break;
    }
    case "deleteBuilding": {
      const f = findBuilding(op.id);
      if (f) {
        for (const c of f.building.classes) unassignClass(c.id);
        f.location.buildings = f.location.buildings.filter((b) => b.id !== op.id);
      }
      break;
    }
    case "addClass": {
      const f = findBuilding(op.buildingId);
      if (f)
        f.building.classes.push({
          id: genId("cls"),
          name: op.name || "New Class",
          instructor: op.instructor || "",
          room: op.room || "",
        });
      break;
    }
    case "updateClass": {
      const f = findClass(op.id);
      if (f) {
        if (op.name !== undefined) f.klass.name = op.name;
        if (op.instructor !== undefined) f.klass.instructor = op.instructor;
        if (op.room !== undefined) f.klass.room = op.room;
      }
      break;
    }
    case "deleteClass": {
      const f = findClass(op.id);
      if (f) {
        unassignClass(op.id);
        delete config.layouts[op.id];
        f.building.classes = f.building.classes.filter((c) => c.id !== op.id);
      }
      break;
    }
    case "assign": {
      if (op.classId) config.assignments[op.deviceId] = op.classId;
      else delete config.assignments[op.deviceId];
      break;
    }
    case "addSchedule":
      config.schedules.push({
        id: genId("sch"),
        name: op.name || "New event",
        time: op.time || "12:00",
        days: Array.isArray(op.days) ? op.days : [],
        target: op.target || { scope: "all" },
        commands: Array.isArray(op.commands) ? op.commands : [],
        enabled: op.enabled !== false,
        lastFired: null,
      });
      break;
    case "updateSchedule": {
      const s = config.schedules.find((x) => x.id === op.id);
      if (s)
        for (const k of ["name", "time", "days", "target", "commands", "enabled"])
          if (k in op) s[k] = op[k];
      break;
    }
    case "deleteSchedule":
      config.schedules = config.schedules.filter((x) => x.id !== op.id);
      break;
    case "setInstructorCode":
      config.auth.instructorCode = (op.code || "").trim();
      break;
    case "setAdminPassword":
      if (op.newPassword) setAdminPassword(op.newPassword);
      break;
    default:
      return false;
  }
  saveConfig();
  return true;
}

function unassignClass(classId) {
  for (const [dev, cid] of Object.entries(config.assignments))
    if (cid === classId) delete config.assignments[dev];
}

// Seating-chart positions. Allowed for instructors as well as admins.
function applyLayoutOp(op) {
  if (op.op === "setPosition") {
    const key = String(op.layoutKey || "");
    const dev = String(op.deviceId || "");
    const x = Number(op.x);
    const y = Number(op.y);
    if (!key || !dev || Number.isNaN(x) || Number.isNaN(y)) return false;
    (config.layouts[key] ||= {})[dev] = {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
    };
  } else if (op.op === "resetLayout") {
    delete config.layouts[String(op.layoutKey || "")];
  } else {
    return false;
  }
  saveConfig();
  return true;
}

// ==========================================================================
// Connection handlers
// ==========================================================================
function handleAgent(ws) {
  let registered = false;
  ws.onmessage = (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      return;
    }
    if (!registered) {
      if (msg.type !== "register") return ws.close();
      if (ENROLL_TOKEN && msg.token !== ENROLL_TOKEN) {
        ws.sendJSON({ type: "error", detail: "invalid enrollment token" });
        return ws.close();
      }
      const id = registerAgent(ws, msg);
      registered = true;
      console.log(`[hub] agent online: ${id} (${msg.location} / ${msg.building})`);
      // The hub is authoritative: every registration receives either the
      // currently active enforced message or an explicit null that clears a
      // stale local overlay after reconnecting.
      sendMessageState(id);
      broadcastState();
      return;
    }
    if (msg.type === "status") {
      updateDevice(ws, msg);
      broadcastState();
    } else if (msg.type === "message_state_request") {
      const id = wsDevice.get(ws);
      if (id) sendMessageState(id);
    }
  };
  ws.onclose = () => {
    if (registered) {
      const id = disconnectAgent(ws);
      console.log(`[hub] agent offline: ${id}`);
      broadcastState();
    }
  };
}

function handleDashboard(ws) {
  ws.role = null;
  ws.onmessage = (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      return;
    }

    // first message must authenticate
    if (!ws.role) {
      if (msg.type !== "auth") return ws.close();
      const session = validateToken(msg.token);
      if (!session) {
        ws.sendJSON({ type: "auth_error" });
        return ws.close();
      }
      ws.role = session.role;
      dashboards.add(ws);
      ws.sendJSON({ type: "auth_ok", role: ws.role });
      ws.sendJSON(stateMessage());
      return;
    }

    if (msg.type === "command") {
      const sent = sendCommand(msg.target || {}, msg.action, msg.params);
      ws.sendJSON({ type: "ack", action: msg.action, sent });
    } else if (msg.type === "org") {
      if (ws.role !== "admin") {
        ws.sendJSON({ type: "error", detail: "admin required" });
        return;
      }
      applyOrgOp(msg);
      broadcastState();
    } else if (msg.type === "layout") {
      // seating positions — any authenticated instructor/admin may adjust
      if (applyLayoutOp(msg)) broadcastState();
    }
  };
  ws.onclose = () => dashboards.delete(ws);
}

// ==========================================================================
// HTTP server
// ==========================================================================
const STATIC_ROUTES = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/fuzzy-search.js": { file: "fuzzy-search.js", type: "text/javascript; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch (_) {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split("?")[0];

  if (urlPath === "/healthz") {
    return sendJson(res, 200, {
      ok: true,
      devices: devices.size,
      dashboards: dashboards.size,
      locations: config.locations.length,
    });
  }

  if (urlPath === "/api/public" && req.method === "GET") {
    return sendJson(res, 200, {
      instructorCodeRequired: !!config.auth.instructorCode,
    });
  }

  if (urlPath === "/api/login" && req.method === "POST") {
    const body = await readJsonBody(req);
    const role = body.role === "admin" ? "admin" : "instructor";
    if (role === "admin") {
      if (!checkAdminPassword(body.password))
        return sendJson(res, 401, { error: "Incorrect admin password." });
      return sendJson(res, 200, { token: issueToken("admin"), role });
    }
    // instructor
    if (config.auth.instructorCode && body.code !== config.auth.instructorCode)
      return sendJson(res, 401, { error: "Incorrect instructor access code." });
    return sendJson(res, 200, { token: issueToken("instructor"), role });
  }

  // Download the packaged agent (built separately via scripts/build-agent-exe.ps1)
  if (urlPath === "/download/id-tech-watch.exe") {
    const exe = path.join(BASE_DIR, "dist", "iD-Tech-Watch.exe");
    return fs.readFile(exe, (err, data) => {
      if (err) {
        res.writeHead(404, { "content-type": "text/plain" });
        return res.end(
          "iD-Tech-Watch.exe has not been built yet. On the hub machine run:\n  powershell -File scripts/build-agent-exe.ps1\nthen this download will work."
        );
      }
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="iD-Tech-Watch.exe"',
        "content-length": data.length,
      });
      res.end(data);
    });
  }

  const route = STATIC_ROUTES[urlPath];
  if (route) {
    return fs.readFile(path.join(DASHBOARD_DIR, route.file), (err, data) => {
      if (err) {
        res.writeHead(500, { "content-type": "text/plain" });
        return res.end("Server error");
      }
      res.writeHead(200, { "content-type": route.type });
      res.end(data);
    });
  }

  // SPA fallback: any other GET (e.g. /demo, /Stanford/Ada) serves the app so
  // client-side routing can handle it. (Unknown /api or /ws paths 404.)
  if (req.method === "GET" && !urlPath.startsWith("/api") && !urlPath.startsWith("/ws")) {
    return fs.readFile(path.join(DASHBOARD_DIR, "index.html"), (err, data) => {
      if (err) {
        res.writeHead(500, { "content-type": "text/plain" });
        return res.end("Server error");
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(data);
    });
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) return socket.destroy();
  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  const ws = new WSConn(socket);
  const urlPath = req.url.split("?")[0];
  if (urlPath === "/ws/agent") handleAgent(ws);
  else if (urlPath === "/ws/dashboard") handleDashboard(ws);
  else ws.close();
});

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces))
    for (const ni of ifaces[name] || [])
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
  return out;
}

// Keep the admin/hub machine from sleeping (IDT_KEEP_AWAKE=1). The helper holds
// the wake lock for the lifetime of this process.
function keepAwake() {
  try {
    if (process.platform === "win32") {
      const script =
        "$sig='[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint e);'; " +
        "$t=Add-Type -MemberDefinition $sig -Name Power -Namespace Win32 -PassThru; " +
        "while($true){ [void]$t::SetThreadExecutionState(0x80000041); Start-Sleep -Seconds 30 }";
      const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true,
        stdio: "ignore",
      });
      child.unref();
    } else if (process.platform === "darwin") {
      spawn("caffeinate", ["-dimsu"], { stdio: "ignore" }).unref();
    }
    console.log("[hub] keep-awake enabled (this machine will not sleep).");
  } catch (_) {
    /* best effort */
  }
}

function expireActiveMessages() {
  const now = Date.now() / 1000;
  const expired = [];
  for (const [deviceId, message] of activeMessages) {
    if (message.expires_at && message.expires_at <= now) {
      activeMessages.delete(deviceId);
      expired.push(deviceId);
      sendMessageState(deviceId);
    }
  }
  if (expired.length) {
    console.log(`[hub] enforced message timeout cleared ${expired.length} computer(s)`);
    broadcastState();
  }
}

// Fire scheduled events (daily timed closures/pauses/etc). Checks every 20s;
// the per-minute lastFired stamp prevents double-firing within a minute.
function pad2(n) {
  return String(n).padStart(2, "0");
}
function checkSchedules() {
  const now = new Date();
  const hhmm = pad2(now.getHours()) + ":" + pad2(now.getMinutes());
  const today = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const dow = now.getDay();
  let changed = false;
  for (const s of config.schedules || []) {
    if (!s.enabled || s.time !== hhmm) continue;
    if (Array.isArray(s.days) && s.days.length && !s.days.includes(dow)) continue;
    const stamp = `${today} ${hhmm}`;
    if (s.lastFired === stamp) continue;
    s.lastFired = stamp;
    changed = true;
    for (const c of s.commands || []) sendCommand(s.target || { scope: "all" }, c.action, c.params);
    console.log(`[hub] fired scheduled event "${s.name}" (${(s.commands || []).map((c) => c.action).join(", ")})`);
  }
  if (changed) {
    saveConfig();
    broadcastState();
  }
}

loadConfig();
setInterval(expireActiveMessages, 1000);
setInterval(checkSchedules, 20000);
if (process.env.IDT_KEEP_AWAKE === "1") keepAwake();
server.listen(PORT, HOST, () => {
  if (ENROLL_TOKEN) console.log("[hub] enrollment token required for agents");
  console.log(`[hub] locations: ${config.locations.map((l) => l.name).join(", ") || "(none)"}`);
  console.log("[hub] ready — open the console in a browser:");
  console.log(`[hub]   on this computer:    http://localhost:${PORT}/`);
  for (const ip of lanAddresses()) {
    console.log(`[hub]   from other laptops:  http://${ip}:${PORT}/`);
    console.log(`[hub]     (point agents at:  ws://${ip}:${PORT} )`);
  }
});
