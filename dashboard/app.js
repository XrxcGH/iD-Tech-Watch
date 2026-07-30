/* iD Tech Classroom Monitor — single-page app (vanilla JS, zero deps).
 *
 * Views:
 *   login    — instructor / admin sign-in
 *   monitor  — instructor drill-down: Location > Building > Class > computers
 *   admin    — manage locations / buildings / classes / assignments / settings
 */

(() => {
  "use strict";

  // --------------------------------------------------------------- tiny DOM
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === "class") node.className = v;
        else if (k === "html") node.innerHTML = v;
        else if (k === "value") node.value = v;
        else if (k.startsWith("on") && typeof v === "function")
          node.addEventListener(k.slice(2), v);
        else if (v === true) node.setAttribute(k, "");
        else node.setAttribute(k, v);
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function toast(text) {
    const box = el("div", { class: "toast" }, text);
    document.getElementById("toasts").append(box);
    setTimeout(() => box.classList.add("show"), 10);
    setTimeout(() => {
      box.classList.remove("show");
      setTimeout(() => box.remove(), 300);
    }, 2600);
  }

  // ------------------------------------------------------------- modal dialogs
  // Real in-app dialogs replace the browser's prompt()/confirm() (which look
  // out of place, can't be styled/themed, and block the page). Lives in its own
  // #modal layer so it never collides with the seat control sheet (#overlay).
  function ensureModalLayer() {
    let m = document.getElementById("modal");
    if (!m) {
      m = el("div", { id: "modal" });
      document.body.append(m);
    }
    return m;
  }
  function openModal({ title, body, actions, onClose, width }) {
    const layer = ensureModalLayer();
    layer.innerHTML = "";
    const card = el("div", { class: "modal-card" });
    if (width) card.style.maxWidth = width;
    card.addEventListener("click", (e) => e.stopPropagation());
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      layer.classList.remove("open");
      layer.innerHTML = "";
      document.removeEventListener("keydown", onKey);
      if (onClose) onClose();
    }
    function onKey(e) {
      if (e.key === "Escape") close();
    }
    card.append(
      el(
        "div",
        { class: "modal-head" },
        el("h3", {}, title || ""),
        el("button", { class: "modal-x", title: "Close", onclick: close }, "✕")
      ),
      el("div", { class: "modal-body" }, body),
      actions && actions.length ? el("div", { class: "modal-foot" }, ...actions) : null
    );
    document.addEventListener("keydown", onKey);
    layer.append(el("div", { class: "modal-backdrop", onclick: close }), card);
    layer.classList.add("open");
    return { close, card };
  }

  // Promise-based confirm dialog. Resolves true/false.
  function modalConfirm(message, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        m.close();
        resolve(v);
      };
      const ok = el("button", { class: "btn " + (opts.danger ? "danger" : "primary"), onclick: () => finish(true) }, opts.okText || "OK");
      const cancel = el("button", { class: "btn ghost", onclick: () => finish(false) }, opts.cancelText || "Cancel");
      const m = openModal({
        title: opts.title || "Please confirm",
        body: el("p", { class: "modal-msg" }, message),
        actions: [cancel, ok],
        onClose: () => finish(false),
        width: "440px",
      });
      setTimeout(() => ok.focus(), 30);
    });
  }

  // Promise-based single-field prompt. Resolves the string, or null if cancelled.
  function modalPrompt(opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        m.close();
        resolve(v);
      };
      const input = opts.multiline
        ? el("textarea", { class: "modal-input", rows: String(opts.rows || 3), placeholder: opts.placeholder || "" })
        : el("input", { class: "modal-input", type: opts.inputType || "text", placeholder: opts.placeholder || "" });
      input.value = opts.value || "";
      const ok = el("button", { class: "btn " + (opts.danger ? "danger" : "primary"), onclick: () => finish(input.value) }, opts.okText || "Save");
      const cancel = el("button", { class: "btn ghost", onclick: () => finish(null) }, "Cancel");
      const m = openModal({
        title: opts.title || "",
        body: el(
          "div",
          {},
          opts.label ? el("label", { class: "modal-label" }, opts.label) : null,
          input,
          opts.hint ? el("div", { class: "modal-hint" }, opts.hint) : null
        ),
        actions: [cancel, ok],
        onClose: () => finish(null),
        width: opts.width || "460px",
      });
      if (!opts.multiline)
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            finish(input.value);
          }
        });
      setTimeout(() => {
        input.focus();
        if (input.select) input.select();
      }, 30);
    });
  }

  // Show the output returned by a run_command, in a monospace modal.
  function showExecResult(msg) {
    const body = el("div", { class: "exec-result" });
    body.append(el("div", { class: "modal-hint" }, `${msg.name || msg.device_id} · exit ${msg.code}${msg.ok ? "" : " (error)"}`));
    if (msg.stdout && msg.stdout.trim()) body.append(el("div", { class: "modal-label" }, "Output"), el("pre", { class: "exec-out" }, msg.stdout));
    if (msg.stderr && msg.stderr.trim()) body.append(el("div", { class: "modal-label" }, "Errors"), el("pre", { class: "exec-out err" }, msg.stderr));
    if ((!msg.stdout || !msg.stdout.trim()) && (!msg.stderr || !msg.stderr.trim())) body.append(el("p", { class: "modal-msg" }, "(no output)"));
    const m = openModal({ title: "Command result", body, actions: [el("button", { class: "btn primary", onclick: () => m.close() }, "Close")], width: "640px" });
  }

  // ------------------------------------------------------------------ state
  const D = { org: [], devices: {}, layouts: {}, schedules: [], instructorCodeRequired: false };
  const nav = { view: "login", locationId: null, buildingId: null, classId: null };
  const ui = { blockDurationSec: 60, blockMode: "minimize", loginRole: "instructor", connected: false, monitorMode: "grid", buildingMode: "list", dragging: null, seatLocked: true, unlocked: {}, expandedProcs: new Set(), classSort: "room", scroll: {}, lastScrollAt: 0, theme: localStorage.getItem("idt_theme") || "dark" };

  function applyTheme() {
    document.documentElement.dataset.theme = ui.theme;
  }
  function toggleTheme() {
    ui.theme = ui.theme === "dark" ? "light" : "dark";
    localStorage.setItem("idt_theme", ui.theme);
    applyTheme();
    render();
  }
  function themeToggle() {
    return el(
      "button",
      { class: "theme-toggle", title: ui.theme === "dark" ? "Switch to light" : "Switch to dark", onclick: toggleTheme },
      ui.theme === "dark" ? "☀" : "☾"
    );
  }
  // /demo runs a self-contained simulated classroom (no hub, no login).
  const DEMO = location.pathname.replace(/\/+$/, "").toLowerCase() === "/demo";
  const INITIAL_PATH = location.pathname; // captured before any URL sync
  let deepLinkDone = false;
  let autoGatedBuilding = null; // one-shot guard for deep-link building gate
  let auth = JSON.parse(localStorage.getItem("idt_auth") || "null"); // {token, role}
  let ws = null;
  let lastAdminSig = "";
  let lastMonitorSig = ""; // gates monitor re-renders to real content changes
  let liveView = null; // { deviceId, img, wrap } — on-demand screen view in the open panel
  let lastPaintSig = "";
  let paintAnimate = false; // only animate on a real navigation, not live re-renders

  const UNASSIGNED = "__unassigned__";

  // Quick-block catalog: each preset blocks matching app process names and/or
  // websites (via the hosts file on the agent). App matches are case-insensitive
  // substrings. "minecraft" catches the launcher + Bedrock; Java edition runs as
  // javaw.exe (block "javaw" manually only if your camp doesn't use Java).
  const BLOCK_PRESETS = [
    // Block the Roblox *player* but never Roblox *Studio* — Studio is the coding
    // tool used in class. The agent matches "roblox" and excludes "studio", so
    // RobloxPlayerBeta dies while RobloxStudioBeta keeps running.
    { id: "roblox", label: "Roblox (Player)", apps: ["roblox"], exclude: ["studio"], sites: ["roblox.com"] },
    { id: "minecraft", label: "Minecraft", apps: ["minecraft"], sites: ["minecraft.net", "classic.minecraft.net"] },
    { id: "fortnite", label: "Fortnite", apps: ["fortnite"], sites: [] },
    { id: "steam", label: "Steam", apps: ["steam"], sites: ["steampowered.com", "steamcommunity.com"] },
    { id: "epic", label: "Epic Games", apps: ["epicgames", "fortnite"], sites: ["epicgames.com"] },
    {
      id: "gamesites",
      label: "Gaming websites (Poki, Coolmath…)",
      apps: [],
      sites: ["poki.com", "coolmathgames.com", "crazygames.com", "miniclip.com", "y8.com", "addictinggames.com", "kongregate.com", "armorgames.com", "friv.com", "gamejolt.com"],
      closeTabs: true, // close browsers so the block hits already-open tabs
    },
  ];

  function setAuth(a) {
    auth = a;
    if (a) localStorage.setItem("idt_auth", JSON.stringify(a));
    else localStorage.removeItem("idt_auth");
  }

  // ------------------------------------------------------------- data lookups
  const locationById = (id) => D.org.find((l) => l.id === id);
  function buildingById(id) {
    for (const l of D.org) {
      const b = l.buildings.find((b) => b.id === id);
      if (b) return { loc: l, b };
    }
    return null;
  }
  function classById(id) {
    for (const l of D.org)
      for (const b of l.buildings) {
        const c = b.classes.find((c) => c.id === id);
        if (c) return { loc: l, b, c };
      }
    return null;
  }
  const deviceList = () => Object.values(D.devices);
  const devicesInLocation = (id) => deviceList().filter((d) => d.locationId === id);
  const devicesInBuilding = (id) => deviceList().filter((d) => d.buildingId === id);
  const devicesInClass = (id) => deviceList().filter((d) => d.classId === id);
  const unassignedInBuilding = (id) =>
    deviceList().filter((d) => d.buildingId === id && !d.classId);
  const onlineCount = (list) => list.filter((d) => d.online).length;

  // ------------------------------------------------------------------ network
  async function apiPublic() {
    try {
      const r = await fetch("/api/public");
      const j = await r.json();
      D.instructorCodeRequired = !!j.instructorCodeRequired;
    } catch (_) {
      /* ignore */
    }
  }

  async function login(role, password, code) {
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role, password, code }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Sign-in failed.");
    setAuth({ token: j.token, role: j.role });
    nav.view = j.role === "admin" ? "admin" : "monitor";
    connect();
    syncUrl();
    render();
  }

  function connect() {
    if (!auth) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws/dashboard`);
    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: auth.token }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "auth_ok") {
        auth.role = msg.role;
        setAuth(auth);
        ui.connected = true;
        if (nav.view === "login") nav.view = auth.role === "admin" ? "admin" : "monitor";
        render();
      } else if (msg.type === "auth_error") {
        setAuth(null);
        nav.view = "login";
        render();
      } else if (msg.type === "state") {
        D.org = msg.org;
        D.devices = msg.devices;
        D.layouts = msg.layouts || {};
        D.schedules = msg.schedules || [];
        D.currentBuild = msg.currentBuild || "";
        D.clientZip = msg.clientZip || null;
        D.instructorCodeRequired = msg.instructorCodeRequired;
        if (!deepLinkDone) {
          deepLinkDone = true;
          applyDeepLink();
        }
        onState();
      } else if (msg.type === "ack") {
        // block-menu acks are noisy; skip the toast for the screenshot handshake
        if (msg.action !== "start_screenshot" && msg.action !== "stop_screenshot") toast(`Command sent to ${msg.sent} computer(s).`);
      } else if (msg.type === "screenshot_frame") {
        if (liveView && msg.device_id === liveView.deviceId && liveView.img) {
          liveView.img.src = "data:image/jpeg;base64," + msg.data;
          liveView.wrap.classList.add("streaming");
        }
      } else if (msg.type === "exec_result") {
        showExecResult(msg);
      } else if (msg.type === "update_result") {
        toast(msg.ok ? `${msg.name}: updated (${(msg.wrote || []).join(", ") || "no files"}) — restarting.` : `${msg.name}: update failed — ${msg.error}`);
      } else if (msg.type === "error") {
        toast(msg.detail || "Error");
      }
    };
    ws.onclose = () => {
      ui.connected = false;
      updateConn();
      if (auth) setTimeout(connect, 2000);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch (_) {}
    };
  }

  function send(obj) {
    if (DEMO) return demoHandle(obj);
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }
  const command = (target, action, params) =>
    send({ type: "command", target, action, params: params || {} });
  const org = (op) => send(Object.assign({ type: "org" }, op));
  const classrule = (op) => send(Object.assign({ type: "classrule" }, op));
  const buildingrule = (op) => send(Object.assign({ type: "buildingrule" }, op));
  const rename = (deviceId, name) => send({ type: "rename", deviceId, name });
  const removeDevice = (deviceId) => send({ type: "removeDevice", deviceId });
  const updateAgent = (target) => send({ type: "updateAgent", target });
  // display name priority: dashboard rename (customName) → the name entered at
  // setup (agentName) → the machine hostname.
  const nameOf = (d) =>
    d.customName && d.customName.trim()
      ? d.customName
      : d.agentName && d.agentName.trim()
        ? d.agentName
        : d.hostname;
  // what a blank rename falls back to (shown as the rename field's placeholder)
  const defaultNameOf = (d) => (d.agentName && d.agentName.trim() ? d.agentName : d.hostname);
  async function promptRename(d) {
    const n = await modalPrompt({
      title: "Rename computer",
      label: "Show this computer as…",
      value: d.customName || "",
      placeholder: d.hostname,
      hint: `The student's name. Leave blank to reset to “${d.hostname}”.`,
      okText: "Rename",
    });
    if (n !== null) rename(d.device_id, n.trim());
  }

  // Combobox for adding a class's always-blocked app: fuzzysort autocomplete over
  // the apps currently open across the class, but any typed name can be added too.
  // Tab (or Enter) fills the top suggestion and submits; no match = add as typed.
  function appComboBox(openApps, placeholder, onPick) {
    const input = el("input", { class: "combo-input", type: "text", placeholder, autocomplete: "off" });
    const menu = el("div", { class: "combo-menu" });
    let items = [];
    let hi = -1;
    function renderMenu() {
      menu.innerHTML = "";
      items.forEach((s, i) => menu.append(el("div", { class: "combo-opt" + (i === hi ? " active" : ""), onmousedown: (e) => { e.preventDefault(); choose(s); } }, s)));
      menu.style.display = items.length ? "block" : "none";
    }
    function refresh() {
      const q = input.value.trim();
      if (!q) items = openApps.slice(0, 8);
      else if (typeof fuzzysort !== "undefined") items = fuzzysort.go(q, openApps, { limit: 8 }).map((r) => r.target);
      else items = openApps.filter((a) => a.toLowerCase().includes(q.toLowerCase())).slice(0, 8);
      hi = items.length ? 0 : -1;
      renderMenu();
    }
    function choose(val) {
      const v = String(val != null ? val : input.value).trim();
      if (v) onPick(v);
      input.value = "";
      items = [];
      renderMenu();
    }
    input.addEventListener("input", refresh);
    input.addEventListener("focus", refresh);
    input.addEventListener("blur", () => setTimeout(() => (menu.style.display = "none"), 150));
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); hi = Math.min(items.length - 1, hi + 1); renderMenu(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); hi = Math.max(0, hi - 1); renderMenu(); }
      else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); choose(hi >= 0 && items[hi] ? items[hi] : input.value); }
    });
    return el("div", { class: "combo" }, input, menu);
  }

  // ---- blocking helpers (dispatch(action, params) sends to the right target) ----
  // Global "Block for" duration control (used in the top bar so it's always
  // visible and applies to every block — class, device, seating, or the menu).
  // Human label for a duration in seconds.
  function fmtDur(sec) {
    if (!sec) return "Until lifted";
    if (sec < 60) return `${sec} sec`;
    if (sec % 3600 === 0) return `${sec / 3600} hour${sec / 3600 > 1 ? "s" : ""}`;
    if (sec % 60 === 0) return `${sec / 60} min`;
    return `${Math.floor(sec / 60)} min ${sec % 60} sec`;
  }
  // Custom-duration modal: a number + a unit (seconds / minutes / hours).
  function promptCustomDuration() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
      const num = el("input", { class: "modal-input", type: "number", min: "0", step: "1", value: "5" });
      const unit = el(
        "select",
        { class: "modal-input" },
        el("option", { value: "1" }, "seconds"),
        el("option", { value: "60", selected: true }, "minutes"),
        el("option", { value: "3600" }, "hours")
      );
      const ok = el("button", { class: "btn primary", onclick: () => {
        const n = parseFloat(num.value);
        finish(!Number.isNaN(n) && n >= 0 ? Math.round(n * parseInt(unit.value, 10)) : null);
      } }, "Set");
      const cancel = el("button", { class: "btn ghost", onclick: () => finish(null) }, "Cancel");
      const m = openModal({
        title: "Custom block duration",
        body: el("div", {}, el("label", { class: "modal-label" }, "Block for"), el("div", { class: "dur-custom-row" }, num, unit), el("div", { class: "modal-hint" }, "Enter 0 to block until you lift it.")),
        actions: [cancel, ok],
        onClose: () => finish(null),
        width: "420px",
      });
      num.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); ok.click(); } });
      setTimeout(() => { num.focus(); num.select && num.select(); }, 30);
    });
  }
  function durationControl() {
    const DUR_OPTS = [
      [30, "30 sec"], [60, "1 min"], [120, "2 min"], [300, "5 min"], [600, "10 min"],
      [900, "15 min"], [1800, "30 min"], [3600, "1 hour"], [0, "Until lifted"],
    ];
    const inSet = DUR_OPTS.some(([v]) => v === ui.blockDurationSec);
    return el(
      "label",
      { class: "dur" },
      "Block for ",
      el(
        "select",
        {
          class: "dur-select",
          onchange: (e) => {
            if (e.target.value === "custom") {
              promptCustomDuration().then((sec) => {
                if (sec !== null) ui.blockDurationSec = sec;
                render();
              });
              return;
            }
            ui.blockDurationSec = parseInt(e.target.value, 10);
            render();
          },
        },
        ...DUR_OPTS.map(([v, t]) => el("option", { value: v, selected: v === ui.blockDurationSec }, t)),
        !inSet ? el("option", { value: ui.blockDurationSec, selected: true }, fmtDur(ui.blockDurationSec)) : null,
        el("option", { value: "custom" }, "Custom…")
      )
    );
  }

  // How an app block is enforced on the laptop. "minimize" keeps shoving the
  // game's window down (the default); "kill" force-closes it, which is what got
  // student Roblox accounts flagged for cheating/macros — so it is opt-in.
  function blockModeControl() {
    return el(
      "label",
      { class: "dur" },
      "Method ",
      el(
        "select",
        {
          title: "Minimize keeps pushing the game's window down and is safe for game accounts. Force close terminates it, which some games' anti-cheat treats as tampering.",
          onchange: (e) => {
            ui.blockMode = e.target.value;
            toast(ui.blockMode === "kill" ? "Blocks will FORCE CLOSE apps (may flag game accounts)." : "Blocks will minimize apps (safe for game accounts).");
          },
        },
        el("option", { value: "minimize", selected: ui.blockMode !== "kill" }, "Minimize"),
        el("option", { value: "kill", selected: ui.blockMode === "kill" }, "Force close")
      )
    );
  }

  const robloxPreset = () => BLOCK_PRESETS.find((p) => p.id === "roblox");
  function blockPreset(dispatch, preset) {
    const dur = ui.blockDurationSec;
    if (preset.apps && preset.apps.length) dispatch("block_app", { patterns: preset.apps, exclude: preset.exclude || [], duration_sec: dur, mode: ui.blockMode });
    if (preset.sites && preset.sites.length) dispatch("block_site", { domains: preset.sites, duration_sec: dur });
    if (preset.closeTabs) dispatch("close_tab", {}); // close the open tab so the block bites now
    toast(`Blocking ${preset.label}${preset.closeTabs ? " (+ closing the open tab)" : ""}.`);
  }
  function blockAllGames(dispatch) {
    const apps = [...new Set(BLOCK_PRESETS.flatMap((p) => p.apps))];
    const sites = [...new Set(BLOCK_PRESETS.flatMap((p) => p.sites))];
    const exclude = [...new Set(BLOCK_PRESETS.flatMap((p) => p.exclude || []))];
    dispatch("block_app", { patterns: apps, exclude, duration_sec: ui.blockDurationSec, mode: ui.blockMode });
    dispatch("block_site", { domains: sites, duration_sec: ui.blockDurationSec });
    dispatch("close_tab", {});
    toast("Blocking all games + gaming sites.");
  }
  // A compact custom "Block…" dropdown (usable at class or device scope). Built
  // by hand rather than a native <select> so it matches the app's theme and can
  // show section headers, icons, and a danger accent — none of which a native
  // <option> list can style consistently.
  function blockSelect(dispatch) {
    const wrap = el("div", { class: "blockmenu" });
    const pop = el("div", { class: "blockmenu-pop" });
    const trigger = el(
      "button",
      { class: "block-select", type: "button", "aria-haspopup": "true" },
      el("span", {}, "🚫 Block…"),
      el("span", { class: "caret" }, "▾")
    );

    function close() {
      pop.classList.remove("open", "up");
      wrap.classList.remove("open");
      document.removeEventListener("mousedown", onDoc, true);
      document.removeEventListener("keydown", onKey, true);
    }
    function open() {
      // close any other open block menu first
      document.querySelectorAll(".blockmenu.open .blockmenu-pop").forEach((p) => p.classList.remove("open", "up"));
      document.querySelectorAll(".blockmenu.open").forEach((w) => w.classList.remove("open"));
      pop.classList.add("open");
      wrap.classList.add("open");
      // fit within the viewport: flip above the trigger when there's more room
      // there, and cap the height so the menu scrolls instead of running off-screen.
      const r = trigger.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - 12;
      const above = r.top - 12;
      if (below < 280 && above > below) {
        pop.classList.add("up");
        pop.style.maxHeight = above + "px";
      } else {
        pop.classList.remove("up");
        pop.style.maxHeight = Math.max(160, below) + "px";
      }
      document.addEventListener("mousedown", onDoc, true);
      document.addEventListener("keydown", onKey, true);
    }
    function onDoc(e) {
      if (!wrap.contains(e.target)) close();
    }
    function onKey(e) {
      if (e.key === "Escape") close();
    }
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      pop.classList.contains("open") ? close() : open();
    });

    const runItem = (fn) => {
      close();
      fn();
    };
    const item = (label, fn, opts) =>
      el("button", { class: "blockmenu-item" + (opts && opts.danger ? " danger" : ""), type: "button", onclick: () => runItem(fn) }, label);
    const groupEl = (label, items) => el("div", { class: "blockmenu-group" }, el("div", { class: "blockmenu-label" }, label), ...items);

    const customApp = () =>
      modalPrompt({ title: "Block an app", label: "Block which app?", placeholder: "name or part of it, e.g. steam", okText: "Block" }).then((n) => {
        if (n && n.trim()) dispatch("block_app", { pattern: n.trim(), duration_sec: ui.blockDurationSec, mode: ui.blockMode });
      });
    const customSite = () =>
      modalPrompt({ title: "Block a website", label: "Block which website?", placeholder: "e.g. poki.com", okText: "Block" }).then((n) => {
        if (n && n.trim()) {
          dispatch("block_site", { domain: n.trim(), duration_sec: ui.blockDurationSec });
          dispatch("close_tab", {});
          toast(`Blocking ${n.trim()} (+ closing the open tab).`);
        }
      });
    const closeBrowsers = () =>
      modalConfirm("Close ALL browser windows now? This closes every open tab on the target computer(s).", { title: "Close all browsers", danger: true, okText: "Close browsers" }).then((ok) => {
        if (ok) dispatch("close_browsers", {});
      });
    const sendKeysItem = () => openSendKeys(dispatch);
    const runCmdItem = () =>
      modalPrompt({ title: "Run a command", label: "Command to run (cmd.exe) on the target computer(s)", placeholder: "e.g. ipconfig /all", hint: "Admin only. The client must be started with IDT_ALLOW_EXEC=1. Output is returned to you.", okText: "Run", danger: true }).then((cmd) => {
        if (cmd && cmd.trim()) {
          dispatch("run_command", { command: cmd.trim() });
          toast("Command sent — waiting for output…");
        }
      });

    const gameItems = BLOCK_PRESETS.map((p) => item(p.label, () => blockPreset(dispatch, p)));
    gameItems.push(item("All games + sites", () => blockAllGames(dispatch), { danger: true }));

    const doNow = [
      item("Close current tab", () => dispatch("close_tab", {})),
      item("Minimize all windows", () => dispatch("minimize_all", {})),
      item("Close ALL browsers", closeBrowsers, { danger: true }),
      item("Send keyboard shortcut…", sendKeysItem),
    ];
    if (auth && auth.role === "admin" && !DEMO) doNow.push(item("Run command… (admin)", runCmdItem, { danger: true }));

    pop.append(
      groupEl("Games & sites", gameItems),
      groupEl("Custom", [item("Custom app…", customApp), item("Custom website…", customSite)]),
      groupEl("Do now", doNow)
    );
    wrap.append(trigger, pop);
    return wrap;
  }

  function logout() {
    setAuth(null);
    try {
      ws && ws.close();
    } catch (_) {}
    ws = null;
    nav.view = "login";
    nav.locationId = nav.buildingId = nav.classId = null;
    syncUrl();
    render();
  }

  // -------------------------------------------------------- selective rerender
  function adminSig() {
    return JSON.stringify({
      org: D.org,
      devs: deviceList().map((d) => [
        d.device_id,
        d.hostname,
        d.customName,
        d.locationId,
        d.buildingId,
        d.classId,
        d.online ? 1 : 0,
        d.build || "",
      ]),
      sched: D.schedules,
      curBuild: D.currentBuild,
      code: D.instructorCodeRequired,
    });
  }
  // True while the user is mid-interaction with a form control — re-rendering
  // then would rip an open <select> dropdown or a focused field out from under
  // them (this was closing the Block menus during the beta).
  function busyEditing() {
    const a = document.activeElement;
    if (a && ["INPUT", "SELECT", "TEXTAREA", "OPTION"].includes(a.tagName)) return true;
    // an open custom Block menu or a modal shouldn't be torn down by a live re-render
    if (document.querySelector(".blockmenu-pop.open")) return true;
    if (document.getElementById("modal") && document.getElementById("modal").classList.contains("open")) return true;
    return false;
  }
  // true briefly after any scroll, so live re-renders don't fight the user
  function scrolling() {
    return Date.now() - ui.lastScrollAt < 900;
  }
  // make a scrollable list remember + restore its position across re-renders
  function trackScroll(node, key) {
    node.dataset.scrollkey = key;
    node.addEventListener("scroll", () => {
      ui.scroll[key] = node.scrollTop;
      ui.lastScrollAt = Date.now();
    });
    return node;
  }
  function restoreScroll() {
    document.querySelectorAll("[data-scrollkey]").forEach((n) => {
      const y = ui.scroll[n.dataset.scrollkey];
      if (y) n.scrollTop = y;
    });
  }

  // Signature of everything the monitor actually DRAWS — deliberately excluding
  // the two things that change every second (block countdown expiry + a device's
  // last_seen). Those are refreshed in place by refreshLiveLabels() instead of a
  // full rebuild. This is the fix for "the UI flashes with blocks": a status
  // heartbeat or a ticking countdown no longer tears down and rebuilds the grid.
  function monitorSig() {
    return JSON.stringify({
      view: [nav.view, nav.locationId, nav.buildingId, nav.classId, ui.monitorMode],
      org: D.org.map((l) => [l.id, l.name, l.buildings.map((b) => [b.id, b.name, b.code ? 1 : 0, (b.blockApps || []).join(",") + "~" + (b.blockSites || []).join(","), b.classes.map((c) => [c.id, c.name, c.instructor, c.room, (c.blockApps || []).join(","), (c.blockSites || []).join(",")])])]),
      devs: deviceList().map((d) => [
        d.device_id, d.online ? 1 : 0, nameOf(d), d.os, d.locationId, d.buildingId, d.classId,
        (d.windows || []).join("|"),
        d.activeWindow || "",
        (d.processes || []).length,
        (d.blocked || []).map((b) => b.pattern).sort().join(","),
        (d.blockedSites || []).map((b) => b.domain).sort().join(","),
        d.sitesAvailable === false ? 0 : 1,
      ]),
      layouts: D.layouts,
    });
  }

  // Update just the live text (block countdowns + "x ago") without rebuilding.
  function refreshLiveLabels() {
    const now = Date.now() / 1000;
    document.querySelectorAll(".cd[data-exp]").forEach((n) => {
      n.textContent = ` (${Math.max(0, Math.round(Number(n.dataset.exp) - now))}s)`;
    });
    document.querySelectorAll("[data-ago]").forEach((n) => {
      n.textContent = agoLabel(Number(n.dataset.ago));
    });
  }

  function onState() {
    updateConn();
    // don't yank the DOM out from under a seat drag, an open dropdown, or a scroll
    if (nav.view === "monitor") {
      if (ui.dragging || busyEditing() || scrolling()) return;
      const sig = monitorSig();
      if (sig !== lastMonitorSig) render(); // real change → rebuild (sig set in render)
      else refreshLiveLabels(); // nothing structural changed → just tick the labels
    } else if (nav.view === "admin") {
      if (!busyEditing() && !scrolling() && adminSig() !== lastAdminSig) render();
    }
  }

  // ================================================================== views
  function render() {
    // Only run the entry animation when the user actually navigated to a new
    // page — not on the live re-renders that refresh device status (those were
    // re-triggering the animation and making tiles "jump").
    const paintSig = [nav.view, nav.locationId, nav.buildingId, nav.classId, ui.monitorMode].join("|");
    paintAnimate = paintSig !== lastPaintSig;
    lastPaintSig = paintSig;

    const app = document.getElementById("app");
    app.innerHTML = "";
    if (!auth || nav.view === "login") {
      app.append(renderLogin());
      return;
    }
    app.append(renderShell(nav.view === "admin" ? renderAdmin() : renderMonitor()));
    if (nav.view === "admin") lastAdminSig = adminSig();
    if (nav.view === "monitor") lastMonitorSig = monitorSig();
    restoreScroll(); // keep scrollable lists where the user left them
  }

  function brand() {
    return el(
      "div",
      { class: "brand" },
      el("span", { class: "logo" }, "iD"),
      el(
        "div",
        {},
        el("div", { class: "brand-title" }, "iD Tech Watch"),
        el("div", { class: "brand-sub" }, "iD Tech Camps")
      )
    );
  }

  function renderShell(content) {
    const wrap = el("div", { class: "app-shell" });

    const n6 = el("nav", { class: "topbar" }, brand());
    const right = el("div", { class: "top-actions" });

    const monitorBtn = el(
      "button",
      { class: "navlink" + (nav.view === "monitor" ? " active" : ""), onclick: () => go("monitor") },
      "Monitor"
    );
    right.append(monitorBtn);
    if (auth.role === "admin" && !DEMO) {
      right.append(
        el(
          "button",
          { class: "navlink" + (nav.view === "admin" ? " active" : ""), onclick: () => go("admin") },
          "Admin"
        )
      );
    }
    if (DEMO) {
      right.append(
        el("span", { class: "demo-badge" }, "● DEMO"),
        el("button", { class: "navlink", onclick: () => location.assign("/") }, "Exit demo")
      );
    } else {
      right.append(el("button", { class: "navlink", onclick: () => location.assign("/demo") }, "Demo"));
    }
    // global "Block for" duration + how blocks are enforced (applies to every
    // block action), monitor only
    if (nav.view === "monitor") right.append(durationControl(), blockModeControl());
    right.append(
      el("span", { class: "role-badge " + auth.role }, auth.role === "admin" ? "Admin" : "Instructor"),
      connDot(),
      themeToggle(),
      !DEMO ? el("button", { class: "btn ghost sm", onclick: logout }, "Sign out") : null
    );
    n6.append(right);
    // fixed download button (bottom-right), styled like the Monitor button
    const download = el(
      "a",
      { class: "download-fab", href: "/download/id-tech-watch.zip", title: "Download the iD Tech Watch client (zip — unzip and run Start iD Tech Watch.cmd)" },
      "⬇ iD-Tech-Watch.zip"
    );
    wrap.append(n6, el("main", { class: "content" + (paintAnimate ? " enter" : "") }, content), download);
    return wrap;
  }

  function connDot() {
    return el(
      "span",
      { id: "connDot", class: "conn " + (ui.connected ? "online" : "offline") },
      ui.connected ? "Live" : "Reconnecting…"
    );
  }
  function updateConn() {
    const d = document.getElementById("connDot");
    if (d) {
      d.className = "conn " + (ui.connected ? "online" : "offline");
      d.textContent = ui.connected ? "Live" : "Reconnecting…";
    }
  }

  function go(view) {
    nav.view = view;
    syncUrl();
    render();
  }

  // -------------------------------------------------------------------- login
  function renderLogin() {
    const card = el("div", { class: "login-card" });
    const err = el("div", { class: "login-error" });

    const tabs = el(
      "div",
      { class: "login-tabs" },
      tab("instructor", "Instructor"),
      tab("admin", "Admin")
    );
    function tab(role, label) {
      return el(
        "button",
        {
          class: "login-tab" + (ui.loginRole === role ? " active" : ""),
          onclick: () => {
            ui.loginRole = role;
            render();
          },
        },
        label
      );
    }

    const fields = el("div", { class: "login-fields" });
    let passwordInput;
    if (ui.loginRole === "admin") {
      passwordInput = el("input", { type: "password", placeholder: "Admin password", autofocus: true });
      fields.append(labeled("Admin password", passwordInput));
    } else {
      // Instructors need no password — each building has its own 4-digit code.
      fields.append(
        el("p", { class: "login-hint" }, "No password needed — click Continue, then enter your building's 4-digit code.")
      );
    }

    async function submit() {
      err.textContent = "";
      try {
        await login(ui.loginRole, passwordInput ? passwordInput.value : undefined);
      } catch (e) {
        err.textContent = e.message;
      }
    }

    const btn = el("button", { class: "btn primary block", onclick: submit }, "Continue");
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    card.append(tabs, fields, err, btn);

    return el(
      "div",
      { class: "login-page" },
      el(
        "div",
        { class: "login-inner" },
        el("div", { class: "login-brand" }, el("span", { class: "logo big" }, "iD"), el("h1", {}, "iD Tech Watch")),
        el("p", { class: "login-tagline" }, "Manage and monitor class laptops across iD Tech locations."),
        card
      )
    );
  }

  function labeled(label, input) {
    return el("label", { class: "field" }, el("span", {}, label), input);
  }

  // ------------------------------------------------------------------ monitor
  function renderMonitor() {
    resolvePendingNav(); // finish any deep-link (drill in or pop the code gate)
    const c = el("div", { class: "monitor" });
    c.append(renderBreadcrumb());

    if (!nav.locationId) c.append(pickerLocations());
    else if (!nav.buildingId) c.append(pickerBuildings());
    else if (!nav.classId) c.append(pickerClasses());
    else c.append(classMonitor());
    return c;
  }

  function renderBreadcrumb() {
    const parts = [crumb("Locations", () => setDrill(null, null, null))];
    if (nav.locationId) {
      const loc = locationById(nav.locationId);
      parts.push(crumb(loc ? loc.name : "?", () => setDrill(nav.locationId, null, null)));
    }
    if (nav.buildingId) {
      const f = buildingById(nav.buildingId);
      parts.push(crumb(f ? f.b.name : "?", () => setDrill(nav.locationId, nav.buildingId, null)));
    }
    if (nav.classId) {
      const name = nav.classId === UNASSIGNED ? "Unassigned" : (classById(nav.classId) || {}).c?.name || "?";
      parts.push(crumb(name, null));
    }
    const bar = el("div", { class: "breadcrumb" });
    parts.forEach((p, i) => {
      if (i) bar.append(el("span", { class: "sep" }, "›"));
      bar.append(p);
    });
    return bar;
  }
  function crumb(label, onclick) {
    return el("button", { class: "crumb" + (onclick ? "" : " current"), onclick: onclick || (() => {}) }, label);
  }
  function setDrill(loc, bld, cls) {
    nav.locationId = loc;
    nav.buildingId = bld;
    nav.classId = cls;
    syncUrl();
    render();
  }

  // Right-aligned fuzzy search (fuzzysort) over a set of tiles. Instead of
  // hiding non-matches it floats matches to the front and dims the rest (still
  // clickable). Arrow keys / mouse navigate; Enter or Tab picks the top match
  // (Tab also fills the box first). Entries: [{ el, text, pick, name }].
  function makeTileSearch(entries, placeholder) {
    const input = el("input", { class: "nav-search", type: "search", placeholder: placeholder || "Search…", autocomplete: "off" });
    let order = entries.slice();
    let hi = -1;
    const container = () => (entries.length ? entries[0].el.parentElement : null);
    function setHighlight(i) {
      order.forEach((e) => e.el.classList.remove("kbd"));
      hi = i;
      if (hi >= 0 && hi < order.length) {
        order[hi].el.classList.add("kbd");
        order[hi].el.scrollIntoView({ block: "nearest" });
      }
    }
    function apply() {
      const q = input.value.trim();
      const c = container();
      if (!c) return;
      if (!q || typeof fuzzysort === "undefined") {
        order = entries.slice();
        entries.forEach((e) => e.el.classList.remove("dim"));
        order.forEach((e) => c.append(e.el));
        setHighlight(-1);
        return;
      }
      const results = fuzzysort.go(q, entries, { key: "text" });
      const matched = new Set(results.map((r) => r.obj));
      const front = results.map((r) => r.obj);
      const rest = entries.filter((e) => !matched.has(e));
      front.forEach((e) => e.el.classList.remove("dim"));
      rest.forEach((e) => e.el.classList.add("dim"));
      order = [...front, ...rest];
      order.forEach((e) => c.append(e.el));
      setHighlight(front.length ? 0 : -1);
    }
    input.addEventListener("input", apply);
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); setHighlight(Math.min(order.length - 1, hi + 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight(Math.max(0, hi - 1)); }
      else if (e.key === "Enter") { e.preventDefault(); const p = order[hi < 0 ? 0 : hi]; if (p) p.pick(); }
      else if (e.key === "Tab") { const p = order[hi < 0 ? 0 : hi]; if (p) { e.preventDefault(); input.value = p.name; p.pick(); } }
    });
    return input;
  }

  function pickerLocations() {
    const grid = el("div", { class: "tiles" });
    if (!D.org.length) {
      grid.append(emptyNote("No locations yet. Ask an admin to add one, or start an agent."));
      return section("Select a location", grid);
    }
    const entries = [];
    for (const loc of D.org) {
      const devs = devicesInLocation(loc.id);
      const pick = () => setDrill(loc.id, null, null);
      const t = tile(loc.name, "🏫", [`${loc.buildings.length} building(s)`, `${onlineCount(devs)}/${devs.length} online`], pick);
      grid.append(t);
      entries.push({ el: t, text: loc.name, pick, name: loc.name });
    }
    return section("Select a location", grid, makeTileSearch(entries, "Search locations…"));
  }

  function pickerBuildings() {
    const loc = locationById(nav.locationId);
    const grid = el("div", { class: "tiles" });
    if (!loc || !loc.buildings.length) {
      grid.append(emptyNote("No buildings in this location yet."));
      return section("Select a building", grid);
    }
    const entries = [];
    for (const b of loc.buildings) {
      const devs = devicesInBuilding(b.id);
      const locked = !DEMO && b.code && !ui.unlocked[b.id];
      const pick = () => (locked ? openBuildingGate(loc, b) : setDrill(nav.locationId, b.id, null));
      const t = tile(
        b.name,
        locked ? "🔒" : "🏢",
        [`${b.classes.length} class(es)`, `${onlineCount(devs)}/${devs.length} online`, locked ? "Code required" : ""].filter(Boolean),
        pick
      );
      grid.append(t);
      entries.push({ el: t, text: b.name, pick, name: b.name });
    }
    return section("Select a building", grid, makeTileSearch(entries, "Search buildings…"));
  }

  function sortClasses(classes) {
    const arr = classes.slice();
    const by = ui.classSort;
    if (by === "custom") return arr; // admin's manual order
    const key = by === "name" ? (c) => c.name : by === "instructor" ? (c) => c.instructor || "~~~" : (c) => c.room || "~~~";
    return arr.sort((a, b) => String(key(a)).localeCompare(String(key(b)), undefined, { numeric: true, sensitivity: "base" }));
  }

  function pickerClasses() {
    const f = buildingById(nav.buildingId);
    const grid = el("div", { class: "tiles" });
    const classes = f ? f.b.classes : [];
    const entries = [];
    for (const c of sortClasses(classes)) {
      const devs = devicesInClass(c.id);
      const pick = () => setDrill(nav.locationId, nav.buildingId, c.id);
      const t = tile(
        c.name,
        "💻",
        [c.instructor ? `👤 ${c.instructor}` : "No instructor set", c.room || "", `${onlineCount(devs)}/${devs.length} online`].filter(Boolean),
        pick
      );
      grid.append(t);
      entries.push({ el: t, text: `${c.name} ${c.instructor || ""} ${c.room || ""}`, pick, name: c.name });
    }
    const un = f ? unassignedInBuilding(f.b.id) : [];
    if (un.length) {
      const pick = () => setDrill(nav.locationId, nav.buildingId, UNASSIGNED);
      const t = tile("Unassigned computers", "❓", [`${onlineCount(un)}/${un.length} online`, "Not yet in a class"], pick);
      grid.append(t);
      entries.push({ el: t, text: "Unassigned computers", pick, name: "Unassigned computers" });
    }
    if (!classes.length && !un.length)
      grid.append(emptyNote("No classes here yet. An admin can add one in the Admin panel."));

    const sortSel = el(
      "select",
      { class: "sort-select", onchange: (e) => { ui.classSort = e.target.value; render(); } },
      ...[["room", "Sort: Room"], ["name", "Sort: Name"], ["instructor", "Sort: Instructor"], ["custom", "Sort: Custom order"]].map(([v, t]) =>
        el("option", { value: v, selected: v === ui.classSort }, t)
      )
    );
    const actions = el("div", { class: "picker-actions" }, entries.length > 1 ? makeTileSearch(entries, "Search classes, instructor, room…") : null, classes.length > 1 ? sortSel : null);

    // Whole-building controls: pause/message/block every screen in the building
    // at once, plus a building-wide persistent "always block" list.
    let buildingControls = null;
    if (f) {
      const b = f.b;
      const bDevs = devicesInBuilding(b.id);
      const bRunAll = (action, params) => command({ scope: "building", buildingId: b.id }, action, params);
      const openApps = [...new Set(bDevs.flatMap((d) => d.processes || []))].sort((a, x) => a.toLowerCase().localeCompare(x.toLowerCase()));
      const bSeg = (mode, label) => el("button", { class: "seg-btn" + (ui.buildingMode === mode ? " active" : ""), onclick: () => { ui.buildingMode = mode; render(); } }, label);
      const lockBtn = ui.buildingMode === "lab"
        ? el("button", { class: "btn sm lock-btn" + (ui.seatLocked ? " locked" : ""), title: ui.seatLocked ? "Locked — click to unlock and rearrange rooms" : "Unlocked — drag to arrange. Click to lock.", onclick: () => { ui.seatLocked = !ui.seatLocked; render(); } }, ui.seatLocked ? "🔒 Locked" : "🔓 Unlocked")
        : null;
      buildingControls = el(
        "div",
        { class: "building-controls" },
        el(
          "div",
          { class: "class-header" },
          el("h2", {}, "🏢 " + b.name),
          el("div", { class: "class-meta" }, el("span", { class: "pill muted" }, `${onlineCount(bDevs)}/${bDevs.length} online in building`)),
          el("div", { class: "seg" }, bSeg("list", "▦ Classes"), bSeg("lab", "🪑 Lab layout"), lockBtn)
        ),
        controlToolbar("Whole building:", bRunAll, `every screen in ${b.name}`),
        alwaysBlockBar(
          "Always block for this building:",
          b,
          (kind, value) => buildingrule({ op: "add", buildingId: b.id, kind, value }),
          (kind, value) => buildingrule({ op: "remove", buildingId: b.id, kind, value }),
          openApps
        )
      );
    }
    const body = ui.buildingMode === "lab" && f ? buildingLabView(f.b) : section("Select a class", grid, actions);
    return el("div", { class: "building-view" }, buildingControls, body);
  }

  function tile(title, icon, lines, onclick) {
    return el(
      "button",
      { class: "tile", onclick },
      el("div", { class: "tile-icon" }, icon),
      el("div", { class: "tile-title" }, title),
      el("div", { class: "tile-lines" }, ...lines.map((l) => el("div", { class: "tile-line" }, l)))
    );
  }

  // Shared control toolbar — used for a whole class AND a whole building.
  // `runAll(action, params)` dispatches to the right scope; `where` describes the
  // target for the message composer.
  function controlToolbar(labelText, runAll, where) {
    return el(
      "div",
      { class: "toolbar" },
      el("span", { class: "toolbar-label" }, labelText),
      el("button", { class: "btn danger", onclick: () => blockPreset(runAll, robloxPreset()) }, "Block Roblox"),
      blockSelect(runAll),
      el("button", { class: "btn", onclick: () => runAll("unblock_all", {}) }, "Unblock all"),
      el("button", { class: "btn", onclick: () => runAll("pause", { text: "Paused by your instructor — eyes up front." }) }, "⏸ Pause"),
      el("button", { class: "btn", onclick: () => runAll("resume", {}) }, "▶ Resume"),
      el("button", { class: "btn", onclick: () => runAll("close_tab", {}) }, "Close tab"),
      el("button", { class: "btn", onclick: () => runAll("minimize_all", {}) }, "Minimize"),
      el("button", { class: "btn", onclick: () => openSendKeys(runAll) }, "⌨ Keys…"),
      el("button", { class: "btn", onclick: () => openMessageComposer(runAll, where) }, "✉ Message / Lock…")
    );
  }

  // Persistent "always block" bar for a class or a building — apps AND websites.
  // `ruleObj` has blockApps/blockSites; add/remove(kind, value) send the rule.
  function alwaysBlockBar(label, ruleObj, addRule, removeRule, openApps) {
    const apps = ruleObj.blockApps || [];
    const sites = ruleObj.blockSites || [];
    const chips = el("div", { class: "rule-chips" });
    if (!apps.length && !sites.length) chips.append(el("span", { class: "muted small" }, "none yet"));
    apps.forEach((p) =>
      chips.append(el("span", { class: "chip rule" }, "⛔ " + p, el("button", { class: "chip-x", title: "Remove", onclick: () => removeRule("app", p) }, "✕")))
    );
    sites.forEach((s) =>
      chips.append(el("span", { class: "chip rule site" }, "🌐 " + s, el("button", { class: "chip-x", title: "Remove", onclick: () => removeRule("site", s) }, "✕")))
    );
    const siteInput = el("input", { class: "combo-input", type: "text", placeholder: "Add website (e.g. poki.com)…", autocomplete: "off" });
    const addSite = () => {
      const v = siteInput.value.trim();
      if (v) { addRule("site", v); siteInput.value = ""; }
    };
    siteInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addSite(); } });
    return el(
      "div",
      { class: "rules-bar" },
      el("span", { class: "toolbar-label" }, label),
      chips,
      appComboBox(openApps, "Add app (type or pick an open app)…", (v) => addRule("app", v)),
      el("div", { class: "combo site-add" }, siteInput, el("button", { class: "btn sm", onclick: addSite }, "Add site"))
    );
  }

  // ---- building "lab layout": every classroom placed on one house canvas ----
  // A shared "front of classes" up top; each class is a draggable mini seating
  // chart laid out from that class's saved positions. Drag a room by its title
  // bar to arrange the house (positions persist per building, just like seats);
  // tap a room's title to drill into it; tap a computer to control it.
  // The house canvas shows a 20 x 16 grid (cells of 5% x 6.25%). Rooms are sized
  // and snapped in whole grid cells so every edge lands on a grid line.
  const LAB_SNAP_X = 20; // 20 columns -> snap to the 5% background lines
  const LAB_SNAP_Y = 16; // 16 rows    -> snap to the 6.25% background lines
  const ROOM_CELLS_W = 3; // each room is 3 cells wide (15% of the canvas)
  const ROOM_CELLS_H = 5; // ...and 5 rows tall (must match .lab-room height)
  const ROOM_W = ROOM_CELLS_W / LAB_SNAP_X; // 0.15
  const ROOM_H = ROOM_CELLS_H / LAB_SNAP_Y; // 0.3125
  const LAB_PER_ROW = 5; // default rooms across before wrapping to a new row
  const LAB_COL_STEP = 4 / LAB_SNAP_X; // 4 cells per room slot: 3 wide + 1 gap
  const LAB_ROW_STEP = 6 / LAB_SNAP_Y; // 6 rows between stacked rows of rooms
  function roomLayoutKey(buildingId) {
    return "rooms:" + buildingId;
  }
  function getRoomPos(buildingId, roomId, i) {
    const saved = (D.layouts[roomLayoutKey(buildingId)] || {})[roomId];
    if (saved && typeof saved.x === "number") return saved;
    const col = i % LAB_PER_ROW;
    const row = Math.floor(i / LAB_PER_ROW);
    return { x: Math.min(1 - ROOM_W, col * LAB_COL_STEP), y: 1 / LAB_SNAP_Y + row * LAB_ROW_STEP };
  }
  function snapRoom(x, y) {
    const cx = Math.round(x * LAB_SNAP_X) / LAB_SNAP_X;
    const cy = Math.round(y * LAB_SNAP_Y) / LAB_SNAP_Y;
    return { x: Math.max(0, Math.min(1 - ROOM_W, cx)), y: Math.max(0, Math.min(1 - ROOM_H, cy)) };
  }
  function setRoomPosition(buildingId, roomId, x, y) {
    (D.layouts[roomLayoutKey(buildingId)] ||= {})[roomId] = { x, y }; // optimistic
    send({ type: "layout", op: "setPosition", layoutKey: roomLayoutKey(buildingId), deviceId: roomId, x, y });
  }

  // A single computer inside a lab-layout room: shows status only (names hide at
  // this scale). Tap to open its control panel. Not draggable here — seat
  // arrangement is done inside the class's own seating view.
  function labSeat(d, pos) {
    const blockedCount = (d.blocked || []).length + (d.blockedSites || []).length;
    const node = el(
      "div",
      { class: "seat" + (d.online ? "" : " offline"), title: nameOf(d), onclick: () => openDevicePanel(D.devices[d.device_id] || d) },
      el("span", { class: "seat-dot " + (d.online ? "on" : "off") }),
      el("div", { class: "seat-screen" }, "💻"),
      blockedCount ? el("span", { class: "seat-badge" }, "⛔ " + blockedCount) : null
    );
    node.style.left = pos.x * 100 + "%";
    node.style.top = pos.y * 100 + "%";
    node.style.width = (100 / SNAP_COLS) * 0.9 + "%";
    return node;
  }

  // Make a room card draggable by its title bar within the house canvas.
  // Grabs relative to where you clicked so the room doesn't jump; snaps to a
  // fine grid; a click without movement runs onTap (drill into the class).
  function attachRoomDrag(room, handle, buildingId, roomId, onTap) {
    let start = null;
    handle.addEventListener("pointerdown", (e) => {
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      const area = room.parentElement.getBoundingClientRect();
      const rrect = room.getBoundingClientRect();
      start = {
        px: e.clientX, py: e.clientY, moved: false, x: 0, y: 0, area,
        offX: (e.clientX - rrect.left) / area.width,
        offY: (e.clientY - rrect.top) / area.height,
      };
      if (!ui.seatLocked) room.classList.add("dragging");
    });
    handle.addEventListener("pointermove", (e) => {
      if (!start || ui.seatLocked) return;
      const rawX = (e.clientX - start.area.left) / start.area.width - start.offX;
      const rawY = (e.clientY - start.area.top) / start.area.height - start.offY;
      const s = snapRoom(rawX, rawY);
      if (Math.hypot(e.clientX - start.px, e.clientY - start.py) > 6) start.moved = true;
      start.x = s.x;
      start.y = s.y;
      room.style.left = s.x * 100 + "%";
      room.style.top = s.y * 100 + "%";
    });
    const end = () => {
      if (!start) return;
      room.classList.remove("dragging");
      const { moved, x, y } = start;
      start = null;
      if (moved) setRoomPosition(buildingId, roomId, x, y);
      else if (onTap) onTap();
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  function labRoom(name, devs, roomId, pos, onTap, buildingId) {
    const sorted = devs.slice().sort((a, x) => nameOf(a).toLowerCase().localeCompare(nameOf(x).toLowerCase()));
    const canvas = el("div", { class: "room lab-canvas" });
    canvas.append(el("div", { class: "room-front" }, "front"));
    sorted.forEach((d, i) => canvas.append(labSeat(d, getPos(roomId, d, i, sorted.length))));
    if (!sorted.length) canvas.append(el("div", { class: "room-empty" }, "No computers"));
    const head = el(
      "div",
      { class: "lab-room-head" },
      el("div", { class: "lab-room-name", title: "Open " + name }, name),
      el("span", { class: "pill muted sm" }, `${onlineCount(sorted)}/${sorted.length}`)
    );
    const room = el("div", { class: "lab-room" + (ui.seatLocked ? "" : " movable") }, head, canvas);
    room.style.left = pos.x * 100 + "%";
    room.style.top = pos.y * 100 + "%";
    attachRoomDrag(room, head, buildingId, roomId, onTap);
    return room;
  }
  function buildingLabView(b) {
    const classes = sortClasses(b.classes);
    const un = unassignedInBuilding(b.id);
    if (!classes.length && !un.length) return emptyNote("No classes in this building yet.");
    const area = el("div", { class: "lab-canvas-area" });
    let i = 0;
    for (const c of classes) {
      area.append(labRoom(c.name, devicesInClass(c.id), c.id, getRoomPos(b.id, c.id, i), () => setDrill(nav.locationId, b.id, c.id), b.id));
      i++;
    }
    if (un.length) {
      const rid = "un:" + b.id;
      area.append(labRoom("Unassigned", un, rid, getRoomPos(b.id, rid, i), () => setDrill(nav.locationId, b.id, UNASSIGNED), b.id));
    }
    const bar = el(
      "div",
      { class: "canvas-bar" },
      el("span", { class: "muted small" }, ui.seatLocked ? "Rooms locked. Tap a room's title to open it; tap a computer to control it." : "Drag each room by its title bar to arrange the house. Tap a computer to control it."),
      el("span", { class: "spacer" }),
      el("button", { class: "btn ghost sm", disabled: ui.seatLocked, title: ui.seatLocked ? "Unlock first" : "", onclick: () => { if (!ui.seatLocked) resetLayout(roomLayoutKey(b.id)); } }, "Reset layout")
    );
    return el(
      "div",
      { class: "lab-view" + (ui.seatLocked ? " locked" : "") },
      el("div", { class: "lab-front-label" }, "front of classes ↑"),
      bar,
      area
    );
  }

  // ---- class monitor (the live grid) ----
  function classMonitor() {
    const isUn = nav.classId === UNASSIGNED;
    const meta = isUn ? null : classById(nav.classId);
    const devs = isUn ? unassignedInBuilding(nav.buildingId) : devicesInClass(nav.classId);

    const header = el(
      "div",
      { class: "class-header" },
      el(
        "div",
        {},
        el("h2", {}, isUn ? "Unassigned computers" : meta ? meta.c.name : "Class"),
        el(
          "div",
          { class: "class-meta" },
          !isUn && meta && meta.c.instructor ? el("span", { class: "pill" }, "👤 " + meta.c.instructor) : null,
          !isUn && meta && meta.c.room ? el("span", { class: "pill" }, "📍 " + meta.c.room) : null,
          el("span", { class: "pill muted" }, `${onlineCount(devs)}/${devs.length} online`)
        )
      )
    );

    // class-wide toolbar (block duration lives in the top bar, applies globally)
    const classTargets = () => (isUn ? devs.map((d) => ({ scope: "device", deviceId: d.device_id })) : [{ scope: "class", classId: nav.classId }]);
    const runAll = (action, params) => classTargets().forEach((t) => command(t, action, params));

    const toolbar = controlToolbar("Whole class:", runAll, "every screen in this class");

    const sorted = devs.slice().sort((a, b) => nameOf(a).toLowerCase().localeCompare(nameOf(b).toLowerCase()));
    const layoutKey = nav.classId === UNASSIGNED ? "un:" + nav.buildingId : nav.classId;

    // Grid / Seating view toggle (added to the header, right side)
    const segBtn = (mode, label) =>
      el(
        "button",
        {
          class: "seg-btn" + (ui.monitorMode === mode ? " active" : ""),
          onclick: () => {
            ui.monitorMode = mode;
            render();
          },
        },
        label
      );
    header.append(el("div", { class: "seg" }, segBtn("grid", "▦ Grid"), segBtn("canvas", "🪑 Seating")));

    let body;
    if (ui.monitorMode === "canvas") {
      body = renderRoom(layoutKey, sorted);
    } else {
      const grid = el("div", { class: "device-grid" });
      if (!sorted.length) grid.append(emptyNote("No computers here yet. Laptops running the agent will appear automatically."));
      sorted.forEach((d) => grid.append(deviceCard(d)));
      body = grid;
    }

    // Persistent "always block" apps + websites for this class (real classes only).
    let rulesBar = null;
    if (!isUn && meta) {
      const cls = meta.c;
      const openApps = [...new Set(devs.flatMap((d) => d.processes || []))].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      rulesBar = alwaysBlockBar(
        "Always block for this class:",
        cls,
        (kind, value) => classrule({ op: "add", classId: cls.id, kind, value }),
        (kind, value) => classrule({ op: "remove", classId: cls.id, kind, value }),
        openApps
      );
    }

    return el("div", { class: "class-monitor" }, header, toolbar, rulesBar, body);
  }

  // ---- seating canvas ----
  function getPos(layoutKey, d, i, total) {
    const saved = (D.layouts[layoutKey] || {})[d.device_id];
    if (saved && typeof saved.x === "number") return saved;
    // default: fill the snap grid left-to-right, top-to-bottom (aligned, no overlap)
    const col = i % SNAP_COLS;
    const row = Math.floor(i / SNAP_COLS) % SNAP_ROWS;
    return cellCenter(col, row);
  }

  // Seat positions snap to whole cells of a 16×12 grid (bigger classrooms) that
  // matches the room's background lines; seats are sized to the cell so each sits
  // in its own cell without overlapping.
  const SNAP_COLS = 16;
  const SNAP_ROWS = 12;
  function cellCenter(col, row) {
    return { x: (col + 0.5) / SNAP_COLS, y: (row + 0.5) / SNAP_ROWS };
  }
  function snapPos(x, y) {
    const col = Math.max(0, Math.min(SNAP_COLS - 1, Math.round(x * SNAP_COLS - 0.5)));
    const row = Math.max(0, Math.min(SNAP_ROWS - 1, Math.round(y * SNAP_ROWS - 0.5)));
    return cellCenter(col, row);
  }

  function setPosition(layoutKey, deviceId, x, y) {
    (D.layouts[layoutKey] ||= {})[deviceId] = { x, y }; // optimistic
    send({ type: "layout", op: "setPosition", layoutKey, deviceId, x, y });
  }
  function resetLayout(layoutKey) {
    delete D.layouts[layoutKey];
    send({ type: "layout", op: "resetLayout", layoutKey });
    render();
  }

  function renderRoom(layoutKey, devices) {
    const room = el("div", { class: "room" });
    room.append(el("div", { class: "room-front" }, "▲ Front of room / whiteboard"));
    const total = devices.length;
    devices.forEach((d, i) => room.append(seatNode(d, getPos(layoutKey, d, i, total), layoutKey)));
    if (!total) room.append(el("div", { class: "room-empty" }, "No computers here yet."));

    const lockBtn = el(
      "button",
      {
        class: "btn sm lock-btn" + (ui.seatLocked ? " locked" : ""),
        title: ui.seatLocked ? "Locked — click to unlock and rearrange" : "Unlocked — drag to arrange. Click to lock.",
        onclick: () => { ui.seatLocked = !ui.seatLocked; render(); },
      },
      ui.seatLocked ? "🔒 Locked" : "🔓 Unlocked"
    );
    const bar = el(
      "div",
      { class: "canvas-bar" },
      el("span", { class: "muted small" }, ui.seatLocked ? "Positions are locked. Tap a computer to control it." : "Drag each computer to where the student sits. Tap one to control it."),
      el("span", { class: "spacer" }),
      lockBtn,
      el("button", { class: "btn ghost sm", disabled: ui.seatLocked, title: ui.seatLocked ? "Unlock first" : "", onclick: () => { if (!ui.seatLocked) resetLayout(layoutKey); } }, "Reset layout")
    );
    return el("div", { class: "room-wrap" + (ui.seatLocked ? " locked" : "") }, bar, room);
  }

  function seatNode(d, pos, layoutKey) {
    const blockedCount = (d.blocked || []).length + (d.blockedSites || []).length;
    const node = el(
      "div",
      { class: "seat" + (d.online ? "" : " offline") },
      el("span", { class: "seat-dot " + (d.online ? "on" : "off") }),
      el("div", { class: "seat-screen" }, "💻"),
      el("div", { class: "seat-name" }, nameOf(d)),
      blockedCount ? el("span", { class: "seat-badge" }, "⛔ " + blockedCount) : null
    );
    node.style.left = pos.x * 100 + "%";
    node.style.top = pos.y * 100 + "%";
    // size each seat to (just under) one grid cell so they align and never overlap
    node.style.width = (100 / SNAP_COLS) * 0.9 + "%";

    let start = null;
    node.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      try {
        node.setPointerCapture(e.pointerId);
      } catch (_) {}
      // still record the press so a tap opens the panel; only enable dragging
      // when the canvas is unlocked (the lock prevents accidental moves).
      start = { px: e.clientX, py: e.clientY, moved: false, x: pos.x, y: pos.y, room: node.parentElement.getBoundingClientRect() };
      if (!ui.seatLocked) {
        ui.dragging = { deviceId: d.device_id };
        node.classList.add("dragging");
      }
    });
    node.addEventListener("pointermove", (e) => {
      if (!start || ui.seatLocked) return;
      const rawX = (e.clientX - start.room.left) / start.room.width;
      const rawY = (e.clientY - start.room.top) / start.room.height;
      const s = snapPos(rawX, rawY); // snap to grid for a clean, aligned look
      if (Math.hypot(e.clientX - start.px, e.clientY - start.py) > 6) start.moved = true;
      start.x = s.x;
      start.y = s.y;
      node.style.left = s.x * 100 + "%";
      node.style.top = s.y * 100 + "%";
    });
    const end = () => {
      if (!start) return;
      node.classList.remove("dragging");
      const { moved, x, y } = start;
      start = null;
      ui.dragging = null;
      if (moved) setPosition(layoutKey, d.device_id, x, y);
      else openDevicePanel(D.devices[d.device_id] || d);
    };
    node.addEventListener("pointerup", end);
    node.addEventListener("pointercancel", end);
    return node;
  }

  // control panel opened by tapping a seat (lives outside #app so re-renders keep it)
  function ensureOverlay() {
    let o = document.getElementById("overlay");
    if (!o) {
      o = el("div", { id: "overlay" });
      document.body.append(o);
    }
    return o;
  }
  function closeOverlay() {
    stopLiveView();
    const o = document.getElementById("overlay");
    if (o) {
      o.classList.remove("open");
      o.innerHTML = "";
    }
  }
  // On-demand live screen view (only while this one computer's panel is open).
  function startLiveView(d) {
    stopLiveView();
    if (DEMO) return null; // demo has no real agents
    const img = el("img", { class: "live-img", alt: "live screen" });
    const wrap = el(
      "div",
      { class: "live-view" },
      el("div", { class: "live-badge" }, el("span", { class: "live-dot" }), "LIVE"),
      img,
      el("div", { class: "live-hint" }, "Live screen — only while this panel is open (~1 fps)")
    );
    liveView = { deviceId: d.device_id, img, wrap };
    if (d.online) command({ scope: "device", deviceId: d.device_id }, "start_screenshot", {});
    return wrap;
  }
  function stopLiveView() {
    if (liveView) {
      const id = liveView.deviceId;
      liveView = null;
      if (!DEMO) command({ scope: "device", deviceId: id }, "stop_screenshot", {});
    }
  }
  function openDevicePanel(d) {
    const t = { scope: "device", deviceId: d.device_id };
    const dispatch = (a, p) => command(t, a, p);
    const o = ensureOverlay();
    o.innerHTML = "";

    const sheet = el("div", { class: "sheet" });
    sheet.addEventListener("click", (e) => e.stopPropagation());
    sheet.append(
      el(
        "div",
        { class: "sheet-head" },
        el("span", { class: "dot " + (d.online ? "on" : "off") }),
        el("span", { class: "sheet-title" }, nameOf(d)),
        el("span", { class: "os" }, d.os),
        el("span", { class: "spacer" }),
        el("button", { class: "btn ghost sm", onclick: () => promptRename(d) }, "✎ Rename"),
        el("button", { class: "btn ghost sm", onclick: closeOverlay }, "✕")
      ),
      el("div", { class: "sheet-sub" }, `${nameOf(d) !== d.hostname ? d.hostname + " · " : ""}${(d.windows || []).length} open window(s) · ${(d.processes || []).length} apps · ${d.online ? "online" : "offline"}`)
    );

    // live screen thumbnail (on-demand — starts now, stops when the panel closes)
    const lv = startLiveView(d);
    if (lv) sheet.append(lv);

    if ((d.blocked || []).length || (d.blockedSites || []).length) {
      const chips = el("div", { class: "chips" });
      (d.blocked || []).forEach((b) => chips.append(blockChip("⛔", b.pattern, b.expires_at)));
      (d.blockedSites || []).forEach((b) => chips.append(blockChip("🌐", b.domain, b.expires_at, "site")));
      sheet.append(chips);
    }

    if ((d.windows || []).length) {
      const list = el("div", { class: "list windows" });
      d.windows.forEach((w) => list.append(el("div", { class: "row" + (d.activeWindow && w === d.activeWindow ? " active-win" : "") }, w)));
      sheet.append(el("div", { class: "list-wrap" }, el("div", { class: "list-title" }, "Open windows"), list));
    }

    sheet.append(
      el(
        "div",
        { class: "sheet-actions" },
        el("button", { class: "btn danger sm", onclick: () => blockPreset(dispatch, robloxPreset()) }, "Block Roblox"),
        blockSelect(dispatch),
        el("button", { class: "btn sm", onclick: () => promptKill(t) }, "Close app…"),
        el("button", { class: "btn sm", onclick: () => command(t, "unblock_all", {}) }, "Unblock all"),
        el("button", { class: "btn sm", onclick: () => command(t, "pause", { text: "Paused by your instructor — eyes up front." }) }, "⏸ Pause"),
        el("button", { class: "btn sm", onclick: () => command(t, "resume", {}) }, "▶ Resume"),
        el("button", { class: "btn sm", onclick: () => command(t, "close_tab", {}) }, "Close tab"),
        el("button", { class: "btn sm", onclick: () => command(t, "minimize_all", {}) }, "Minimize"),
        el("button", { class: "btn sm", onclick: () => openSendKeys(dispatch) }, "⌨ Keys…"),
        el("button", { class: "btn sm", onclick: () => promptMessage(t) }, "✉ Message / Lock…"),
        el("button", { class: "btn sm ghost", onclick: () => command(t, "list_now", {}) }, "Refresh")
      )
    );

    o.append(el("div", { class: "sheet-backdrop", onclick: closeOverlay }), sheet);
    o.classList.add("open");
  }

  function agoLabel(sec) {
    const s = Math.max(0, Math.floor(Date.now() / 1000 - sec));
    if (s < 5) return "just now";
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  }

  // A block chip whose countdown lives in its own .cd[data-exp] span, so
  // refreshLiveLabels() can tick it in place without rebuilding the card.
  function blockChip(icon, label, expiresAt, extraClass) {
    const chip = el("span", { class: "chip" + (extraClass ? " " + extraClass : "") }, `${icon} ${label}`);
    if (expiresAt > 0)
      chip.append(el("span", { class: "cd", "data-exp": String(expiresAt) }, ` (${Math.max(0, Math.round(expiresAt - Date.now() / 1000))}s)`));
    return chip;
  }

  function deviceCard(d) {
    const card = el("div", { class: "card" + (d.online ? "" : " offline") });
    card.append(
      el(
        "div",
        { class: "card-head" },
        el("span", { class: "dot " + (d.online ? "on" : "off") }),
        el("span", { class: "hostname", title: nameOf(d) !== d.hostname ? d.hostname : "", ondblclick: () => promptRename(d) }, nameOf(d)),
        el("span", { class: "os" }, d.os),
        el("span", { class: "seen", "data-ago": d.online ? null : String(d.last_seen) }, d.online ? "online" : agoLabel(d.last_seen))
      )
    );

    if ((d.blocked && d.blocked.length) || (d.blockedSites && d.blockedSites.length)) {
      const chips = el("div", { class: "chips" });
      (d.blocked || []).forEach((b) => chips.append(blockChip("⛔", b.pattern, b.expires_at)));
      (d.blockedSites || []).forEach((b) => chips.append(blockChip("🌐", b.domain, b.expires_at, "site")));
      card.append(chips);
      if (d.blockedSites && d.blockedSites.length && d.sitesAvailable === false)
        card.append(el("div", { class: "warn" }, "⚠ Website blocks need the agent to run as Administrator on this computer."));
    }

    const winList = trackScroll(el("div", { class: "list windows" }), d.device_id + ":win");
    if (d.windows && d.windows.length) d.windows.forEach((w) => winList.append(el("div", { class: "row" + (d.activeWindow && w === d.activeWindow ? " active-win" : "") }, w)));
    else winList.append(el("div", { class: "row muted" }, d.online ? "—" : "offline"));
    card.append(
      el("div", { class: "list-wrap" }, el("div", { class: "list-title" }, `Open windows (${(d.windows || []).length})`), winList)
    );

    const procList = trackScroll(el("div", { class: "list procs" }), d.device_id + ":proc");
    (d.processes || []).forEach((p) => procList.append(el("div", { class: "row" }, p)));
    const det = el("details", { class: "apps" }, el("summary", {}, `Running apps (${(d.processes || []).length})`), procList);
    if (ui.expandedProcs.has(d.device_id)) det.open = true;
    // remember expanded state so a live re-render doesn't collapse it
    det.addEventListener("toggle", () => {
      if (det.open) ui.expandedProcs.add(d.device_id);
      else ui.expandedProcs.delete(d.device_id);
    });
    card.append(det);

    const t = { scope: "device", deviceId: d.device_id };
    const dispatch = (action, params) => command(t, action, params);
    card.append(
      el(
        "div",
        { class: "actions" },
        el("button", { class: "btn sm", onclick: () => promptRename(d) }, "✎ Rename"),
        el("button", { class: "btn danger sm", onclick: () => blockPreset(dispatch, robloxPreset()) }, "Block Roblox"),
        blockSelect(dispatch),
        el("button", { class: "btn sm", onclick: () => promptKill(t) }, "Close app…"),
        el("button", { class: "btn sm", onclick: () => command(t, "unblock_all", {}) }, "Unblock all"),
        el("button", { class: "btn sm", onclick: () => command(t, "pause", { text: "Paused by your instructor — eyes up front." }) }, "⏸ Pause"),
        el("button", { class: "btn sm", onclick: () => command(t, "resume", {}) }, "▶ Resume"),
        el("button", { class: "btn sm", onclick: () => command(t, "close_tab", {}) }, "Close tab"),
        el("button", { class: "btn sm", onclick: () => command(t, "minimize_all", {}) }, "Minimize"),
        el("button", { class: "btn sm", onclick: () => openSendKeys(dispatch) }, "⌨ Keys…"),
        el("button", { class: "btn sm", onclick: () => promptMessage(t) }, "✉ Message / Lock…"),
        el("button", { class: "btn sm ghost", onclick: () => command(t, "list_now", {}) }, "Refresh")
      )
    );
    return card;
  }

  async function promptKill(t) {
    const n = await modalPrompt({
      title: "Close an app",
      label: "Close which app?",
      placeholder: "name or part of it, e.g. chrome, steam",
      okText: "Close app",
    });
    if (n && n.trim()) command(t, "kill_process", { pattern: n.trim() });
  }

  // Send a keyboard shortcut to the target's foreground window. Surfaced as a
  // first-class control (⌨ Keys…), not just an item buried in the Block menu.
  function openSendKeys(dispatch) {
    modalPrompt({
      title: "Send a keyboard shortcut",
      label: "Keys to press on the front window",
      value: "ctrl+w",
      placeholder: "e.g. win+d, alt+F4, ctrl+shift+t, enter",
      hint: "Combine with +. Modifiers: ctrl, alt, shift, win. Also: enter, esc, tab, F1–F12, arrows.",
      okText: "Press",
    }).then((keys) => {
      if (keys && keys.trim()) {
        dispatch("send_keys", { keys: keys.trim() });
        toast(`Pressing ${keys.trim()}.`);
      }
    });
  }

  // Unified "Send to screen(s)" composer — combines the old Message… and
  // Full-screen… into one real dialog. Two styles:
  //   • Pop-up message — a dismissible note; optionally lock the OK button for a
  //     few seconds, and/or auto-dismiss after a while.
  //   • Lock the screen — a full-screen cover that stays until you Resume (or
  //     auto-resumes after a set number of minutes). `runner(action, params)`
  //     sends the resulting command to the right target.
  function openMessageComposer(runner, where) {
    let style = "message";
    const text = el("textarea", { class: "modal-input", rows: "3", placeholder: "Type what students should see…" });

    const holdSel = el(
      "select",
      { class: "modal-input" },
      ...[[0, "They can close it right away"], [5, "Lock OK for 5s"], [10, "Lock OK for 10s"], [20, "Lock OK for 20s"], [30, "Lock OK for 30s"]].map(([v, t]) => el("option", { value: v }, t))
    );
    const autoCloseSel = el(
      "select",
      { class: "modal-input" },
      ...[[0, "Stay until they close it"], [10, "Auto-close after 10s"], [30, "Auto-close after 30s"], [60, "Auto-close after 1 min"], [180, "Auto-close after 3 min"]].map(([v, t]) => el("option", { value: v }, t))
    );
    const autoResumeSel = el(
      "select",
      { class: "modal-input" },
      ...[[0, "Stays until I press Resume"], [1, "Auto-resume after 1 min"], [2, "Auto-resume after 2 min"], [5, "Auto-resume after 5 min"], [10, "Auto-resume after 10 min"]].map(([v, t]) => el("option", { value: v }, t))
    );

    const msgOpts = el(
      "div",
      { class: "composer-opts" },
      el("label", { class: "modal-label" }, "Before they can dismiss it"),
      holdSel,
      el("label", { class: "modal-label" }, "Auto-dismiss"),
      autoCloseSel
    );
    const lockOpts = el(
      "div",
      { class: "composer-opts" },
      el("label", { class: "modal-label" }, "How long to lock the screen"),
      autoResumeSel,
      el("p", { class: "modal-hint" }, "The cover reopens if a student closes it, so it holds attention until it lifts.")
    );

    function applyStyle() {
      msgOpts.style.display = style === "message" ? "" : "none";
      lockOpts.style.display = style === "lock" ? "" : "none";
      for (const b of styleBtns) b.classList.toggle("active", b.dataset.style === style);
    }
    const styleBtns = [
      el("button", { class: "seg-btn", "data-style": "message", type: "button", onclick: () => { style = "message"; applyStyle(); } }, "💬 Pop-up message"),
      el("button", { class: "seg-btn", "data-style": "lock", type: "button", onclick: () => { style = "lock"; applyStyle(); } }, "🔒 Lock the screen"),
    ];

    const send = () => {
      const t = text.value.trim();
      if (!t) {
        text.focus();
        return;
      }
      if (style === "lock") {
        const mins = parseInt(autoResumeSel.value, 10) || 0;
        runner("pause", { text: t, duration_sec: mins > 0 ? mins * 60 : 0 });
        toast(mins > 0 ? `Screen locked (auto-resumes in ${mins} min).` : "Screen locked — press Resume to lift.");
      } else {
        runner("message", { text: t, hold_sec: parseInt(holdSel.value, 10) || 0, auto_close_sec: parseInt(autoCloseSel.value, 10) || 0 });
        toast("Message sent.");
      }
      m.close();
    };

    const body = el(
      "div",
      { class: "composer" },
      el("div", { class: "modal-hint tight" }, `Showing on ${where}.`),
      el("div", { class: "seg composer-seg" }, ...styleBtns),
      el("label", { class: "modal-label" }, "Message"),
      text,
      msgOpts,
      lockOpts
    );
    const m = openModal({
      title: "Send to screen",
      body,
      actions: [el("button", { class: "btn ghost", onclick: () => m.close() }, "Cancel"), el("button", { class: "btn primary", onclick: send }, "Send")],
      width: "520px",
    });
    applyStyle();
    setTimeout(() => text.focus(), 40);
  }
  const promptMessage = (t) => openMessageComposer((a, p) => command(t, a, p), "this student's screen");

  // -------------------------------------------------------------------- admin
  function renderAdmin() {
    const c = el("div", { class: "admin" });
    c.append(el("h1", { class: "page-title" }, "Admin panel"));
    c.append(adminOrg(), adminComputers(), adminSchedules(), adminSettings());
    return c;
  }

  function section(title, body, actions) {
    return el(
      "section",
      { class: "panel" },
      el("div", { class: "panel-head" }, el("h2", {}, title), actions || null),
      body
    );
  }
  function emptyNote(text) {
    return el("p", { class: "empty" }, text);
  }

  // ---- scheduled events (daily timed closures/pauses) ----
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const allApps = () => [...new Set(BLOCK_PRESETS.flatMap((p) => p.apps))];
  const allSites = () => [...new Set(BLOCK_PRESETS.flatMap((p) => p.sites))];
  const allExcludes = () => [...new Set(BLOCK_PRESETS.flatMap((p) => p.exclude || []))];
  // build(opts) — opts.text (message text) and opts.pauseMin (auto-resume minutes
  // for a timed pause; 0 = stays until a Resume event or manual resume).
  const EVENT_TYPES = [
    { id: "pause", label: "Pause computers (full-screen)", usesPause: true, build: (o) => [{ action: "pause", params: { text: "Paused by your instructor — eyes up front.", duration_sec: o.pauseMin > 0 ? o.pauseMin * 60 : 0 } }] },
    { id: "resume", label: "Resume (end pause)", build: () => [{ action: "resume" }] },
    { id: "block_roblox", label: "Block Roblox (Player)", build: () => [{ action: "block_app", params: { patterns: ["roblox"], exclude: ["studio"] } }, { action: "block_site", params: { domains: ["roblox.com"] } }] },
    { id: "block_all", label: "Block all games + sites", build: () => [{ action: "block_app", params: { patterns: allApps(), exclude: allExcludes() } }, { action: "block_site", params: { domains: allSites() } }] },
    { id: "minimize_all", label: "Minimize all windows", build: () => [{ action: "minimize_all" }] },
    { id: "close_tab", label: "Close current tab", build: () => [{ action: "close_tab" }] },
    { id: "close_browsers", label: "Close all browsers", build: () => [{ action: "close_browsers" }] },
    { id: "unblock", label: "Unblock everything", build: () => [{ action: "unblock_all" }] },
    // The duration is how long the message stays up AND stays locked: the OK
    // button is hidden for that long, then it dismisses itself. 0 = show it
    // straight away as dismissible and leave it until the student clicks OK.
    { id: "message", label: "Full-screen message (timed)", usesMsg: true, usesMsgSec: true, build: (o) => [{ action: "message", params: { text: o.text || "", hold_sec: o.msgSec, auto_close_sec: o.msgSec } }] },
  ];
  const ACTION_LABEL = { pause: "Pause", resume: "Resume", block_app: "Block apps", block_site: "Block sites", unblock_all: "Unblock", close_browsers: "Close browsers", close_tab: "Close tab", minimize_all: "Minimize", message: "Message", kill_process: "Close app" };

  function targetLabel(tg) {
    if (!tg || tg.scope === "all") return "Everyone";
    if (tg.scope === "location") { const l = locationById(tg.locationId); return l ? `📍 ${l.name}` : "(deleted)"; }
    if (tg.scope === "building") { const f = buildingById(tg.buildingId); return f ? `🏢 ${f.b.name}` : "(deleted)"; }
    if (tg.scope === "class") { const f = classById(tg.classId); return f ? `💻 ${f.c.name}` : "(deleted)"; }
    return tg.scope;
  }
  function targetsLabel(s) {
    const arr = s.targets && s.targets.length ? s.targets : s.target ? [s.target] : [{ scope: "all" }];
    return arr.map(targetLabel).join(", ");
  }
  // Pick a scope from a dropdown, then tick the specific items — short + readable,
  // and still lets one event apply to several buildings/campuses at once.
  function buildTargetPicker(initialTargets) {
    const keyOf = (t) => t.scope + ":" + (t.locationId || t.buildingId || t.classId || "");
    const initial = Array.isArray(initialTargets) && initialTargets.length ? initialTargets : [{ scope: "all" }];
    const initScope = initial.every((t) => t.scope === initial[0].scope) ? initial[0].scope : "all";
    const selected = new Set(initial.filter((t) => t.scope !== "all").map(keyOf));

    const wrap = el("div", { class: "target-picker" });
    const scopeSel = el(
      "select",
      { class: "target-scope" },
      ...[["all", "Everyone — all campuses"], ["location", "Whole campus…"], ["building", "Specific buildings…"], ["class", "Specific classes…"]].map(([v, t]) => el("option", { value: v, selected: v === initScope }, t))
    );
    // filters (narrow the checkbox list): campus for buildings; campus + building
    // for classes — so big orgs aren't a wall of every class.
    const filterBar = el("div", { class: "target-filters" });
    const locFilter = el("select", { class: "filter-sel" }, el("option", { value: "" }, "All campuses"), ...D.org.map((l) => el("option", { value: l.id }, "📍 " + l.name)));
    const bldFilter = el("select", { class: "filter-sel" });
    function refreshBldFilter() {
      bldFilter.innerHTML = "";
      bldFilter.append(el("option", { value: "" }, "All buildings"));
      for (const l of D.org) { if (locFilter.value && l.id !== locFilter.value) continue; for (const b of l.buildings) bldFilter.append(el("option", { value: b.id }, "🏢 " + b.name)); }
    }

    const list = el("div", { class: "target-list" });
    function rebuild() {
      const scope = scopeSel.value;
      filterBar.innerHTML = "";
      if (scope === "building") filterBar.append(el("span", { class: "filter-label" }, "Campus:"), locFilter);
      else if (scope === "class") { refreshBldFilter(); filterBar.append(el("span", { class: "filter-label" }, "Campus:"), locFilter, el("span", { class: "filter-label" }, "Building:"), bldFilter); }
      list.innerHTML = "";
      if (scope === "all") { list.append(el("div", { class: "muted small" }, "Runs on every computer at every campus.")); return; }
      const add = (label, target) => {
        const k = keyOf(target);
        const cb = el("input", { type: "checkbox", checked: selected.has(k), onchange: () => { if (cb.checked) selected.add(k); else selected.delete(k); } });
        list.append(el("label", { class: "target-chip" }, cb, el("span", {}, label)));
      };
      if (scope === "location") for (const loc of D.org) add(`📍 ${loc.name}`, { scope: "location", locationId: loc.id });
      else if (scope === "building") for (const loc of D.org) { if (locFilter.value && loc.id !== locFilter.value) continue; for (const b of loc.buildings) add(`🏢 ${b.name}`, { scope: "building", buildingId: b.id }); }
      else for (const loc of D.org) { if (locFilter.value && loc.id !== locFilter.value) continue; for (const b of loc.buildings) { if (bldFilter.value && b.id !== bldFilter.value) continue; for (const c of b.classes) add(`💻 ${b.name} · ${c.name}`, { scope: "class", classId: c.id }); } }
      if (!list.children.length) list.append(el("div", { class: "muted small" }, "Nothing at this level yet."));
    }
    scopeSel.addEventListener("change", rebuild);
    locFilter.addEventListener("change", rebuild);
    bldFilter.addEventListener("change", rebuild);
    rebuild();
    wrap.append(scopeSel, filterBar, list);
    // Reconstruct selected targets from the org tree so selections survive filtering.
    function collect() {
      const scope = scopeSel.value;
      if (scope === "all") return [{ scope: "all" }];
      const out = [];
      for (const l of D.org) {
        if (scope === "location" && selected.has("location:" + l.id)) out.push({ scope: "location", locationId: l.id });
        for (const b of l.buildings) {
          if (scope === "building" && selected.has("building:" + b.id)) out.push({ scope: "building", buildingId: b.id });
          if (scope === "class") for (const c of b.classes) if (selected.has("class:" + c.id)) out.push({ scope: "class", classId: c.id });
        }
      }
      return out;
    }
    return {
      node: wrap,
      getTargets: collect,
      reset: () => { scopeSel.value = "all"; locFilter.value = ""; bldFilter.value = ""; selected.clear(); rebuild(); },
    };
  }
  function fieldInline(label, node) {
    return el("label", { class: "field-inline" }, el("span", {}, label), node);
  }

  // Recover the event type + inputs from a stored schedule (uses the saved
  // metadata when present; otherwise infers from the commands for old events).
  function scheduleTypeOf(s) {
    // msgSec defaults to 10 for events saved before the duration was editable —
    // that is exactly what those events were built with.
    if (s.typeId) return { typeId: s.typeId, msgText: s.msgText || "", msgSec: s.msgSec != null ? s.msgSec : 10, pauseMin: s.pauseMin || 0 };
    const cmds = s.commands || [];
    const actions = cmds.map((c) => c.action);
    let typeId = "pause", msgText = "", msgSec = 10, pauseMin = 0;
    if (actions.includes("message")) {
      typeId = "message";
      const m = cmds.find((c) => c.action === "message");
      msgText = (m && m.params && m.params.text) || "";
      if (m && m.params && m.params.hold_sec != null) msgSec = Math.max(0, Math.round(Number(m.params.hold_sec) || 0));
    }
    else if (actions.includes("resume")) typeId = "resume";
    else if (actions.includes("pause")) { typeId = "pause"; const p = cmds.find((c) => c.action === "pause"); pauseMin = p && p.params && p.params.duration_sec ? Math.round(p.params.duration_sec / 60) : 0; }
    else if (actions.includes("unblock_all")) typeId = "unblock";
    else if (actions.includes("minimize_all")) typeId = "minimize_all";
    else if (actions.includes("close_tab")) typeId = "close_tab";
    else if (actions.includes("close_browsers")) typeId = "close_browsers";
    else if (actions.includes("block_app")) { const ba = cmds.find((c) => c.action === "block_app"); typeId = (ba && ba.params && (ba.params.patterns || []).length > 1) ? "block_all" : "block_roblox"; }
    return { typeId, msgText, msgSec, pauseMin };
  }

  function adminSchedules() {
    const body = el("div", {});
    const editing = ui.editingSchedule ? (D.schedules || []).find((s) => s.id === ui.editingSchedule) : null;
    if (ui.editingSchedule && !editing) ui.editingSchedule = null; // event was deleted

    const table = el("table", { class: "sched-table" });
    table.append(
      el("thead", {}, el("tr", {}, el("th", {}, "On"), el("th", {}, "Name"), el("th", {}, "Time"), el("th", {}, "Days"), el("th", {}, "Computers"), el("th", {}, "Does"), el("th", {}, "")))
    );
    const tb = el("tbody", {});
    const schedules = D.schedules || [];
    if (!schedules.length) tb.append(el("tr", {}, el("td", { colspan: "7", class: "empty" }, "No scheduled events yet.")));
    for (const s of schedules) {
      const daysTxt = s.days && s.days.length ? s.days.slice().sort().map((d) => DOW[d]).join(" ") : "Every day";
      const does = [...new Set((s.commands || []).map((c) => {
        const base = ACTION_LABEL[c.action] || c.action;
        if (c.action === "pause" && c.params && c.params.duration_sec > 0) return `${base} ${Math.round(c.params.duration_sec / 60)}m`;
        return base;
      }))].join(", ");
      tb.append(
        el(
          "tr",
          {},
          el("td", {}, el("input", { type: "checkbox", checked: s.enabled, onchange: (e) => org({ op: "updateSchedule", id: s.id, enabled: e.target.checked }) })),
          el("td", {}, s.name),
          el("td", {}, s.time),
          el("td", {}, daysTxt),
          el("td", {}, targetsLabel(s)),
          el("td", {}, does),
          el(
            "td",
            { class: "row-actions" },
            el("button", { class: "btn ghost sm" + (ui.editingSchedule === s.id ? " primary" : ""), onclick: () => { ui.editingSchedule = ui.editingSchedule === s.id ? null : s.id; render(); } }, "Edit"),
            el("button", { class: "btn ghost sm danger", onclick: () => modalConfirm(`Delete event “${s.name}”?`, { title: "Delete event", danger: true, okText: "Delete" }).then((ok) => ok && (ui.editingSchedule === s.id && (ui.editingSchedule = null), org({ op: "deleteSchedule", id: s.id }))) }, "Delete")
          )
        )
      );
    }
    table.append(tb);
    body.append(table);

    // add / edit form (pre-filled when editing an existing event)
    const et0 = editing ? scheduleTypeOf(editing) : { typeId: EVENT_TYPES[0].id, msgText: "", pauseMin: 0 };
    const nameI = el("input", { placeholder: "Event name (e.g. Lunch pause)", value: editing ? editing.name : "" });
    const timeI = el("input", { type: "time", value: editing ? editing.time : "12:00" });
    const dayState = editing && Array.isArray(editing.days) ? editing.days.slice() : [];
    const dayBtns = el("div", { class: "day-toggle" });
    DOW.forEach((d, idx) => {
      const b = el("button", { class: "day-btn" + (dayState.includes(idx) ? " active" : ""), type: "button", onclick: () => {
        b.classList.toggle("active");
        const i = dayState.indexOf(idx);
        if (i >= 0) dayState.splice(i, 1);
        else dayState.push(idx);
      } }, d[0]);
      dayBtns.append(b);
    });
    const targetPicker = buildTargetPicker(editing ? editing.targets : null);
    // Pause-duration field appears only for the Pause event; message field only
    // for the Message event — so the form stays uncluttered.
    const pauseMinI = el("input", { type: "number", min: "0", step: "1", value: String(et0.pauseMin || 0), placeholder: "0 = until Resume" });
    const pauseField = fieldInline("Pause for (min)", pauseMinI);
    const msgI = el("input", { placeholder: "Message text", value: et0.msgText || "" });
    const msgField = fieldInline("Message", msgI);
    const msgSecI = el("input", { type: "number", min: "0", step: "1", value: String(et0.msgSec != null ? et0.msgSec : 10), placeholder: "0 = until dismissed" });
    const msgSecField = fieldInline("Show for (sec)", msgSecI);
    const typeSel = el("select", {
      onchange: () => {
        const et = EVENT_TYPES.find((t) => t.id === typeSel.value);
        pauseField.style.display = et && et.usesPause ? "" : "none";
        msgField.style.display = et && et.usesMsg ? "" : "none";
        msgSecField.style.display = et && et.usesMsgSec ? "" : "none";
      },
    }, ...EVENT_TYPES.map((t) => el("option", { value: t.id, selected: t.id === et0.typeId }, t.label)));
    const submit = () => {
      const targets = targetPicker.getTargets();
      if (!targets.length) return toast("Tick at least one class, building, or campus.");
      const et = EVENT_TYPES.find((t) => t.id === typeSel.value) || EVENT_TYPES[0];
      const opts = {
        text: msgI.value.trim(),
        msgSec: Math.max(0, parseInt(msgSecI.value, 10) || 0),
        pauseMin: Math.max(0, parseInt(pauseMinI.value, 10) || 0),
      };
      const payload = { name: nameI.value.trim() || "Event", time: timeI.value || "12:00", days: dayState.slice(), targets, commands: et.build(opts), typeId: et.id, msgText: opts.text, msgSec: opts.msgSec, pauseMin: opts.pauseMin };
      if (editing) {
        org(Object.assign({ op: "updateSchedule", id: editing.id }, payload));
        ui.editingSchedule = null;
        toast("Scheduled event updated.");
        render();
      } else {
        org(Object.assign({ op: "addSchedule", enabled: true }, payload));
        nameI.value = ""; msgI.value = ""; pauseMinI.value = "0";
        dayState.length = 0; [...dayBtns.children].forEach((c) => c.classList.remove("active"));
        targetPicker.reset();
        toast("Scheduled event added.");
      }
    };
    const submitBtn = el("button", { class: "btn primary sm", onclick: submit }, editing ? "Save changes" : "Add event");
    const cancelBtn = editing ? el("button", { class: "btn ghost sm", onclick: () => { ui.editingSchedule = null; render(); } }, "Cancel") : null;

    body.append(
      el(
        "div",
        { class: "sched-form" + (editing ? " editing" : "") },
        editing ? el("div", { class: "sched-editing-note" }, `Editing “${editing.name}” — change any field and Save.`) : null,
        el("div", { class: "sched-row" }, fieldInline("Name", nameI), fieldInline("Time", timeI)),
        el("div", { class: "sched-row" }, fieldInline("Days (none = every day)", dayBtns)),
        el("div", { class: "sched-row" }, fieldInline("Event", typeSel), pauseField, msgField, msgSecField),
        el("div", { class: "sched-row" }, fieldInline("Applies to (tick any campuses / buildings / classes)", targetPicker.node)),
        el("div", { class: "sched-row" }, submitBtn, cancelBtn)
      )
    );
    // set initial field visibility for the selected event type
    (() => {
      const et = EVENT_TYPES.find((t) => t.id === typeSel.value);
      pauseField.style.display = et && et.usesPause ? "" : "none";
      msgField.style.display = et && et.usesMsg ? "" : "none";
      msgSecField.style.display = et && et.usesMsgSec ? "" : "none";
    })();

    return section("Scheduled events (daily)", body, el("span", { class: "muted small" }, "Runs on the hub clock"));
  }

  function adminOrg() {
    const body = el("div", { class: "org-editor" });

    for (const loc of D.org) {
      const locBox = el("div", { class: "org-loc" });
      const nameInput = el("input", {
        class: "inline-name",
        value: loc.name,
        onchange: (e) => org({ op: "renameLocation", id: loc.id, name: e.target.value.trim() }),
      });
      locBox.append(
        el(
          "div",
          { class: "org-loc-head" },
          el("span", { class: "org-icon" }, "🏫"),
          nameInput,
          el("button", { class: "btn ghost sm danger", onclick: () => confirmDel("location", loc.name, () => org({ op: "deleteLocation", id: loc.id })) }, "Delete")
        )
      );

      for (const b of loc.buildings) {
        const bBox = el("div", { class: "org-bld" });
        bBox.append(
          el(
            "div",
            { class: "org-bld-head" },
            el("span", { class: "org-icon" }, "🏢"),
            el("input", {
              class: "inline-name",
              value: b.name,
              onchange: (e) => org({ op: "renameBuilding", id: b.id, name: e.target.value.trim() }),
            }),
            el("label", { class: "code-field", title: "4-digit instructor code for this building" },
              el("span", {}, "Code"),
              el("input", { class: "code-mini", type: "text", inputmode: "numeric", maxlength: "4", value: b.code || "8676", onchange: (e) => org({ op: "setBuildingCode", id: b.id, code: e.target.value }) })
            ),
            el("span", { class: "reorder" },
              el("button", { class: "btn ghost sm", title: "Move up", onclick: () => org({ op: "moveBuilding", id: b.id, dir: -1 }) }, "▲"),
              el("button", { class: "btn ghost sm", title: "Move down", onclick: () => org({ op: "moveBuilding", id: b.id, dir: 1 }) }, "▼")
            ),
            el("button", { class: "btn ghost sm danger", onclick: () => confirmDel("building", b.name, () => org({ op: "deleteBuilding", id: b.id })) }, "Delete")
          )
        );

        // classes table
        const table = el("table", { class: "cls-table" });
        table.append(
          el(
            "thead",
            {},
            el("tr", {}, el("th", {}, "Class"), el("th", {}, "Instructor"), el("th", {}, "Room"), el("th", {}, "Computers"), el("th", {}, ""))
          )
        );
        const tbody = el("tbody", {});
        for (const cls of b.classes) {
          const count = devicesInClass(cls.id).length;
          tbody.append(
            el(
              "tr",
              {},
              el("td", {}, el("input", { value: cls.name, onchange: (e) => org({ op: "updateClass", id: cls.id, name: e.target.value.trim() }) })),
              el("td", {}, el("input", { value: cls.instructor || "", placeholder: "—", onchange: (e) => org({ op: "updateClass", id: cls.id, instructor: e.target.value.trim() }) })),
              el("td", {}, el("input", { value: cls.room || "", placeholder: "—", onchange: (e) => org({ op: "updateClass", id: cls.id, room: e.target.value.trim() }) })),
              el("td", { class: "num" }, String(count)),
              el(
                "td",
                { class: "row-actions" },
                el("button", { class: "btn ghost sm", title: "Move up", onclick: () => org({ op: "moveClass", id: cls.id, dir: -1 }) }, "▲"),
                el("button", { class: "btn ghost sm", title: "Move down", onclick: () => org({ op: "moveClass", id: cls.id, dir: 1 }) }, "▼"),
                el("button", { class: "btn ghost sm danger", onclick: () => confirmDel("class", cls.name, () => org({ op: "deleteClass", id: cls.id })) }, "Delete")
              )
            )
          );
        }
        // add-class row
        const nName = el("input", { placeholder: "New class name" });
        const nInstr = el("input", { placeholder: "Instructor" });
        const nRoom = el("input", { placeholder: "Room" });
        const addCls = () => {
          if (!nName.value.trim()) return;
          org({ op: "addClass", buildingId: b.id, name: nName.value.trim(), instructor: nInstr.value.trim(), room: nRoom.value.trim() });
        };
        tbody.append(
          el(
            "tr",
            { class: "add-row" },
            el("td", {}, nName),
            el("td", {}, nInstr),
            el("td", {}, nRoom),
            el("td", {}, ""),
            el("td", {}, el("button", { class: "btn primary sm", onclick: addCls }, "Add"))
          )
        );
        table.append(tbody);
        bBox.append(table);
        locBox.append(bBox);
      }

      // add building
      const bName = el("input", { placeholder: "New building name" });
      locBox.append(
        el(
          "div",
          { class: "add-inline" },
          bName,
          el("button", { class: "btn sm", onclick: () => bName.value.trim() && org({ op: "addBuilding", locationId: loc.id, name: bName.value.trim() }) }, "Add building")
        )
      );
      body.append(locBox);
    }

    // add location
    const lName = el("input", { placeholder: "New location name (e.g. MIT)" });
    body.append(
      el(
        "div",
        { class: "add-inline top" },
        lName,
        el("button", { class: "btn primary sm", onclick: () => lName.value.trim() && org({ op: "addLocation", name: lName.value.trim() }) }, "Add location")
      )
    );

    return section("Organization", body);
  }

  const isStale = (d) => !!(d.build && D.currentBuild && d.build !== D.currentBuild);
  // Remote update needs the agent to already understand the `update_agent`
  // command, which shipped in the build below. Older agents (or ones with no
  // build stamp at all) must get one manual install first; after that every
  // future update is one-click. Build stamps start "YYYY-MM-DD …" so the date
  // prefix compares lexically. Keep the "YYYY-MM-DD " prefix in agent BUILD.
  const FIRST_REMOTE_UPDATABLE = "2026-07-28";
  const canRemoteUpdate = (d) => (d.build || "").slice(0, 10) >= FIRST_REMOTE_UPDATABLE;
  // Explain the one-time manual bootstrap for a laptop on a pre-update agent.
  function showManualUpdateHelp(d) {
    const body = el(
      "div",
      {},
      el("p", { class: "modal-msg" }, `“${nameOf(d)}” is running an older agent (${d.build || "unknown version"}) from before remote updates existed, so it can’t be updated from here yet.`),
      el("p", { class: "modal-msg" }, "Do this once on that laptop — after that, every future update is one click from here:"),
      el("ol", { class: "help-steps" },
        el("li", {}, "Download the client with the ⬇ iD-Tech-Watch.zip button (bottom-right)."),
        el("li", {}, "Unzip it on the laptop and run “Start iD Tech Watch.cmd”."),
        el("li", {}, "It restarts on the new agent automatically and keeps the computer’s name/server.")),
      el("p", { class: "modal-hint" }, "You can confirm it worked in C:\\Users\\Student\\projects\\iD-Tech\\watch-client.log (top line shows the build).")
    );
    const m = openModal({ title: "One-time manual update needed", body, actions: [el("button", { class: "btn primary", onclick: () => m.close() }, "Got it")], width: "500px" });
  }
  // A "select all that apply" chip-checkbox group. `selected` is an array that
  // is mutated in place; `onChange` runs after any toggle. An empty selection
  // means "all" (shown as an All chip). Reused for filters and pickers.
  function checkboxGroup(items, selected, onChange, opts) {
    opts = opts || {};
    const wrap = el("div", { class: "chk-group" });
    if (opts.allLabel) {
      wrap.append(
        el(
          "label",
          { class: "chk-chip all" + (!selected.length ? " on" : "") },
          el("input", { type: "checkbox", checked: !selected.length, onchange: () => { selected.length = 0; onChange(); } }),
          el("span", {}, opts.allLabel)
        )
      );
    }
    items.forEach((it) => {
      const on = selected.includes(it.value);
      wrap.append(
        el(
          "label",
          { class: "chk-chip" + (on ? " on" : "") },
          el("input", {
            type: "checkbox",
            checked: on,
            onchange: () => {
              const i = selected.indexOf(it.value);
              if (i >= 0) selected.splice(i, 1);
              else selected.push(it.value);
              onChange();
            },
          }),
          el("span", {}, it.label)
        )
      );
    });
    return wrap;
  }

  function adminComputers() {
    const all = deviceList();
    // ---- filters: multiple houses/buildings (checkboxes) + a status ----
    const flt = (ui.adminDevFilter ||= { buildings: [], status: "" });
    if ("building" in flt) { if (flt.building) flt.buildings = [flt.building]; delete flt.building; } // migrate old single-select
    if (!Array.isArray(flt.buildings)) flt.buildings = [];
    const buildingsFlat = D.org.flatMap((l) => l.buildings.map((b) => ({ id: b.id, name: b.name, loc: l.name })));
    // drop any selected buildings that no longer exist
    flt.buildings = flt.buildings.filter((id) => buildingsFlat.some((b) => b.id === id));
    const buildingChks = checkboxGroup(
      buildingsFlat.map((b) => ({ value: b.id, label: D.org.length > 1 ? `${b.loc} · ${b.name}` : b.name })),
      flt.buildings,
      () => render(),
      { allLabel: "All houses" }
    );
    const statusSel = el(
      "select",
      { class: "filter-sel", onchange: (e) => { flt.status = e.target.value; render(); } },
      ...[["", "All statuses"], ["online", "Online only"], ["offline", "Offline only"], ["stale", "Outdated only"]].map(([v, t]) => el("option", { value: v, selected: flt.status === v }, t))
    );
    let devs = all.slice();
    if (flt.buildings.length) devs = devs.filter((d) => flt.buildings.includes(d.buildingId));
    if (flt.status === "online") devs = devs.filter((d) => d.online);
    else if (flt.status === "offline") devs = devs.filter((d) => !d.online);
    else if (flt.status === "stale") devs = devs.filter(isStale);

    const table = el("table", { class: "dev-table" });
    table.append(
      el("thead", {}, el("tr", {}, el("th", {}, "Computer"), el("th", {}, "Location"), el("th", {}, "Building"), el("th", {}, "Status"), el("th", {}, "Version"), el("th", {}, "Assigned class"), el("th", {}, "")))
    );
    const tbody = el("tbody", {});
    if (!devs.length) tbody.append(el("tr", {}, el("td", { colspan: "7", class: "empty" }, all.length ? "No computers match the filter." : "No computers have checked in yet.")));
    devs
      .sort((a, b) => nameOf(a).toLowerCase().localeCompare(nameOf(b).toLowerCase()))
      .forEach((d) => {
        const loc = locationById(d.locationId);
        const f = buildingById(d.buildingId);
        const classes = f ? f.b.classes : [];
        const stale = isStale(d);
        const canRemote = canRemoteUpdate(d);
        const sel = el(
          "select",
          { onchange: (e) => org({ op: "assign", deviceId: d.device_id, classId: e.target.value || null }) },
          el("option", { value: "", selected: !d.classId }, "— Unassigned —"),
          ...classes.map((c) => el("option", { value: c.id, selected: d.classId === c.id }, c.name))
        );
        const nameInput = el("input", {
          class: "dev-rename",
          value: d.customName || "",
          placeholder: defaultNameOf(d),
          onchange: (e) => rename(d.device_id, e.target.value.trim()),
        });
        let updateBtn;
        if (!canRemote) {
          // pre-remote-update agent (old or no build stamp): can't push remotely;
          // explain the one-time manual bootstrap instead.
          updateBtn = el(
            "button",
            { class: "btn ghost sm warn-outline", title: "This laptop runs an older agent that can't be updated remotely yet — one manual install needed.", onclick: () => showManualUpdateHelp(d) },
            "How to update"
          );
        } else {
          updateBtn = el(
            "button",
            {
              class: "btn ghost sm" + (stale ? " primary" : ""),
              disabled: !d.online,
              title: !d.online ? "Computer is offline" : "Push the latest software and restart this computer (its name/server settings are kept)",
              onclick: () =>
                d.online &&
                modalConfirm(`Update “${nameOf(d)}” to the latest software and restart it now? Its settings (name, server, building) are kept.`, { title: "Update computer", okText: "Update & restart" }).then((ok) => {
                  if (ok) {
                    updateAgent({ scope: "device", deviceId: d.device_id });
                    toast(`Pushing update to ${nameOf(d)}…`);
                  }
                }),
            },
            "Update"
          );
        }
        const removeBtn = el(
          "button",
          {
            class: "btn ghost sm danger",
            title: "Stop monitoring on this computer and remove it from the list",
            onclick: () =>
              modalConfirm(
                `Remove “${nameOf(d)}” from the list? This tells that laptop to stop iD Tech Watch (both processes) and forgets it. It reappears only if someone starts it again.`,
                { title: "Remove computer", danger: true, okText: "Stop & remove" }
              ).then((ok) => {
                if (ok) {
                  removeDevice(d.device_id);
                  toast(`Stopping & removing ${nameOf(d)}…`);
                }
              }),
          },
          "Remove"
        );
        tbody.append(
          el(
            "tr",
            {},
            el("td", {}, el("div", { class: "dev-name" }, el("span", { class: "dot " + (d.online ? "on" : "off") }), nameInput), el("div", { class: "dev-id" }, `${d.hostname} · ${d.device_id}`)),
            el("td", {}, loc ? loc.name : "—"),
            el("td", {}, f ? f.b.name : "—"),
            el("td", {}, el("span", { class: "status " + (d.online ? "on" : "off") }, d.online ? "Online" : agoLabel(d.last_seen))),
            el("td", {}, el("span", { class: "ver" + (stale ? " stale" : "") + (!canRemote ? " manual" : ""), title: d.build || "no build stamp (pre-update agent)" }, !canRemote ? "⚠ update manually" : stale ? "⬆ outdated" : "up to date")),
            el("td", {}, sel),
            el("td", { class: "row-actions" }, updateBtn, removeBtn)
          )
        );
      });
    table.append(tbody);

    const staleRemote = all.filter((d) => d.online && isStale(d) && canRemoteUpdate(d)).length;
    const manualNeeded = all.filter((d) => !canRemoteUpdate(d)).length;
    const updateAllBtn = el(
      "button",
      {
        class: "btn sm" + (staleRemote ? " primary" : ""),
        title: "Push the latest software to every online computer that supports remote update, and restart them (settings kept)",
        onclick: () =>
          modalConfirm("Push the latest software to ALL online computers and restart them now? Each keeps its own settings (name, server, building). Older laptops that need a one-time manual install are skipped automatically.", { title: "Update all computers", okText: "Update all" }).then((ok) => {
            if (ok) {
              updateAgent({ scope: "all" });
              toast("Pushing update to all online computers…");
            }
          }),
      },
      staleRemote ? `⬆ Update all (${staleRemote} outdated)` : "⬆ Update all"
    );
    const actions = el(
      "div",
      { class: "dev-filters" },
      buildingsFlat.length > 1 ? el("div", { class: "filter-field" }, el("span", { class: "filter-label" }, "Houses:"), buildingChks) : null,
      statusSel,
      el("span", { class: "muted small" }, `${onlineCount(devs)}/${devs.length} shown`),
      manualNeeded ? el("span", { class: "muted small manual-note", title: "These run an older agent from before remote updates — install once manually, then they update from here." }, `⚠ ${manualNeeded} need a one-time manual install`) : null,
      auth && auth.role === "admin" ? updateAllBtn : null
    );

    // The hub's expected version, plus a warning when the downloadable install
    // package is older than the software the hub is running. `dist/` is not in
    // git, so pulling on the hub updates the source but leaves the old zip in
    // place — installing that zip would register as outdated straight away.
    const zip = D.clientZip;
    const zipWarn =
      zip && (zip.stale || zip.missing)
        ? el(
            "div",
            { class: "zip-warn" },
            zip.missing
              ? el("div", {}, "⚠ No install package has been built on this hub yet — the Download button will not work.")
              : el(
                  "div",
                  {},
                  el("b", {}, "⚠ The Download package is out of date."),
                  el("div", {}, `It installs build “${zip.packagedBuild || "unknown"}”, but this hub expects “${D.currentBuild}”. Laptops installed from it will still show as outdated.`)
                ),
            el("div", { class: "zip-fix" }, "Fix: on the hub machine run  powershell -File scripts/build-client.ps1  (dist/ is not in git, so git pull does not update the package), then re-download.")
          )
        : null;
    const hubVer = D.currentBuild
      ? el("div", { class: "muted small hub-ver" }, `Hub expects agent build: ${D.currentBuild}`)
      : null;
    return section("Computers", el("div", {}, zipWarn, hubVer, table), actions);
  }

  function adminSettings() {
    const body = el("div", { class: "settings" });

    // admin password
    const p1 = el("input", { type: "password", placeholder: "New admin password" });
    const p2 = el("input", { type: "password", placeholder: "Confirm new password" });
    const savePw = () => {
      if (p1.value.length < 4) return toast("Password must be at least 4 characters.");
      if (p1.value !== p2.value) return toast("Passwords do not match.");
      org({ op: "setAdminPassword", newPassword: p1.value });
      p1.value = p2.value = "";
      toast("Admin password updated.");
    };
    body.append(
      el(
        "div",
        { class: "setting-block" },
        el("h3", {}, "Change admin password"),
        el("div", { class: "setting-row" }, p1, p2, el("button", { class: "btn primary sm", onclick: savePw }, "Update"))
      )
    );

    // Instructor sign-in has no separate code — access is gated per building by
    // each building's 4-digit code (set in the Organization panel above).
    body.append(
      el(
        "div",
        { class: "setting-block" },
        el("h3", {}, "Instructor access"),
        el("p", { class: "muted small" }, "Instructors sign in without a password. Access to each building is controlled by that building's 4-digit code (set per building in Organization).")
      )
    );

    return section("Settings", body);
  }

  function confirmDel(kind, name, fn) {
    modalConfirm(`Delete ${kind} “${name}”? This also removes anything inside it.`, { title: `Delete ${kind}`, danger: true, okText: "Delete" }).then((ok) => ok && fn());
  }

  // ============================================================ deep links / url
  const slug = (s) => encodeURIComponent(String(s || "").trim());
  // Keep the address bar in sync with the current screen so any page is
  // bookmarkable:  /  ·  /admin  ·  /{Location}  ·  /{Location}/{Building}  ·
  //  /{Location}/{Building}/{Class}
  function syncUrl() {
    if (DEMO) return;
    let p = "/";
    if (auth && nav.view === "admin") {
      p = "/admin";
    } else if (auth && nav.view === "monitor") {
      const loc = locationById(nav.locationId);
      const bf = nav.buildingId ? buildingById(nav.buildingId) : null;
      if (loc && bf && nav.classId) {
        const label = nav.classId === UNASSIGNED ? "Unassigned" : (((classById(nav.classId) || {}).c) || {}).name || "";
        p = `/${slug(loc.name)}/${slug(bf.b.name)}/${slug(label)}`;
      } else if (loc && bf) {
        p = `/${slug(loc.name)}/${slug(bf.b.name)}`;
      } else if (loc) {
        p = `/${slug(loc.name)}`;
      }
    }
    if (location.pathname !== p) history.replaceState(null, "", p);
  }
  // Parse the initial URL into nav state (runs once, after first state arrives).
  function applyDeepLink() {
    if (DEMO) return;
    const parts = INITIAL_PATH.split("/").map((s) => decodeURIComponent(s)).filter(Boolean);
    if (!parts.length) return;
    if (parts[0].toLowerCase() === "admin") {
      if (auth && auth.role === "admin") nav.view = "admin";
      return; // non-admins just get their normal view
    }
    const loc = D.org.find((l) => l.name.toLowerCase() === parts[0].toLowerCase());
    if (!loc) return;
    nav.view = "monitor";
    nav.locationId = loc.id;
    if (!parts[1]) return;
    const b = loc.buildings.find((x) => x.name.toLowerCase() === parts[1].toLowerCase());
    if (!b) return;
    // route via "pending" so the building's code gate is still enforced
    nav.pendingBuildingId = b.id;
    if (parts[2]) {
      const seg = parts[2].toLowerCase();
      if (seg === "unassigned") nav.pendingClassId = UNASSIGNED;
      else {
        const c = b.classes.find((x) => x.name.toLowerCase() === seg || (x.instructor || "").toLowerCase() === seg);
        if (c) nav.pendingClassId = c.id;
      }
    }
  }
  // Resolve a pending deep-link building: drill straight in if unlocked/uncoded,
  // else pop its code gate once (cancelling drops back to the building picker).
  function resolvePendingNav() {
    if (!nav.pendingBuildingId || nav.buildingId) return;
    const f = buildingById(nav.pendingBuildingId);
    if (!f) {
      nav.pendingBuildingId = nav.pendingClassId = null;
      return;
    }
    const locked = !DEMO && f.b.code && !ui.unlocked[f.b.id];
    if (!locked) {
      nav.buildingId = f.b.id;
      nav.classId = nav.pendingClassId || null;
      nav.pendingBuildingId = nav.pendingClassId = null;
      autoGatedBuilding = null;
      syncUrl();
    } else if (autoGatedBuilding !== f.b.id) {
      autoGatedBuilding = f.b.id;
      setTimeout(() => openBuildingGate(f.loc, f.b), 0);
    }
  }

  // ---- per-building 4-digit instructor code gate ----
  function openBuildingGate(loc, b) {
    const o = ensureOverlay();
    o.innerHTML = "";
    const input = el("input", { class: "code-input", type: "text", inputmode: "numeric", maxlength: "4", placeholder: "••••", autocomplete: "off" });
    const err = el("div", { class: "code-err" });
    // cancelling the gate drops any pending deep-link so the user isn't trapped
    const cancel = () => {
      nav.pendingBuildingId = nav.pendingClassId = null;
      autoGatedBuilding = null;
      closeOverlay();
    };
    const sheet = el("div", { class: "sheet code-sheet" });
    sheet.addEventListener("click", (e) => e.stopPropagation());
    sheet.append(
      el("div", { class: "sheet-head" }, el("span", { class: "sheet-title" }, `Enter code — ${b.name}`), el("span", { class: "spacer" }), el("button", { class: "btn ghost sm", onclick: cancel }, "✕")),
      el("div", { class: "sheet-sub" }, "Ask your director for this building's 4-digit instructor code."),
      input,
      err
    );
    const tryCode = () => {
      const v = input.value.replace(/\D/g, "");
      input.value = v;
      if (v.length === 4) {
        if (v === String(b.code || "8676")) {
          ui.unlocked[b.id] = true;
          const target = nav.pendingClassId || null; // deep-link may want a class
          nav.pendingBuildingId = nav.pendingClassId = null;
          autoGatedBuilding = null;
          closeOverlay();
          setDrill(loc.id, b.id, target);
        } else {
          err.textContent = "Incorrect code.";
          input.value = "";
          input.classList.add("shake");
          setTimeout(() => input.classList.remove("shake"), 400);
        }
      }
    };
    input.addEventListener("input", tryCode); // auto-submit at 4 digits
    o.append(el("div", { class: "sheet-backdrop", onclick: cancel }), sheet);
    o.classList.add("open");
    setTimeout(() => input.focus(), 30);
  }

  // ==================================================================== demo mode
  const shuffle = (a) => a.slice().sort(() => Math.random() - 0.5);
  function demoDataset() {
    const loc = { id: "d_loc", name: "Demo Campus", buildings: [
      { id: "d_b1", name: "Tresidder", code: "8676", classes: [
        { id: "d_c1", name: "Roblox Game Dev", instructor: "BLEM", room: "Rm 101" },
        { id: "d_c2", name: "Python & AI", instructor: "Marceline", room: "Rm 102" },
      ] },
      { id: "d_b2", name: "TLH", code: "8676", classes: [
        { id: "d_c3", name: "Adobe Art & Animation", instructor: "Green", room: "Rm 5" },
      ] },
    ] };
    D.org = [loc];
    const wins = ["Roblox Studio", "Scratch — Google Chrome", "Visual Studio Code", "Minecraft", "YouTube — Google Chrome", "File Explorer", "Notepad", "Python 3.12 — IDLE", "poki.com — Chrome"];
    const procs = ["chrome", "Code", "python", "RobloxStudioBeta", "explorer", "notepad", "Discord", "steam", "msedge"];
    const names = ["Ava", "Liam", "Noah", "Mia", "Zoe", "Kai", "Leo", "Ivy", "Max", "Ada", "Sam", "Eli", "Nia", "Rex", "Uma"];
    const devices = {};
    let n = 0;
    const make = (bId, cId, count) => {
      for (let i = 0; i < count; i++) {
        const id = `demo-${n + 1}`;
        devices[id] = {
          device_id: id, hostname: `${names[n % names.length]}-PC`, os: "Windows",
          locationId: loc.id, buildingId: bId, classId: cId,
          online: Math.random() > 0.15, last_seen: Date.now() / 1000 - Math.floor(Math.random() * 120),
          windows: shuffle(wins).slice(0, 3 + Math.floor(Math.random() * 3)),
          processes: shuffle(procs).slice(0, 5), blocked: [], blockedSites: [], sitesAvailable: true,
        };
        n++;
      }
    };
    make("d_b1", "d_c1", 6);
    make("d_b1", "d_c2", 5);
    make("d_b2", "d_c3", 4);
    D.devices = devices;
    D.layouts = {};
    D.schedules = [];
    ui.unlocked = { d_b1: true, d_b2: true }; // no code friction in the demo
  }
  function startDemo() {
    auth = { role: "instructor", token: "demo" };
    demoDataset();
    nav.view = "monitor";
    render();
    setInterval(() => {
      if (ui.dragging || busyEditing()) return;
      const ids = Object.keys(D.devices);
      const d = D.devices[ids[Math.floor(Math.random() * ids.length)]];
      if (d) {
        d.last_seen = Date.now() / 1000;
        if (Math.random() < 0.25) d.online = !d.online;
      }
      if (nav.view === "monitor") render();
    }, 4000);
  }
  function demoHandle(obj) {
    if (obj.type === "layout") {
      if (obj.op === "setPosition") (D.layouts[obj.layoutKey] ||= {})[obj.deviceId] = { x: obj.x, y: obj.y };
      else if (obj.op === "resetLayout") {
        delete D.layouts[obj.layoutKey];
        render();
      }
      return;
    }
    if (obj.type === "classrule") {
      const c = classById(obj.classId);
      if (!c) return;
      c.c.blockApps = c.c.blockApps || [];
      const pat = String(obj.pattern || "").toLowerCase().trim();
      if (obj.op === "add" && pat && !c.c.blockApps.includes(pat)) c.c.blockApps.push(pat);
      if (obj.op === "remove") c.c.blockApps = c.c.blockApps.filter((x) => x !== pat);
      render();
      return;
    }
    if (obj.type === "rename") {
      const dev = D.devices[obj.deviceId];
      if (dev) dev.customName = (obj.name || "").trim();
      render();
      return;
    }
    if (obj.type !== "command") return;
    const tgt = obj.target || {};
    const p = obj.params || {};
    const affected = Object.values(D.devices).filter((d) =>
      tgt.scope === "all" ? true :
      tgt.scope === "device" ? d.device_id === tgt.deviceId :
      tgt.scope === "class" ? d.classId === tgt.classId :
      tgt.scope === "building" ? d.buildingId === tgt.buildingId :
      tgt.scope === "location" ? d.locationId === tgt.locationId : false
    );
    const exp = p.duration_sec ? Date.now() / 1000 + p.duration_sec : 0;
    for (const d of affected) {
      if (obj.action === "block_app") for (const pat of [].concat(p.patterns || [], p.pattern || [])) d.blocked.push({ pattern: String(pat).toLowerCase(), expires_at: exp });
      else if (obj.action === "block_site") for (const dom of [].concat(p.domains || [], p.domain || [])) d.blockedSites.push({ domain: String(dom).toLowerCase(), expires_at: exp });
      else if (obj.action === "unblock_all") { d.blocked = []; d.blockedSites = []; }
    }
    toast(`Demo: ${obj.action.replace(/_/g, " ")} → ${affected.length} computer(s)`);
    render();
  }

  // ================================================================== startup
  // live "x ago" + block-countdown ticker — updates just those text nodes in
  // place (no full rebuild), so the grid doesn't flash every second.
  setInterval(() => {
    if (nav.view === "monitor" && nav.classId && !ui.dragging && !busyEditing() && !scrolling()) refreshLiveLabels();
  }, 1000);

  applyTheme(); // set light/dark before first paint

  (async () => {
    if (DEMO) {
      startDemo();
      return;
    }
    // landing on /admin unauthenticated → default the sign-in to the Admin tab
    if (/^\/admin\/?$/i.test(INITIAL_PATH) && !auth) ui.loginRole = "admin";
    await apiPublic();
    if (auth) {
      nav.view = auth.role === "admin" ? "admin" : "monitor";
      connect();
    }
    render();
  })();
})();
