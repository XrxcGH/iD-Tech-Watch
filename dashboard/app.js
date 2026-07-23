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

  // ------------------------------------------------------------------ state
  const D = { org: [], devices: {}, layouts: {}, schedules: [], instructorCodeRequired: false };
  const nav = { view: "login", locationId: null, buildingId: null, classId: null };
  const ui = { blockDurationSec: 60, loginRole: "instructor", connected: false, monitorMode: "grid", dragging: null, unlocked: {} };
  // /demo runs a self-contained simulated classroom (no hub, no login).
  const DEMO = location.pathname.replace(/\/+$/, "").toLowerCase() === "/demo";
  let deepLinkDone = false;
  let auth = JSON.parse(localStorage.getItem("idt_auth") || "null"); // {token, role}
  let ws = null;
  let lastAdminSig = "";

  const UNASSIGNED = "__unassigned__";

  // Quick-block catalog: each preset blocks matching app process names and/or
  // websites (via the hosts file on the agent). App matches are case-insensitive
  // substrings. "minecraft" catches the launcher + Bedrock; Java edition runs as
  // javaw.exe (block "javaw" manually only if your camp doesn't use Java).
  const BLOCK_PRESETS = [
    { id: "roblox", label: "Roblox", apps: ["roblox"], sites: ["roblox.com"] },
    { id: "minecraft", label: "Minecraft", apps: ["minecraft"], sites: ["minecraft.net", "classic.minecraft.net"] },
    { id: "fortnite", label: "Fortnite", apps: ["fortnite"], sites: [] },
    { id: "steam", label: "Steam", apps: ["steam"], sites: ["steampowered.com", "steamcommunity.com"] },
    { id: "epic", label: "Epic Games", apps: ["epicgames", "fortnite"], sites: ["epicgames.com"] },
    {
      id: "gamesites",
      label: "Gaming websites (Poki, Coolmath…)",
      apps: [],
      sites: ["poki.com", "coolmathgames.com", "crazygames.com", "miniclip.com", "y8.com", "addictinggames.com", "kongregate.com", "armorgames.com", "friv.com", "gamejolt.com"],
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
        D.instructorCodeRequired = msg.instructorCodeRequired;
        if (!deepLinkDone) {
          deepLinkDone = true;
          applyDeepLink();
        }
        onState();
      } else if (msg.type === "ack") {
        toast(`Command sent to ${msg.sent} computer(s).`);
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

  // ---- blocking helpers (dispatch(action, params) sends to the right target) ----
  const robloxPreset = () => BLOCK_PRESETS.find((p) => p.id === "roblox");
  function blockPreset(dispatch, preset) {
    const dur = ui.blockDurationSec;
    if (preset.apps && preset.apps.length) dispatch("block_app", { patterns: preset.apps, duration_sec: dur });
    if (preset.sites && preset.sites.length) dispatch("block_site", { domains: preset.sites, duration_sec: dur });
    toast(`Blocking ${preset.label}.`);
  }
  function blockAllGames(dispatch) {
    const apps = [...new Set(BLOCK_PRESETS.flatMap((p) => p.apps))];
    const sites = [...new Set(BLOCK_PRESETS.flatMap((p) => p.sites))];
    dispatch("block_app", { patterns: apps, duration_sec: ui.blockDurationSec });
    dispatch("block_site", { domains: sites, duration_sec: ui.blockDurationSec });
    toast("Blocking all common games + gaming sites.");
  }
  // A compact "Block…" dropdown usable at class or device scope.
  function blockSelect(dispatch) {
    const sel = el("select", {
      class: "block-select",
      onchange: (e) => {
        const v = e.target.value;
        e.target.value = "";
        if (!v) return;
        if (v === "__all__") return blockAllGames(dispatch);
        if (v === "__app__") {
          const n = prompt("Block which app? (name or part of it, e.g. steam)");
          if (n && n.trim()) dispatch("block_app", { pattern: n.trim(), duration_sec: ui.blockDurationSec });
          return;
        }
        if (v === "__site__") {
          const n = prompt("Block which website? (e.g. poki.com)");
          if (n && n.trim()) {
            dispatch("block_site", { domain: n.trim(), duration_sec: ui.blockDurationSec });
            if (confirm("Also close open browser tabs now so it shuts immediately?\n(Closes ALL browser windows on the computer.)"))
              dispatch("close_browsers", {});
          }
          return;
        }
        if (v === "__closebrowsers__") {
          if (confirm("Close ALL browser windows now? This closes every open tab on the target computer(s)."))
            dispatch("close_browsers", {});
          return;
        }
        const preset = BLOCK_PRESETS.find((p) => p.id === v);
        if (preset) blockPreset(dispatch, preset);
      },
    });
    sel.append(el("option", { value: "" }, "🚫 Block…"));
    const games = el("optgroup", { label: "Games & sites" });
    BLOCK_PRESETS.forEach((p) => games.append(el("option", { value: p.id }, p.label)));
    games.append(el("option", { value: "__all__" }, "— All games + sites —"));
    const custom = el("optgroup", { label: "Custom" });
    custom.append(el("option", { value: "__app__" }, "Custom app…"), el("option", { value: "__site__" }, "Custom website…"));
    const now = el("optgroup", { label: "Close open tabs now" });
    now.append(el("option", { value: "__closebrowsers__" }, "Close all browsers"));
    sel.append(games, custom, now);
    return sel;
  }

  function logout() {
    setAuth(null);
    try {
      ws && ws.close();
    } catch (_) {}
    ws = null;
    nav.view = "login";
    render();
  }

  // -------------------------------------------------------- selective rerender
  function adminSig() {
    return JSON.stringify({
      org: D.org,
      devs: deviceList().map((d) => [
        d.device_id,
        d.hostname,
        d.locationId,
        d.buildingId,
        d.classId,
      ]),
      code: D.instructorCodeRequired,
    });
  }
  // True while the user is mid-interaction with a form control — re-rendering
  // then would rip an open <select> dropdown or a focused field out from under
  // them (this was closing the Block menus during the beta).
  function busyEditing() {
    const a = document.activeElement;
    return !!(a && ["INPUT", "SELECT", "TEXTAREA", "OPTION"].includes(a.tagName));
  }

  function onState() {
    updateConn();
    // don't yank the DOM out from under a seat drag or an open dropdown
    if (nav.view === "monitor") {
      if (!ui.dragging && !busyEditing()) render();
    } else if (nav.view === "admin") {
      if (!busyEditing() && adminSig() !== lastAdminSig) render();
    }
  }

  // ================================================================== views
  function render() {
    const app = document.getElementById("app");
    app.innerHTML = "";
    if (!auth || nav.view === "login") {
      app.append(renderLogin());
      return;
    }
    app.append(renderShell(nav.view === "admin" ? renderAdmin() : renderMonitor()));
    if (nav.view === "admin") lastAdminSig = adminSig();
  }

  function brand() {
    return el(
      "div",
      { class: "brand" },
      el("span", { class: "logo" }, "iD"),
      el(
        "div",
        {},
        el("div", { class: "brand-title" }, "Classroom Monitor"),
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
    right.append(
      el("span", { class: "role-badge " + auth.role }, auth.role === "admin" ? "Admin" : "Instructor"),
      connDot(),
      !DEMO ? el("button", { class: "btn ghost sm", onclick: logout }, "Sign out") : null
    );
    n6.append(right);
    // fixed download button (bottom-right), styled like the Monitor button
    const download = el(
      "a",
      { class: "download-fab", href: "/download/id-tech-watch.exe", title: "Download the iD Tech Watch client (.exe)" },
      "⬇ Client .exe"
    );
    wrap.append(n6, el("main", { class: "content" }, content), download);
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
    let passwordInput, codeInput;
    if (ui.loginRole === "admin") {
      passwordInput = el("input", { type: "password", placeholder: "Admin password", autofocus: true });
      fields.append(labeled("Admin password", passwordInput));
    } else {
      if (D.instructorCodeRequired) {
        codeInput = el("input", { type: "text", placeholder: "Access code from your admin", autofocus: true });
        fields.append(labeled("Instructor access code", codeInput));
      } else {
        fields.append(
          el("p", { class: "login-hint" }, "No access code required — click Continue to view your classes.")
        );
      }
    }

    async function submit() {
      err.textContent = "";
      try {
        await login(
          ui.loginRole,
          passwordInput ? passwordInput.value : undefined,
          codeInput ? codeInput.value : undefined
        );
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
        el("div", { class: "login-brand" }, el("span", { class: "logo big" }, "iD"), el("h1", {}, "Classroom Monitor")),
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

  function pickerLocations() {
    const grid = el("div", { class: "tiles" });
    if (!D.org.length) grid.append(emptyNote("No locations yet. Ask an admin to add one, or start an agent."));
    for (const loc of D.org) {
      const devs = devicesInLocation(loc.id);
      grid.append(
        tile(loc.name, "🏫", [
          `${loc.buildings.length} building(s)`,
          `${onlineCount(devs)}/${devs.length} online`,
        ], () => setDrill(loc.id, null, null))
      );
    }
    return section("Select a location", grid);
  }

  function pickerBuildings() {
    const loc = locationById(nav.locationId);
    const grid = el("div", { class: "tiles" });
    if (!loc || !loc.buildings.length) grid.append(emptyNote("No buildings in this location yet."));
    for (const b of loc ? loc.buildings : []) {
      const devs = devicesInBuilding(b.id);
      const locked = !DEMO && b.code && !ui.unlocked[b.id];
      grid.append(
        tile(
          b.name,
          locked ? "🔒" : "🏢",
          [`${b.classes.length} class(es)`, `${onlineCount(devs)}/${devs.length} online`, locked ? "Code required" : ""].filter(Boolean),
          () => (locked ? openBuildingGate(loc, b) : setDrill(nav.locationId, b.id, null))
        )
      );
    }
    return section("Select a building", grid);
  }

  function pickerClasses() {
    const f = buildingById(nav.buildingId);
    const grid = el("div", { class: "tiles" });
    const classes = f ? f.b.classes : [];
    for (const c of classes) {
      const devs = devicesInClass(c.id);
      grid.append(
        tile(
          c.name,
          "💻",
          [c.instructor ? `👤 ${c.instructor}` : "No instructor set", c.room || "", `${onlineCount(devs)}/${devs.length} online`].filter(Boolean),
          () => setDrill(nav.locationId, nav.buildingId, c.id)
        )
      );
    }
    const un = f ? unassignedInBuilding(f.b.id) : [];
    if (un.length)
      grid.append(
        tile("Unassigned computers", "❓", [`${onlineCount(un)}/${un.length} online`, "Not yet in a class"], () =>
          setDrill(nav.locationId, nav.buildingId, UNASSIGNED)
        )
      );
    if (!classes.length && !un.length)
      grid.append(emptyNote("No classes here yet. An admin can add one in the Admin panel."));
    return section("Select a class", grid);
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

    // class-wide toolbar
    const DUR_OPTS = [
      [60, "1 min"],
      [300, "5 min"],
      [600, "10 min"],
      [900, "15 min"],
      [1800, "30 min"],
      [0, "Until lifted"],
    ];
    const inSet = DUR_OPTS.some(([v]) => v === ui.blockDurationSec);
    const durSel = el(
      "select",
      {
        onchange: (e) => {
          if (e.target.value === "custom") {
            const m = prompt("Block for how many minutes? (0 = until I lift it)", "1");
            if (m !== null) {
              const mins = parseInt(m, 10);
              if (!Number.isNaN(mins) && mins >= 0) ui.blockDurationSec = mins * 60;
            }
            render();
            return;
          }
          ui.blockDurationSec = parseInt(e.target.value, 10);
        },
      },
      ...DUR_OPTS.map(([v, t]) => el("option", { value: v, selected: v === ui.blockDurationSec }, t)),
      !inSet ? el("option", { value: ui.blockDurationSec, selected: true }, `${Math.round(ui.blockDurationSec / 60)} min`) : null,
      el("option", { value: "custom" }, "Custom…")
    );

    const classTargets = () => (isUn ? devs.map((d) => ({ scope: "device", deviceId: d.device_id })) : [{ scope: "class", classId: nav.classId }]);
    const runAll = (action, params) => classTargets().forEach((t) => command(t, action, params));

    const toolbar = el(
      "div",
      { class: "toolbar" },
      el("span", { class: "toolbar-label" }, "Whole class:"),
      el("label", { class: "dur" }, "Block for ", durSel),
      el("button", { class: "btn danger", onclick: () => blockPreset(runAll, robloxPreset()) }, "Block Roblox"),
      blockSelect(runAll),
      el("button", { class: "btn", onclick: () => runAll("unblock_all", {}) }, "Unblock all"),
      el("button", { class: "btn", onclick: () => runAll("pause", { text: "Paused by your instructor — eyes up front." }) }, "⏸ Pause"),
      el("button", { class: "btn", onclick: () => runAll("resume", {}) }, "▶ Resume"),
      el(
        "button",
        {
          class: "btn",
          onclick: () => {
            const t = prompt("Message to show on every screen in this class:");
            if (t && t.trim()) runAll("message", { text: t.trim() });
          },
        },
        "Message class"
      )
    );

    const sorted = devs.slice().sort((a, b) => a.hostname.toLowerCase().localeCompare(b.hostname.toLowerCase()));
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

    return el("div", { class: "class-monitor" }, header, toolbar, body);
  }

  // ---- seating canvas ----
  function getPos(layoutKey, d, i, total) {
    const saved = (D.layouts[layoutKey] || {})[d.device_id];
    if (saved && typeof saved.x === "number") return saved;
    // default: tidy grid inside the room so nothing overlaps at the corner
    const cols = Math.max(1, Math.ceil(Math.sqrt(total)));
    const rows = Math.max(1, Math.ceil(total / cols));
    const col = i % cols;
    const row = Math.floor(i / cols);
    return { x: 0.12 + ((col + 0.5) / cols) * 0.76, y: 0.2 + ((row + 0.5) / rows) * 0.72 };
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

    const bar = el(
      "div",
      { class: "canvas-bar" },
      el("span", { class: "muted small" }, "Drag each computer to match where the student sits. Tap one to control it."),
      el("span", { class: "spacer" }),
      el("button", { class: "btn ghost sm", onclick: () => resetLayout(layoutKey) }, "Reset layout")
    );
    return el("div", { class: "room-wrap" }, bar, room);
  }

  function seatNode(d, pos, layoutKey) {
    const blockedCount = (d.blocked || []).length + (d.blockedSites || []).length;
    const node = el(
      "div",
      { class: "seat" + (d.online ? "" : " offline") },
      el("span", { class: "seat-dot " + (d.online ? "on" : "off") }),
      el("div", { class: "seat-screen" }, "💻"),
      el("div", { class: "seat-name" }, d.hostname),
      blockedCount ? el("span", { class: "seat-badge" }, "⛔ " + blockedCount) : null
    );
    node.style.left = pos.x * 100 + "%";
    node.style.top = pos.y * 100 + "%";

    let start = null;
    node.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      try {
        node.setPointerCapture(e.pointerId);
      } catch (_) {}
      start = { px: e.clientX, py: e.clientY, moved: false, x: pos.x, y: pos.y, room: node.parentElement.getBoundingClientRect() };
      ui.dragging = { deviceId: d.device_id };
      node.classList.add("dragging");
    });
    node.addEventListener("pointermove", (e) => {
      if (!start) return;
      let x = (e.clientX - start.room.left) / start.room.width;
      let y = (e.clientY - start.room.top) / start.room.height;
      x = Math.max(0.03, Math.min(0.97, x));
      y = Math.max(0.08, Math.min(0.95, y));
      if (Math.hypot(e.clientX - start.px, e.clientY - start.py) > 6) start.moved = true;
      start.x = x;
      start.y = y;
      node.style.left = x * 100 + "%";
      node.style.top = y * 100 + "%";
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
    const o = document.getElementById("overlay");
    if (o) {
      o.classList.remove("open");
      o.innerHTML = "";
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
        el("span", { class: "sheet-title" }, d.hostname),
        el("span", { class: "os" }, d.os),
        el("span", { class: "spacer" }),
        el("button", { class: "btn ghost sm", onclick: closeOverlay }, "✕")
      ),
      el("div", { class: "sheet-sub" }, `${(d.windows || []).length} open window(s) · ${(d.processes || []).length} apps · ${d.online ? "online" : "offline"}`)
    );

    const left = (exp) => (exp > 0 ? ` (${Math.max(0, Math.round(exp - Date.now() / 1000))}s)` : "");
    if ((d.blocked || []).length || (d.blockedSites || []).length) {
      const chips = el("div", { class: "chips" });
      (d.blocked || []).forEach((b) => chips.append(el("span", { class: "chip" }, `⛔ ${b.pattern}${left(b.expires_at)}`)));
      (d.blockedSites || []).forEach((b) => chips.append(el("span", { class: "chip site" }, `🌐 ${b.domain}${left(b.expires_at)}`)));
      sheet.append(chips);
    }

    if ((d.windows || []).length) {
      const list = el("div", { class: "list windows" });
      d.windows.forEach((w) => list.append(el("div", { class: "row" }, w)));
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
        el("button", { class: "btn sm", onclick: () => promptMessage(t) }, "Message…"),
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

  function deviceCard(d) {
    const card = el("div", { class: "card" + (d.online ? "" : " offline") });
    card.append(
      el(
        "div",
        { class: "card-head" },
        el("span", { class: "dot " + (d.online ? "on" : "off") }),
        el("span", { class: "hostname" }, d.hostname),
        el("span", { class: "os" }, d.os),
        el("span", { class: "seen" }, d.online ? "online" : agoLabel(d.last_seen))
      )
    );

    const left = (exp) => (exp > 0 ? ` (${Math.max(0, Math.round(exp - Date.now() / 1000))}s)` : "");
    if ((d.blocked && d.blocked.length) || (d.blockedSites && d.blockedSites.length)) {
      const chips = el("div", { class: "chips" });
      (d.blocked || []).forEach((b) => chips.append(el("span", { class: "chip" }, `⛔ ${b.pattern}${left(b.expires_at)}`)));
      (d.blockedSites || []).forEach((b) => chips.append(el("span", { class: "chip site" }, `🌐 ${b.domain}${left(b.expires_at)}`)));
      card.append(chips);
      if (d.blockedSites && d.blockedSites.length && d.sitesAvailable === false)
        card.append(el("div", { class: "warn" }, "⚠ Website blocks need the agent to run as Administrator on this computer."));
    }

    const winList = el("div", { class: "list windows" });
    if (d.windows && d.windows.length) d.windows.forEach((w) => winList.append(el("div", { class: "row" }, w)));
    else winList.append(el("div", { class: "row muted" }, d.online ? "—" : "offline"));
    card.append(
      el("div", { class: "list-wrap" }, el("div", { class: "list-title" }, `Open windows (${(d.windows || []).length})`), winList)
    );

    const procList = el("div", { class: "list procs" });
    (d.processes || []).forEach((p) => procList.append(el("div", { class: "row" }, p)));
    card.append(
      el("details", { class: "apps" }, el("summary", {}, `Running apps (${(d.processes || []).length})`), procList)
    );

    const t = { scope: "device", deviceId: d.device_id };
    const dispatch = (action, params) => command(t, action, params);
    card.append(
      el(
        "div",
        { class: "actions" },
        el("button", { class: "btn danger sm", onclick: () => blockPreset(dispatch, robloxPreset()) }, "Block Roblox"),
        blockSelect(dispatch),
        el("button", { class: "btn sm", onclick: () => promptKill(t) }, "Close app…"),
        el("button", { class: "btn sm", onclick: () => command(t, "unblock_all", {}) }, "Unblock all"),
        el("button", { class: "btn sm", onclick: () => command(t, "pause", { text: "Paused by your instructor — eyes up front." }) }, "⏸ Pause"),
        el("button", { class: "btn sm", onclick: () => command(t, "resume", {}) }, "▶ Resume"),
        el("button", { class: "btn sm", onclick: () => promptMessage(t) }, "Message…"),
        el("button", { class: "btn sm ghost", onclick: () => command(t, "list_now", {}) }, "Refresh")
      )
    );
    return card;
  }

  function promptKill(t) {
    const n = prompt("Close which app? (name or part of it, e.g. chrome, steam)");
    if (n && n.trim()) command(t, "kill_process", { pattern: n.trim() });
  }
  function promptMessage(t) {
    const txt = prompt("Message to show on the student screen:");
    if (txt && txt.trim()) command(t, "message", { text: txt.trim() });
  }

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
  const EVENT_TYPES = [
    { id: "pause", label: "Pause computers (full-screen)", build: () => [{ action: "pause", params: { text: "Paused by your instructor — eyes up front." } }] },
    { id: "resume", label: "Resume (end pause)", build: () => [{ action: "resume" }] },
    { id: "block_roblox", label: "Block Roblox", build: () => [{ action: "block_app", params: { patterns: ["roblox"] } }, { action: "block_site", params: { domains: ["roblox.com"] } }] },
    { id: "block_all", label: "Block all games + sites", build: () => [{ action: "block_app", params: { patterns: allApps() } }, { action: "block_site", params: { domains: allSites() } }] },
    { id: "close_browsers", label: "Close all browsers", build: () => [{ action: "close_browsers" }] },
    { id: "unblock", label: "Unblock everything", build: () => [{ action: "unblock_all" }] },
    { id: "message", label: "Show a message", build: (text) => [{ action: "message", params: { text: text || "" } }] },
  ];
  const ACTION_LABEL = { pause: "Pause", resume: "Resume", block_app: "Block apps", block_site: "Block sites", unblock_all: "Unblock", close_browsers: "Close browsers", message: "Message", kill_process: "Close app" };

  function targetFromVal(v) {
    return v === "all" ? { scope: "all" } : { scope: "class", classId: v };
  }
  function targetLabel(tg) {
    if (!tg || tg.scope === "all") return "All computers";
    if (tg.scope === "class") {
      const f = classById(tg.classId);
      return f ? `${f.loc.name} / ${f.b.name} / ${f.c.name}` : "(deleted class)";
    }
    return tg.scope;
  }
  function classTargetOptions(sel) {
    const opts = [el("option", { value: "all", selected: sel === "all" }, "All computers")];
    for (const loc of D.org) for (const b of loc.buildings) for (const c of b.classes)
      opts.push(el("option", { value: c.id, selected: sel === c.id }, `${loc.name} / ${b.name} / ${c.name}`));
    return opts;
  }
  function fieldInline(label, node) {
    return el("label", { class: "field-inline" }, el("span", {}, label), node);
  }

  function adminSchedules() {
    const body = el("div", {});

    const table = el("table", { class: "sched-table" });
    table.append(
      el("thead", {}, el("tr", {}, el("th", {}, "On"), el("th", {}, "Name"), el("th", {}, "Time"), el("th", {}, "Days"), el("th", {}, "Computers"), el("th", {}, "Does"), el("th", {}, "")))
    );
    const tb = el("tbody", {});
    const schedules = D.schedules || [];
    if (!schedules.length) tb.append(el("tr", {}, el("td", { colspan: "7", class: "empty" }, "No scheduled events yet.")));
    for (const s of schedules) {
      const daysTxt = s.days && s.days.length ? s.days.slice().sort().map((d) => DOW[d]).join(" ") : "Every day";
      const does = [...new Set((s.commands || []).map((c) => ACTION_LABEL[c.action] || c.action))].join(", ");
      tb.append(
        el(
          "tr",
          {},
          el("td", {}, el("input", { type: "checkbox", checked: s.enabled, onchange: (e) => org({ op: "updateSchedule", id: s.id, enabled: e.target.checked }) })),
          el("td", {}, s.name),
          el("td", {}, s.time),
          el("td", {}, daysTxt),
          el("td", {}, targetLabel(s.target)),
          el("td", {}, does),
          el("td", {}, el("button", { class: "btn ghost sm danger", onclick: () => confirm(`Delete event “${s.name}”?`) && org({ op: "deleteSchedule", id: s.id }) }, "Delete"))
        )
      );
    }
    table.append(tb);
    body.append(table);

    // add form
    const nameI = el("input", { placeholder: "Event name (e.g. Lunch pause)" });
    const timeI = el("input", { type: "time", value: "12:00" });
    const dayState = [];
    const dayBtns = el("div", { class: "day-toggle" });
    DOW.forEach((d, idx) => {
      const b = el("button", { class: "day-btn", type: "button", onclick: () => {
        b.classList.toggle("active");
        const i = dayState.indexOf(idx);
        if (i >= 0) dayState.splice(i, 1);
        else dayState.push(idx);
      } }, d[0]);
      dayBtns.append(b);
    });
    const targetSel = el("select", {}, ...classTargetOptions("all"));
    const typeSel = el("select", {}, ...EVENT_TYPES.map((t) => el("option", { value: t.id }, t.label)));
    const msgI = el("input", { placeholder: "Message text (only for “Show a message”)" });
    const addBtn = el("button", { class: "btn primary sm", onclick: () => {
      const et = EVENT_TYPES.find((t) => t.id === typeSel.value) || EVENT_TYPES[0];
      org({ op: "addSchedule", name: nameI.value.trim() || "Event", time: timeI.value || "12:00", days: dayState.slice(), target: targetFromVal(targetSel.value), commands: et.build(msgI.value.trim()), enabled: true });
      nameI.value = "";
      msgI.value = "";
      dayState.length = 0;
      [...dayBtns.children].forEach((c) => c.classList.remove("active"));
      toast("Scheduled event added.");
    } }, "Add event");

    body.append(
      el(
        "div",
        { class: "sched-form" },
        el("div", { class: "sched-row" }, fieldInline("Name", nameI), fieldInline("Time", timeI)),
        el("div", { class: "sched-row" }, fieldInline("Days (none = every day)", dayBtns)),
        el("div", { class: "sched-row" }, fieldInline("Computers", targetSel), fieldInline("Event", typeSel)),
        el("div", { class: "sched-row" }, fieldInline("Message", msgI), addBtn)
      )
    );

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
              el("td", {}, el("button", { class: "btn ghost sm danger", onclick: () => confirmDel("class", cls.name, () => org({ op: "deleteClass", id: cls.id })) }, "Delete"))
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

  function adminComputers() {
    const devs = deviceList();
    const table = el("table", { class: "dev-table" });
    table.append(
      el("thead", {}, el("tr", {}, el("th", {}, "Computer"), el("th", {}, "Location"), el("th", {}, "Building"), el("th", {}, "Status"), el("th", {}, "Assigned class")))
    );
    const tbody = el("tbody", {});
    if (!devs.length) tbody.append(el("tr", {}, el("td", { colspan: "5", class: "empty" }, "No computers have checked in yet.")));
    devs
      .sort((a, b) => a.hostname.toLowerCase().localeCompare(b.hostname.toLowerCase()))
      .forEach((d) => {
        const loc = locationById(d.locationId);
        const f = buildingById(d.buildingId);
        const classes = f ? f.b.classes : [];
        const sel = el(
          "select",
          { onchange: (e) => org({ op: "assign", deviceId: d.device_id, classId: e.target.value || null }) },
          el("option", { value: "", selected: !d.classId }, "— Unassigned —"),
          ...classes.map((c) => el("option", { value: c.id, selected: d.classId === c.id }, c.name))
        );
        tbody.append(
          el(
            "tr",
            {},
            el("td", {}, el("div", { class: "dev-name" }, el("span", { class: "dot " + (d.online ? "on" : "off") }), d.hostname), el("div", { class: "dev-id" }, d.device_id)),
            el("td", {}, loc ? loc.name : "—"),
            el("td", {}, f ? f.b.name : "—"),
            el("td", {}, el("span", { class: "status " + (d.online ? "on" : "off") }, d.online ? "Online" : agoLabel(d.last_seen))),
            el("td", {}, sel)
          )
        );
      });
    table.append(tbody);
    return section("Computers", table, el("span", { class: "muted small" }, `${onlineCount(devs)}/${devs.length} online`));
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

    // instructor code
    const codeInput = el("input", { type: "text", placeholder: D.instructorCodeRequired ? "•••••• (set)" : "Leave blank to disable" });
    const saveCode = () => {
      org({ op: "setInstructorCode", code: codeInput.value.trim() });
      toast(codeInput.value.trim() ? "Instructor access code set." : "Instructor access code disabled.");
      codeInput.value = "";
    };
    body.append(
      el(
        "div",
        { class: "setting-block" },
        el("h3", {}, "Instructor access code"),
        el("p", { class: "muted small" }, D.instructorCodeRequired ? "A code is currently required for instructors to sign in." : "Instructors can currently sign in without a code."),
        el("div", { class: "setting-row" }, codeInput, el("button", { class: "btn sm", onclick: saveCode }, "Save"))
      )
    );

    return section("Settings", body);
  }

  function confirmDel(kind, name, fn) {
    if (confirm(`Delete ${kind} “${name}”? This also removes anything inside it.`)) fn();
  }

  // ============================================================ deep links / url
  const slug = (s) => encodeURIComponent(String(s || "").trim());
  function syncUrl() {
    if (DEMO) return;
    let p = "/";
    if (nav.view === "monitor" && nav.classId && nav.classId !== UNASSIGNED) {
      const meta = classById(nav.classId);
      if (meta) {
        const who = meta.c.instructor && meta.c.instructor.trim() ? meta.c.instructor : meta.c.name;
        p = `/${slug(meta.loc.name)}/${slug(who)}`;
      }
    }
    if (location.pathname !== p) history.replaceState(null, "", p);
  }
  function applyDeepLink() {
    if (DEMO) return;
    const parts = location.pathname.split("/").map((s) => decodeURIComponent(s)).filter(Boolean);
    if (parts.length < 2) return;
    const [locName, who] = parts;
    const loc = D.org.find((l) => l.name.toLowerCase() === locName.toLowerCase());
    if (!loc) return;
    for (const b of loc.buildings)
      for (const c of b.classes)
        if ((c.instructor && c.instructor.toLowerCase() === who.toLowerCase()) || c.name.toLowerCase() === who.toLowerCase()) {
          nav.view = "monitor";
          nav.locationId = loc.id;
          nav.buildingId = b.id;
          nav.classId = c.id;
          ui.unlocked[b.id] = true; // a direct link implies they know their class
          return;
        }
    nav.view = "monitor";
    nav.locationId = loc.id; // matched a location but not the instructor
  }

  // ---- per-building 4-digit instructor code gate ----
  function openBuildingGate(loc, b) {
    const o = ensureOverlay();
    o.innerHTML = "";
    const input = el("input", { class: "code-input", type: "text", inputmode: "numeric", maxlength: "4", placeholder: "••••", autocomplete: "off" });
    const err = el("div", { class: "code-err" });
    const sheet = el("div", { class: "sheet code-sheet" });
    sheet.addEventListener("click", (e) => e.stopPropagation());
    sheet.append(
      el("div", { class: "sheet-head" }, el("span", { class: "sheet-title" }, `Enter code — ${b.name}`), el("span", { class: "spacer" }), el("button", { class: "btn ghost sm", onclick: closeOverlay }, "✕")),
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
          closeOverlay();
          setDrill(loc.id, b.id, null);
        } else {
          err.textContent = "Incorrect code.";
          input.value = "";
          input.classList.add("shake");
          setTimeout(() => input.classList.remove("shake"), 400);
        }
      }
    };
    input.addEventListener("input", tryCode); // auto-submit at 4 digits
    o.append(el("div", { class: "sheet-backdrop", onclick: closeOverlay }), sheet);
    o.classList.add("open");
    setTimeout(() => input.focus(), 30);
  }

  // ==================================================================== demo mode
  const shuffle = (a) => a.slice().sort(() => Math.random() - 0.5);
  function demoDataset() {
    const loc = { id: "d_loc", name: "Demo Campus", buildings: [
      { id: "d_b1", name: "Tresidder", code: "8676", classes: [
        { id: "d_c1", name: "Roblox Game Dev", instructor: "Ada Lovelace", room: "Rm 101" },
        { id: "d_c2", name: "Python & AI", instructor: "Alan Turing", room: "Rm 102" },
      ] },
      { id: "d_b2", name: "Huang Engineering", code: "8676", classes: [
        { id: "d_c3", name: "Minecraft Modding", instructor: "Grace Hopper", room: "Rm 5" },
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
  // live "x ago" ticker — grid monitor only (skip canvas/drags & admin inputs)
  setInterval(() => {
    if (nav.view === "monitor" && nav.classId && ui.monitorMode === "grid" && !ui.dragging && !busyEditing()) render();
  }, 1000);

  (async () => {
    if (DEMO) {
      startDemo();
      return;
    }
    await apiPublic();
    if (auth) {
      nav.view = auth.role === "admin" ? "admin" : "monitor";
      connect();
    }
    render();
  })();
})();
