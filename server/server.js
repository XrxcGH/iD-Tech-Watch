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
const DIST_DIR = path.join(__dirname, "..", "dist");
const CONFIG_PATH = process.env.IDT_CONFIG_PATH || path.join(DATA_DIR, "config.json");
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// The build stamp of the agent source this hub would push on "Update", so the
// dashboard can flag laptops running an older version.
//
// Re-read from disk (cached on mtime) rather than captured once at startup: a
// `git pull` on the hub machine updates agent.js underneath a running hub, and
// a stale stamp here makes every correctly-updated laptop show as "outdated".
const AGENT_SRC = path.join(__dirname, "..", "agent", "agent.js");
const WATCH_SRC = path.join(__dirname, "..", "agent", "watch.js");
let buildCache = { mtime: 0, build: "" };
function agentBuild() {
  try {
    const mtime = fs.statSync(AGENT_SRC).mtimeMs;
    if (mtime !== buildCache.mtime) {
      const m = /const BUILD = "([^"]*)"/.exec(fs.readFileSync(AGENT_SRC, "utf8"));
      buildCache = { mtime, build: m ? m[1] : "" };
    }
  } catch (_) {}
  return buildCache.build;
}

// Does the downloadable install package actually contain the current agent?
// `dist/` is git-ignored, so a `git pull` on the hub updates the source but
// leaves the old zip in place — the Download button would then hand out an
// agent that registers as outdated the moment it is installed.
//
// Compared by BUILD stamp (not mtime: git checkouts rewrite files without
// changing content, which would false-alarm). build-client.ps1 stages
// dist/iD-Tech-Watch/ and zips it, so the staged agent.js mirrors the zip.
let packagedCache = { mtime: 0, build: "" };
function clientZipInfo() {
  const zipPath = path.join(DIST_DIR, "iD-Tech-Watch.zip");
  if (!fs.existsSync(zipPath)) return { missing: true, stale: false, packagedBuild: "" };
  let packagedBuild = "";
  try {
    // cached on mtime: this runs on every state broadcast (i.e. every agent
    // heartbeat), and the staged agent.js is ~48 KB
    const stagedPath = path.join(DIST_DIR, "iD-Tech-Watch", "agent.js");
    const mtime = fs.statSync(stagedPath).mtimeMs;
    if (mtime !== packagedCache.mtime) {
      const m = /const BUILD = "([^"]*)"/.exec(fs.readFileSync(stagedPath, "utf8"));
      packagedCache = { mtime, build: m ? m[1] : "" };
    }
    packagedBuild = packagedCache.build;
  } catch (_) {
    // no staged copy to inspect — don't guess, and don't false-alarm
    return { missing: false, stale: false, packagedBuild: "", unknown: true };
  }
  const hub = agentBuild();
  return {
    missing: false,
    packagedBuild,
    stale: !!(hub && packagedBuild && packagedBuild !== hub),
    built: (() => {
      try {
        return new Date(fs.statSync(zipPath).mtimeMs).toISOString();
      } catch (_) {
        return "";
      }
    })(),
  };
}

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
  deviceNames: {}, // deviceId -> friendly name (e.g. this week's student), overrides hostname
  auth: {}, // { adminHash, adminSalt, instructorCode }
};

// A schedule's commands are frozen at save time, so "Block all games" events
// saved before Minecraft was pulled out of that set still carry it and would
// keep blocking a class that uses Minecraft to teach — while the editor now
// says the event excludes it. Drop Minecraft from those saved events so stored
// behaviour matches what the UI promises. Only touches block_all events.
function migrateSchedules() {
  let changed = 0;
  for (const s of config.schedules || []) {
    if (s.typeId !== "block_all") continue;
    for (const c of s.commands || []) {
      const p = c.params || {};
      if (c.action === "block_app" && Array.isArray(p.patterns)) {
        const kept = p.patterns.filter((x) => !String(x).toLowerCase().includes("minecraft"));
        if (kept.length !== p.patterns.length) (p.patterns = kept), changed++;
      }
      if (c.action === "block_site" && Array.isArray(p.domains)) {
        const kept = p.domains.filter((x) => !String(x).toLowerCase().includes("minecraft"));
        if (kept.length !== p.domains.length) (p.domains = kept), changed++;
      }
    }
  }
  if (changed) {
    console.log(`[hub] migrated ${changed} saved "block all games" rule(s) to exclude Minecraft`);
    saveConfig();
  }
}

function loadConfig() {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    config.locations ||= [];
    config.assignments ||= {};
    config.layouts ||= {};
    config.schedules ||= [];
    config.deviceNames ||= {};
    config.auth ||= {};
    config.deviceState ||= {}; // deviceId -> { blocks, paused }: survives a hub restart
    delete config.auth.instructorCode; // retired: buildings use 4-digit codes now
    migrateSchedules();
  } catch (_) {
    // first run — seed the Stanford beta campus with its buildings
    const seedBuildings = ["Tresidder", "Grove", "Phi Psi", "French", "Warehaus"].map((n) => ({
      id: genId("bld"),
      name: n,
      aliases: [n.toLowerCase()],
      code: "8676",
      classes: [],
    }));
    config = {
      locations: [{ id: genId("loc"), name: "Stanford", aliases: ["stanford"], buildings: seedBuildings }],
      assignments: {},
      layouts: {},
      schedules: [],
      deviceNames: {},
      deviceState: {},
      auth: {},
    };
  }
  config.deviceState ||= {}; // belt-and-braces: never let a lookup hit undefined

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
const screenshotViewers = new Map(); // deviceId -> Set<dashboard WSConn> currently viewing its live screen

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
    // display name entered at setup — seeds what shows on the monitor. A
    // dashboard rename (deviceNames) overrides it; this is just the default.
    agentName: (info.name != null ? String(info.name).trim().slice(0, 40) : "") || prev.agentName || "",
    build: (info.build != null ? String(info.build).slice(0, 80) : "") || prev.build || "",
    os: info.os || "unknown",
    locationId,
    buildingId,
    online: true,
    last_seen: Date.now() / 1000,
    windows: prev.windows || [],
    activeWindow: prev.activeWindow || "",
    processes: prev.processes || [],
    blocked: prev.blocked || [],
    blockedSites: prev.blockedSites || [],
    sitesAvailable: prev.sitesAvailable,
    // Both survive a reconnect so that rebooting the laptop cannot shake off
    // what is currently in force. `blocks` mirrors the ad-hoc/timed blocks the
    // agent was told to apply (persistent class/building rules live in config
    // and are re-applied separately); `paused` is the standing lock.
    // ...and seeded from disk when the HUB itself was restarted, so a hub
    // restart doesn't silently drop every block and pause in the building.
    blocks: prev.blocks || ((config.deviceState || {})[deviceId] || {}).blocks || { apps: {}, sites: {} },
    paused: prev.paused || ((config.deviceState || {})[deviceId] || {}).paused || null,
  });
  agentWs.set(deviceId, ws);
  wsDevice.set(ws, deviceId);
  saveConfig();

  reapplyEverythingToWs(ws, deviceId, buildingId);
  return deviceId;
}

// Restore EVERYTHING that is currently in force on a (re)connecting laptop.
// Restarting the machine used to be a clean escape: the agent came back with an
// empty head, so an active pause and any blocks an instructor had applied were
// simply gone. The hub is the authority on what should be in effect, so on every
// registration it resets the laptop to a known state and replays:
//   1. unblock_all  — discard whatever the agent thinks it has, so a block that
//                     was lifted while this laptop was offline doesn't come back
//   2. building-wide persistent rules, then this class's (building wins)
//   3. blocks aimed at this computer/class/building, with the time still left
//   4. the standing pause — or an explicit resume when there isn't one
function reapplyEverythingToWs(ws, deviceId, buildingId) {
  const rec = devices.get(deviceId);
  ws.sendJSON({ type: "command", action: "unblock_all", params: {} });
  reapplyPersistentToWs(ws, deviceId, buildingId);
  reapplyDeviceBlocks(ws, rec);
  reapplyPauseToWs(ws, rec);
}

// Replay the ad-hoc/timed blocks recorded for this device, carrying over only
// the time still remaining; expired ones are dropped.
function reapplyDeviceBlocks(ws, rec) {
  const b = rec && rec.blocks;
  if (!b) return;
  const now = Date.now();
  const left = (until) => (until ? Math.max(1, Math.round((until - now) / 1000)) : 0);
  let n = 0;
  for (const [key, e] of Object.entries(b.apps || {})) {
    if (e.until && e.until <= now) {
      delete b.apps[key];
      continue;
    }
    ws.sendJSON({
      type: "command",
      action: "block_app",
      params: { patterns: [e.pat], exclude: e.exclude || [], mode: e.mode || "minimize", cmd_match: e.cmd || "", duration_sec: left(e.until) },
    });
    n++;
  }
  for (const [domain, e] of Object.entries(b.sites || {})) {
    if (e.until && e.until <= now) {
      delete b.sites[domain];
      continue;
    }
    ws.sendJSON({ type: "command", action: "block_site", params: { domains: [domain], duration_sec: left(e.until) } });
    n++;
  }
  if (n) console.log(`[hub] restored ${n} active block(s) to reconnecting ${rec.device_id}`);
}

// Record the blocks in force on each addressed device, so they can be replayed
// after a restart. Mirrors what the agent keeps in memory, keyed the same way
// ("javaw (minecraft)") so repeats replace rather than accumulate.
function noteBlockState(target, action, params) {
  const p = params || {};
  const until = p.duration_sec ? Date.now() + Number(p.duration_sec) * 1000 : 0;
  const pats = [].concat(p.patterns || [], p.pattern ? [p.pattern] : []);
  const doms = [].concat(p.domains || [], p.domain ? [p.domain] : []);
  const cmdAll = String(p.cmd_match || p.cmdMatch || "").toLowerCase().trim();
  const exclude = [].concat(p.exclude || [], p.excludes || []);
  const mode = String(p.mode || "").toLowerCase() === "kill" ? "kill" : "minimize";
  const split = (raw) => {
    const m = /^(.+?)\s*\(([^()]+)\)$/.exec(String(raw || "").trim());
    return m ? { pat: m[1].trim(), cmd: m[2].trim() } : { pat: String(raw || "").trim(), cmd: cmdAll };
  };
  for (const deviceId of deviceIdsFor(target)) {
    const rec = devices.get(deviceId);
    if (!rec) continue;
    rec.blocks = rec.blocks || { apps: {}, sites: {} };
    const B = rec.blocks;
    if (action === "unblock_all") {
      rec.blocks = { apps: {}, sites: {} };
    } else if (action === "block_app") {
      for (const raw of pats) {
        const { pat, cmd } = split(raw);
        if (!pat) continue;
        B.apps[cmd ? `${pat} (${cmd})` : pat] = { pat, cmd, exclude, mode, until };
      }
    } else if (action === "unblock_app") {
      for (const raw of pats) {
        const { pat } = split(raw);
        delete B.apps[String(raw || "").trim()];
        for (const key of Object.keys(B.apps)) if (B.apps[key].pat === pat) delete B.apps[key];
      }
    } else if (action === "block_site") {
      for (const d of doms) if (d) B.sites[String(d).trim().toLowerCase()] = { until };
    } else if (action === "unblock_site") {
      for (const d of doms) delete B.sites[String(d || "").trim().toLowerCase()];
    }
    persistDeviceState(deviceId);
  }
}

// Remember whether a laptop is currently paused, so the state survives the
// agent dropping off (crash, sleep, or a deliberate reboot). Recorded for every
// pause/resume we send, whichever scope it was addressed to.
// Applied to every device the command was ADDRESSED to, connected or not.
// Keying this off live sockets was wrong: a laptop that is rebooting when the
// instructor presses Resume would never have its record cleared, and would then
// re-lock itself on reconnect — with an untimed pause, indefinitely.
function notePauseState(target, action, params) {
  for (const deviceId of deviceIdsFor(target)) {
    const rec = devices.get(deviceId);
    if (!rec) continue;
    if (action === "resume") {
      rec.paused = null;
      persistDeviceState(deviceId);
      continue;
    }
    const dur = Math.max(0, Math.round(Number((params || {}).duration_sec) || 0));
    rec.paused = {
      text: (params || {}).text || "",
      until: dur > 0 ? Date.now() + dur * 1000 : 0,
      at: Date.now(), // so a forgotten pause can't come back days later
    };
    persistDeviceState(deviceId);
  }
}

// Re-assert a pause on a reconnecting laptop, carrying over only the time that
// is actually left on a timed pause (an expired one just clears).
const PAUSE_MAX_AGE_MS = 12 * 60 * 60 * 1000; // don't resurrect yesterday's pause
function reapplyPauseToWs(ws, rec) {
  const p = rec && rec.paused;
  // No pause on record — say so explicitly rather than staying silent, so a
  // laptop can never come back still showing a lock the hub has released.
  if (!p) {
    ws.sendJSON({ type: "command", action: "resume", params: {} });
    return;
  }
  // A laptop that was shut down before an instructor resumed shouldn't boot up
  // locked the next morning. An untimed pause has no natural expiry, so age it.
  if (p.at && Date.now() - p.at > PAUSE_MAX_AGE_MS) {
    rec.paused = null;
    return;
  }
  let remain = 0;
  if (p.until) {
    remain = Math.round((p.until - Date.now()) / 1000);
    if (remain <= 0) {
      rec.paused = null;
      return;
    }
  }
  ws.sendJSON({ type: "command", action: "pause", params: { text: p.text || "", duration_sec: remain } });
  console.log(`[hub] re-applied pause to reconnecting ${rec.device_id}${remain ? ` (${remain}s left)` : ""}`);
}

// Push an org object's persistent always-block rules (apps + sites) down one ws.
function reapplyObjBlocks(ws, obj) {
  if (!obj) return;
  if (obj.blockApps && obj.blockApps.length) ws.sendJSON({ type: "command", action: "block_app", params: { patterns: obj.blockApps } });
  if (obj.blockSites && obj.blockSites.length) ws.sendJSON({ type: "command", action: "block_site", params: { domains: obj.blockSites } });
}
// Re-apply the building's + the device's class's persistent rules to one device.
// Building rules are applied first, then class — and this is called right after a
// class/device "unblock" so building-wide (and class) always-block rules survive
// an instructor's "Unblock all" (building policy is preferred over a class clear).
function reapplyPersistentToWs(ws, deviceId, buildingId) {
  const fb = findBuilding(buildingId);
  reapplyObjBlocks(ws, fb && fb.building);
  const cid = deviceClassId(deviceId, buildingId);
  if (cid) {
    const fc = findClass(cid);
    reapplyObjBlocks(ws, fc && fc.klass);
  }
}
// Re-apply persistent rules to every agent matching a command target.
function reapplyPersistentForTarget(target) {
  for (const ws of targetsFor(target)) {
    const deviceId = wsDevice.get(ws);
    const rec = deviceId && devices.get(deviceId);
    if (rec) reapplyPersistentToWs(ws, deviceId, rec.buildingId);
  }
}

// Rename a computer to a friendly name (e.g. this week's student). Persisted by
// device id, so it survives reconnects; blank clears it back to the hostname.
function applyRename(deviceId, name) {
  const id = String(deviceId || "");
  if (!id) return;
  const n = String(name || "").trim().slice(0, 40);
  if (n) config.deviceNames[id] = n;
  else delete config.deviceNames[id];
  saveConfig();
}

// Persistent "always block" rules — for a whole class OR a whole building, and
// for apps OR websites. Adds/removes the rule from the org tree and immediately
// (un)blocks it across the target; reconnecting devices get it re-applied above.
function applyRule(op) {
  const scope = op.buildingId ? "building" : "class"; // buildingrule vs classrule
  let obj, target;
  if (scope === "building") {
    const f = findBuilding(op.buildingId);
    if (!f) return;
    obj = f.building;
    target = { scope: "building", buildingId: op.buildingId };
  } else {
    const f = findClass(op.classId);
    if (!f) return;
    obj = f.klass;
    target = { scope: "class", classId: op.classId };
  }
  const isSite = op.kind === "site";
  const listKey = isSite ? "blockSites" : "blockApps";
  obj[listKey] = obj[listKey] || [];
  const raw = op.value != null ? op.value : op.pattern; // pattern = legacy app field
  const v = isSite
    ? String(raw || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "")
    : String(raw || "").toLowerCase().trim();
  if (!v) return;
  if (op.op === "add") {
    if (!obj[listKey].includes(v)) {
      obj[listKey].push(v);
      // track:false — these live in the org tree and are replayed from there
      if (isSite) sendCommand(target, "block_site", { domains: [v] }, { track: false });
      else sendCommand(target, "block_app", { patterns: [v] }, { track: false });
    }
  } else if (op.op === "remove") {
    obj[listKey] = obj[listKey].filter((x) => x !== v);
    if (isSite) sendCommand(target, "unblock_site", { domain: v }, { track: false });
    else sendCommand(target, "unblock_app", { pattern: v }, { track: false });
    // removing a class rule must not lift a building-wide block of the same thing
    if (scope === "class") reapplyPersistentForTarget(target);
  }
  saveConfig();
}

function updateDevice(ws, data) {
  const deviceId = wsDevice.get(ws);
  const rec = deviceId && devices.get(deviceId);
  if (!rec) return null;
  for (const key of ["windows", "activeWindow", "processes", "blocked", "blockedSites", "sitesAvailable"])
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

// Decommission a laptop: ask its agent to stop iD Tech Watch (which drops
// stop.flag so the watchdog stops BOTH the agent and its guardian), then forget
// the device everywhere. If the agent is offline we can't reach it, but we still
// remove it from the list. It only comes back if someone starts it again.
function removeDeviceById(id) {
  id = String(id || "");
  if (!id) return;
  const ws = agentWs.get(id);
  if (ws) {
    try {
      ws.sendJSON({ type: "command", action: "stop_watch", params: {} });
    } catch (_) {}
    // close the socket shortly after so it can't re-register before it exits
    setTimeout(() => {
      try {
        ws.close();
      } catch (_) {}
    }, 1500);
    wsDevice.delete(ws);
  }
  agentWs.delete(id);
  devices.delete(id);
  delete config.assignments[id];
  delete config.deviceNames[id];
  saveConfig();
  console.log(`[hub] removed device ${id}${ws ? " (sent stop_watch)" : " (was offline)"}`);
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
      blockApps: b.blockApps || [],
      blockSites: b.blockSites || [],
      classes: b.classes.map((c) => ({
        id: c.id,
        name: c.name,
        instructor: c.instructor || "",
        room: c.room || "",
        blockApps: c.blockApps || [],
        blockSites: c.blockSites || [],
      })),
    })),
  }));
}

function devicesView() {
  const out = {};
  for (const rec of devices.values()) {
    out[rec.device_id] = {
      device_id: rec.device_id,
      hostname: rec.hostname,
      customName: config.deviceNames[rec.device_id] || "",
      agentName: rec.agentName || "",
      build: rec.build || "",
      os: rec.os,
      locationId: rec.locationId,
      buildingId: rec.buildingId,
      classId: deviceClassId(rec.device_id, rec.buildingId),
      online: rec.online,
      last_seen: rec.last_seen,
      windows: rec.windows,
      activeWindow: rec.activeWindow || "",
      processes: rec.processes,
      blocked: rec.blocked,
      blockedSites: rec.blockedSites || [],
      sitesAvailable: rec.sitesAvailable,
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
    currentBuild: agentBuild(), // agent version the hub would push on "Update"
    clientZip: clientZipInfo(), // freshness of the downloadable install package
    instructorCodeRequired: false, // instructor sign-in is open; buildings use codes
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
function targetsFor(target) {
  const scope = (target && target.scope) || "device";
  const out = [];
  for (const [deviceId, ws] of agentWs) {
    const rec = devices.get(deviceId);
    if (!rec) continue;
    if (scope === "all") out.push(ws);
    else if (scope === "device" && deviceId === target.deviceId) out.push(ws);
    else if (scope === "location" && rec.locationId === target.locationId) out.push(ws);
    else if (scope === "building" && rec.buildingId === target.buildingId) out.push(ws);
    else if (scope === "class" && deviceClassId(deviceId, rec.buildingId) === target.classId)
      out.push(ws);
  }
  return out;
}

// Mirror a device's live block/pause state to disk so it also survives the HUB
// restarting, not just the laptop. Debounced: instructor actions are bursty
// (a preset fires several commands at once) and this is a whole-config write.
let stateSaveTimer = null;
function persistDeviceState(deviceId) {
  const rec = devices.get(deviceId);
  if (!rec) return;
  config.deviceState = config.deviceState || {};
  config.deviceState[deviceId] = { blocks: rec.blocks || { apps: {}, sites: {} }, paused: rec.paused || null };
  if (stateSaveTimer) return;
  stateSaveTimer = setTimeout(() => {
    stateSaveTimer = null;
    saveConfig();
  }, 1000);
}

// Device ids matching a target, whether or not the laptop is connected right
// now (targetsFor only yields live sockets).
function deviceIdsFor(target) {
  const scope = (target && target.scope) || "device";
  const out = [];
  for (const [deviceId, rec] of devices) {
    if (!rec) continue;
    if (scope === "all") out.push(deviceId);
    else if (scope === "device" && deviceId === target.deviceId) out.push(deviceId);
    else if (scope === "location" && rec.locationId === target.locationId) out.push(deviceId);
    else if (scope === "building" && rec.buildingId === target.buildingId) out.push(deviceId);
    else if (scope === "class" && deviceClassId(deviceId, rec.buildingId) === target.classId) out.push(deviceId);
  }
  return out;
}

// `track: false` for commands whose state already lives in config (the
// persistent always-block rules), so they aren't recorded twice.
function sendCommand(target, action, params, opts) {
  const command = { type: "command", action, params: params || {} };
  // Record intent against every addressed device (including ones that are
  // currently offline) so a reboot can't shed what's in force, and a Resume or
  // unblock sent while a laptop is down still takes effect when it returns.
  if (action === "pause" || action === "resume") notePauseState(target, action, params);
  if (!opts || opts.track !== false) {
    if (action === "block_app" || action === "unblock_app" || action === "block_site" || action === "unblock_site" || action === "unblock_all")
      noteBlockState(target, action, params);
  }
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
    case "moveBuilding": {
      const f = findBuilding(op.id);
      if (f) reorder(f.location.buildings, op.id, op.dir);
      break;
    }
    case "moveClass": {
      const f = findClass(op.id);
      if (f) reorder(f.building.classes, op.id, op.dir);
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
        // one or more targets: class / building / location / all
        targets: Array.isArray(op.targets) && op.targets.length ? op.targets : [op.target || { scope: "all" }],
        commands: Array.isArray(op.commands) ? op.commands : [],
        // editing metadata: which event type + its inputs (so an event can be
        // re-opened and edited without reverse-engineering the commands).
        typeId: op.typeId || "",
        msgText: op.msgText || "",
        msgSec: op.msgSec || 0,
        pauseMin: op.pauseMin || 0,
        enabled: op.enabled !== false,
        lastFired: null,
      });
      break;
    case "updateSchedule": {
      const s = config.schedules.find((x) => x.id === op.id);
      if (s)
        for (const k of ["name", "time", "days", "targets", "commands", "enabled", "typeId", "msgText", "msgSec", "pauseMin"])
          if (k in op) s[k] = op[k];
      break;
    }
    case "deleteSchedule":
      config.schedules = config.schedules.filter((x) => x.id !== op.id);
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

// Move an item within an array up (dir<0) or down (dir>0) by one.
function reorder(arr, id, dir) {
  const i = arr.findIndex((x) => x.id === id);
  const j = i + (dir < 0 ? -1 : 1);
  if (i < 0 || j < 0 || j >= arr.length) return;
  const [item] = arr.splice(i, 1);
  arr.splice(j, 0, item);
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
      broadcastState();
      return;
    }
    if (msg.type === "status") {
      updateDevice(ws, msg);
      broadcastState();
    } else if (msg.type === "exec_result") {
      // result of an admin's run_command — relay to admin dashboards only
      const deviceId = wsDevice.get(ws);
      const rec = deviceId && devices.get(deviceId);
      const out = {
        type: "exec_result",
        device_id: deviceId,
        name: (rec && (config.deviceNames[deviceId] || rec.hostname)) || deviceId,
        request_id: msg.request_id || "",
        ok: !!msg.ok,
        code: msg.code,
        stdout: String(msg.stdout || "").slice(0, 8000),
        stderr: String(msg.stderr || "").slice(0, 4000),
      };
      let fwd = 0;
      for (const dws of [...dashboards]) if (!dws.closed && dws.role === "admin") { dws.sendJSON(out); fwd++; }
      console.log(`[hub] exec_result from ${deviceId} -> forwarded to ${fwd} admin dashboard(s)`);
    } else if (msg.type === "update_result") {
      // outcome of a remote software update — relay to admin dashboards
      const deviceId = wsDevice.get(ws);
      const rec = deviceId && devices.get(deviceId);
      const out = {
        type: "update_result",
        device_id: deviceId,
        name: (rec && (config.deviceNames[deviceId] || rec.agentName || rec.hostname)) || deviceId,
        ok: !!msg.ok,
        wrote: Array.isArray(msg.wrote) ? msg.wrote : [],
        error: String(msg.error || "").slice(0, 400),
      };
      for (const dws of [...dashboards]) if (!dws.closed && dws.role === "admin") dws.sendJSON(out);
      console.log(`[hub] update_result from ${deviceId}: ${msg.ok ? "ok (" + (out.wrote.join(", ") || "-") + ")" : "FAILED: " + out.error}`);
    } else if (msg.type === "screenshot_frame") {
      // a live screen frame — relay only to the dashboard(s) currently viewing
      // this device's panel (on-demand; no broadcast, no storage).
      const deviceId = wsDevice.get(ws);
      const viewers = deviceId && screenshotViewers.get(deviceId);
      if (viewers && viewers.size) {
        const frame = { type: "screenshot_frame", device_id: deviceId, data: String(msg.data || "") };
        for (const dws of [...viewers]) {
          if (dws.closed) viewers.delete(dws);
          else dws.sendJSON(frame);
        }
      }
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
      // run_command is arbitrary remote code — restrict it to admins (the agent
      // additionally requires IDT_ALLOW_EXEC=1 to honor it at all).
      if (msg.action === "run_command" && ws.role !== "admin") {
        ws.sendJSON({ type: "error", detail: "admin required to run commands" });
        return;
      }
      // On-demand live screen view: track which dashboard is viewing which device
      // so we can relay frames to it and only stop the agent's capture when the
      // last viewer leaves (never leave a laptop capturing with nobody watching).
      const target = msg.target || {};
      if (msg.action === "start_screenshot" && target.scope === "device" && target.deviceId) {
        let set = screenshotViewers.get(target.deviceId);
        if (!set) screenshotViewers.set(target.deviceId, (set = new Set()));
        set.add(ws);
        ws.sendJSON({ type: "ack", action: msg.action, sent: sendCommand(target, msg.action, msg.params) });
        return;
      }
      if (msg.action === "stop_screenshot" && target.scope === "device" && target.deviceId) {
        const set = screenshotViewers.get(target.deviceId);
        if (set) {
          set.delete(ws);
          if (!set.size) {
            screenshotViewers.delete(target.deviceId);
            sendCommand(target, "stop_screenshot", {}); // last viewer gone → stop capture
          }
        }
        ws.sendJSON({ type: "ack", action: msg.action, sent: 1 });
        return;
      }
      const sent = sendCommand(target, msg.action, msg.params);
      // "Unblock all" (and other unblocks) at class/device scope must NOT wipe out
      // building-wide (or class) always-block policy — re-apply it right after so
      // building rules stay in effect. (WS is FIFO: unblock is processed first.)
      if ((msg.action === "unblock_all" || msg.action === "unblock_app" || msg.action === "unblock_site") && (target.scope === "class" || target.scope === "device")) {
        reapplyPersistentForTarget(target);
      }
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
    } else if (msg.type === "classrule") {
      // per-class persistent app/site blocks — instructors manage their own class
      applyRule(msg);
      broadcastState();
    } else if (msg.type === "buildingrule") {
      // building-wide persistent app/site blocks
      applyRule(msg);
      broadcastState();
    } else if (msg.type === "rename") {
      // rename a computer to the student's name — any authenticated instructor
      applyRename(msg.deviceId, msg.name);
      broadcastState();
    } else if (msg.type === "removeDevice") {
      // decommission a laptop: tell it to stop iD Tech Watch, then forget it.
      if (ws.role !== "admin") {
        ws.sendJSON({ type: "error", detail: "admin required" });
        return;
      }
      removeDeviceById(msg.deviceId);
      broadcastState();
    } else if (msg.type === "updateAgent") {
      // push the hub's current agent/watch source to laptop(s) and restart them
      // on the new code (no per-laptop reinstall). Admin only; the dashboard never
      // supplies the code — the hub is the source of truth for the latest version.
      if (ws.role !== "admin") {
        ws.sendJSON({ type: "error", detail: "admin required" });
        return;
      }
      let agentSrc = "", watchSrc = "";
      try {
        agentSrc = fs.readFileSync(AGENT_SRC, "utf8");
        watchSrc = fs.readFileSync(WATCH_SRC, "utf8");
      } catch (e) {
        ws.sendJSON({ type: "error", detail: "hub could not read agent source: " + e.message });
        return;
      }
      const buildMatch = /const BUILD = "([^"]*)"/.exec(agentSrc);
      const sent = sendCommand(msg.target || {}, "update_agent", {
        files: { "agent.js": agentSrc, "id-tech-watch.js": watchSrc },
        build: buildMatch ? buildMatch[1] : "",
      });
      ws.sendJSON({ type: "ack", action: "update_agent", sent });
      console.log(`[hub] pushed agent update to ${sent} computer(s)`);
    }
  };
  ws.onclose = () => {
    dashboards.delete(ws);
    // if this dashboard was watching any live screens, drop it and stop the
    // agent's capture wherever it was the last viewer.
    for (const [deviceId, set] of screenshotViewers) {
      if (set.delete(ws) && !set.size) {
        screenshotViewers.delete(deviceId);
        sendCommand({ scope: "device", deviceId }, "stop_screenshot", {});
      }
    }
  };
}

// ==========================================================================
// HTTP server
// ==========================================================================
const STATIC_ROUTES = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/fuzzysort.js": { file: "fuzzysort.js", type: "text/javascript; charset=utf-8" },
  "/hanken.woff2": { file: "hanken.woff2", type: "font/woff2" },
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
 try {
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
      instructorCodeRequired: false, // instructor sign-in is open; buildings use codes
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
    // Instructors sign in with no password — access is gated per building by
    // that building's 4-digit code instead.
    return sendJson(res, 200, { token: issueToken("instructor"), role });
  }

  // Download the packaged agent (built separately via scripts/build-agent-exe.ps1)
  // The client ships as a zip that runs on the signed node.exe (no AV false
  // positive). Built via scripts/build-client.ps1.
  if (urlPath === "/download/id-tech-watch.zip") {
    const zip = path.join(DIST_DIR, "iD-Tech-Watch.zip");
    return fs.readFile(zip, (err, data) => {
      if (err) {
        res.writeHead(404, { "content-type": "text/plain" });
        return res.end(
          "iD-Tech-Watch.zip has not been built yet. On the hub machine run:\n  powershell -File scripts/build-client.ps1\nthen this download will work."
        );
      }
      res.writeHead(200, {
        "content-type": "application/zip",
        "content-disposition": 'attachment; filename="iD-Tech-Watch.zip"',
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
 } catch (err) {
  // a bad request must never take the hub down
  console.error("[hub] request error:", err.message);
  try {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("Server error");
  } catch (_) {}
 }
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

// Fire scheduled events (daily timed closures/pauses/etc). Checks every 5s so a
// target minute is never missed; the per-minute lastFired stamp prevents
// double-firing within that minute. A timed PAUSE with a duration auto-resumes:
// the agent ends its own overlay locally, and the hub also sends a resume after
// the duration so the whole class lifts together (and any agent that reconnected
// mid-pause is released too).
function pad2(n) {
  return String(n).padStart(2, "0");
}
function fireScheduleCommands(s, targets) {
  for (const t of targets) {
    for (const c of s.commands || []) {
      sendCommand(t, c.action, c.params);
      const dur = c.action === "pause" && c.params ? Math.round(Number(c.params.duration_sec) || 0) : 0;
      if (dur > 0) {
        const target = t;
        setTimeout(() => {
          const n = sendCommand(target, "resume", {});
          console.log(`[hub] timed pause "${s.name}" auto-resumed after ${dur}s -> ${n} computer(s)`);
        }, dur * 1000);
      }
    }
  }
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
    const targets = s.targets && s.targets.length ? s.targets : [s.target || { scope: "all" }];
    fireScheduleCommands(s, targets);
    console.log(`[hub] fired scheduled event "${s.name}" -> ${targets.length} target(s) (${(s.commands || []).map((c) => c.action).join(", ")})`);
  }
  if (changed) {
    saveConfig();
    broadcastState();
  }
}

loadConfig();
setInterval(checkSchedules, 5000);
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
