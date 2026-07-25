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
  const ui = { blockDurationSec: 60, loginRole: "instructor", connected: false, monitorMode: "grid", dragging: null, unlocked: {}, expandedProcs: new Set(), classSort: "room", scroll: {}, lastScrollAt: 0, theme: localStorage.getItem("idt_theme") || "light" };

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
  let lastPaintSig = "";
  let paintAnimate = false; // only animate on a real navigation, not live re-renders

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
  const classrule = (op) => send(Object.assign({ type: "classrule" }, op));
  const rename = (deviceId, name) => send({ type: "rename", deviceId, name });
  // display name = the student's name if set, otherwise the machine hostname
  const nameOf = (d) => (d.customName && d.customName.trim() ? d.customName : d.hostname);
  function promptRename(d) {
    const n = prompt(`Rename this computer to the student's name (blank resets to "${d.hostname}"):`, d.customName || "");
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
  function durationControl() {
    const DUR_OPTS = [
      [60, "1 min"], [120, "2 min"], [300, "5 min"], [600, "10 min"],
      [900, "15 min"], [1800, "30 min"], [3600, "1 hour"], [0, "Until lifted"],
    ];
    const inSet = DUR_OPTS.some(([v]) => v === ui.blockDurationSec);
    const label = ui.blockDurationSec ? `${Math.round(ui.blockDurationSec / 60)} min` : "Until lifted";
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
              const m = prompt("Block for how many minutes? (0 = until I lift it)", "5");
              if (m !== null) {
                const mins = parseInt(m, 10);
                if (!Number.isNaN(mins) && mins >= 0) ui.blockDurationSec = mins * 60;
              }
            } else {
              ui.blockDurationSec = parseInt(e.target.value, 10);
            }
            render();
          },
        },
        ...DUR_OPTS.map(([v, t]) => el("option", { value: v, selected: v === ui.blockDurationSec }, t)),
        !inSet ? el("option", { value: ui.blockDurationSec, selected: true }, label) : null,
        el("option", { value: "custom" }, "Custom…")
      )
    );
  }

  const robloxPreset = () => BLOCK_PRESETS.find((p) => p.id === "roblox");
  function blockPreset(dispatch, preset) {
    const dur = ui.blockDurationSec;
    if (preset.apps && preset.apps.length) dispatch("block_app", { patterns: preset.apps, duration_sec: dur });
    if (preset.sites && preset.sites.length) dispatch("block_site", { domains: preset.sites, duration_sec: dur });
    if (preset.closeTabs) dispatch("close_tab", {}); // close the open tab so the block bites now
    toast(`Blocking ${preset.label}${preset.closeTabs ? " (+ closing the open tab)" : ""}.`);
  }
  function blockAllGames(dispatch) {
    const apps = [...new Set(BLOCK_PRESETS.flatMap((p) => p.apps))];
    const sites = [...new Set(BLOCK_PRESETS.flatMap((p) => p.sites))];
    dispatch("block_app", { patterns: apps, duration_sec: ui.blockDurationSec });
    dispatch("block_site", { domains: sites, duration_sec: ui.blockDurationSec });
    dispatch("close_tab", {});
    toast("Blocking all games + gaming sites.");
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
            dispatch("close_tab", {}); // close the open tab so it takes effect immediately
            toast(`Blocking ${n.trim()} (+ closing the open tab).`);
          }
          return;
        }
        if (v === "__closetab__") {
          dispatch("close_tab", {});
          return;
        }
        if (v === "__minimize__") {
          dispatch("minimize_all", {});
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
    const now = el("optgroup", { label: "Do now" });
    now.append(
      el("option", { value: "__closetab__" }, "Close current tab"),
      el("option", { value: "__minimize__" }, "Minimize all windows"),
      el("option", { value: "__closebrowsers__" }, "Close ALL browsers")
    );
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
      ]),
      sched: D.schedules,
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

  function onState() {
    updateConn();
    // don't yank the DOM out from under a seat drag, an open dropdown, or a scroll
    if (nav.view === "monitor") {
      if (!ui.dragging && !busyEditing() && !scrolling()) render();
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
    // global "Block for" duration (applies to every block action), monitor only
    if (nav.view === "monitor") right.append(durationControl());
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
    return section("Select a class", grid, actions);
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

    // class-wide toolbar (block duration lives in the top bar, applies globally)
    const classTargets = () => (isUn ? devs.map((d) => ({ scope: "device", deviceId: d.device_id })) : [{ scope: "class", classId: nav.classId }]);
    const runAll = (action, params) => classTargets().forEach((t) => command(t, action, params));

    const toolbar = el(
      "div",
      { class: "toolbar" },
      el("span", { class: "toolbar-label" }, "Whole class:"),
      el("button", { class: "btn danger", onclick: () => blockPreset(runAll, robloxPreset()) }, "Block Roblox"),
      blockSelect(runAll),
      el("button", { class: "btn", onclick: () => runAll("unblock_all", {}) }, "Unblock all"),
      el("button", { class: "btn", onclick: () => runAll("pause", { text: "Paused by your instructor — eyes up front." }) }, "⏸ Pause"),
      el("button", { class: "btn", onclick: () => runAll("resume", {}) }, "▶ Resume"),
      el("button", { class: "btn danger", onclick: () => promptWarn(runAll, "every screen in this class") }, "⚠ Full-screen…"),
      el("button", { class: "btn", onclick: () => runAll("close_tab", {}) }, "Close tab"),
      el("button", { class: "btn", onclick: () => runAll("minimize_all", {}) }, "Minimize"),
      el("button", { class: "btn", onclick: () => promptMessageTimed(runAll, "every screen in this class") }, "Message class")
    );

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

    // Persistent "always block" apps for this class (real classes only).
    let rulesBar = null;
    if (!isUn && meta) {
      const cls = meta.c;
      const apps = cls.blockApps || [];
      const openApps = [...new Set(devs.flatMap((d) => d.processes || []))].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      const chips = el("div", { class: "rule-chips" });
      if (!apps.length) chips.append(el("span", { class: "muted small" }, "none yet"));
      apps.forEach((p) =>
        chips.append(el("span", { class: "chip rule" }, p, el("button", { class: "chip-x", title: "Remove", onclick: () => classrule({ op: "remove", classId: cls.id, pattern: p }) }, "✕")))
      );
      rulesBar = el(
        "div",
        { class: "rules-bar" },
        el("span", { class: "toolbar-label" }, "Always block for this class:"),
        chips,
        appComboBox(openApps, "Add app (type or pick an open app)…", (v) => classrule({ op: "add", classId: cls.id, pattern: v }))
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
      start = { px: e.clientX, py: e.clientY, moved: false, x: pos.x, y: pos.y, room: node.parentElement.getBoundingClientRect() };
      ui.dragging = { deviceId: d.device_id };
      node.classList.add("dragging");
    });
    node.addEventListener("pointermove", (e) => {
      if (!start) return;
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
        el("span", { class: "sheet-title" }, nameOf(d)),
        el("span", { class: "os" }, d.os),
        el("span", { class: "spacer" }),
        el("button", { class: "btn ghost sm", onclick: () => promptRename(d) }, "✎ Rename"),
        el("button", { class: "btn ghost sm", onclick: closeOverlay }, "✕")
      ),
      el("div", { class: "sheet-sub" }, `${nameOf(d) !== d.hostname ? d.hostname + " · " : ""}${(d.windows || []).length} open window(s) · ${(d.processes || []).length} apps · ${d.online ? "online" : "offline"}`)
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
        el("button", { class: "btn sm danger", onclick: () => promptWarn(dispatch, "this student") }, "⚠ Full-screen…"),
        el("button", { class: "btn sm", onclick: () => command(t, "close_tab", {}) }, "Close tab"),
        el("button", { class: "btn sm", onclick: () => command(t, "minimize_all", {}) }, "Minimize"),
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
        el("span", { class: "hostname", title: nameOf(d) !== d.hostname ? d.hostname : "", ondblclick: () => promptRename(d) }, nameOf(d)),
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

    const winList = trackScroll(el("div", { class: "list windows" }), d.device_id + ":win");
    if (d.windows && d.windows.length) d.windows.forEach((w) => winList.append(el("div", { class: "row" }, w)));
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
        el("button", { class: "btn sm danger", onclick: () => promptWarn(dispatch, "this student") }, "⚠ Full-screen…"),
        el("button", { class: "btn sm", onclick: () => command(t, "close_tab", {}) }, "Close tab"),
        el("button", { class: "btn sm", onclick: () => command(t, "minimize_all", {}) }, "Minimize"),
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
    promptMessageTimed((a, p) => command(t, a, p), "the student screen");
  }
  // Full-screen message that the student can't dismiss until a hold timer elapses
  // (then the OK button unlocks). `runner(action, params)` sends it. Default 10s.
  function promptMessageTimed(runner, where) {
    const txt = prompt(`Full-screen message to show on ${where}:`);
    if (!txt || !txt.trim()) return;
    const secStr = prompt("Lock it on screen for how many seconds before they can click OK? (0 = OK right away)", "10");
    if (secStr === null) return;
    const secs = parseInt(secStr, 10);
    runner("message", { text: txt.trim(), timeout_sec: Number.isNaN(secs) || secs < 0 ? 10 : secs });
  }
  // Full-screen warning: covers the screen and reopens if the student closes it,
  // until the instructor hits Resume. `runner(action, params)` sends it.
  function promptWarn(runner, where) {
    const txt = prompt(`Full-screen warning for ${where} (stays until you press Resume):`, "Eyes up front, please.");
    if (txt && txt.trim()) runner("pause", { text: txt.trim() });
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
    { id: "minimize_all", label: "Minimize all windows", build: () => [{ action: "minimize_all" }] },
    { id: "close_tab", label: "Close current tab", build: () => [{ action: "close_tab" }] },
    { id: "close_browsers", label: "Close all browsers", build: () => [{ action: "close_browsers" }] },
    { id: "unblock", label: "Unblock everything", build: () => [{ action: "unblock_all" }] },
    { id: "message", label: "Full-screen message (10s hold)", build: (text) => [{ action: "message", params: { text: text || "", timeout_sec: 10 } }] },
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
  function buildTargetPicker() {
    const wrap = el("div", { class: "target-picker" });
    const scopeSel = el(
      "select",
      { class: "target-scope" },
      el("option", { value: "all" }, "Everyone — all campuses"),
      el("option", { value: "location" }, "Whole campus…"),
      el("option", { value: "building" }, "Specific buildings…"),
      el("option", { value: "class" }, "Specific classes…")
    );
    const list = el("div", { class: "target-list" });
    let boxes = [];
    function rebuild() {
      list.innerHTML = "";
      boxes = [];
      const scope = scopeSel.value;
      if (scope === "all") {
        list.append(el("div", { class: "muted small" }, "Runs on every computer at every campus."));
        return;
      }
      const add = (label, target) => {
        const cb = el("input", { type: "checkbox" });
        boxes.push({ cb, target });
        list.append(el("label", { class: "target-chip" }, cb, el("span", {}, label)));
      };
      if (scope === "location") for (const loc of D.org) add(`📍 ${loc.name}`, { scope: "location", locationId: loc.id });
      else if (scope === "building") for (const loc of D.org) for (const b of loc.buildings) add(`🏢 ${b.name}`, { scope: "building", buildingId: b.id });
      else for (const loc of D.org) for (const b of loc.buildings) for (const c of b.classes) add(`💻 ${b.name} · ${c.name}`, { scope: "class", classId: c.id });
      if (!boxes.length) list.append(el("div", { class: "muted small" }, "Nothing at this level yet."));
    }
    scopeSel.addEventListener("change", rebuild);
    rebuild();
    wrap.append(scopeSel, list);
    return {
      node: wrap,
      getTargets: () => (scopeSel.value === "all" ? [{ scope: "all" }] : boxes.filter((x) => x.cb.checked).map((x) => x.target)),
      reset: () => { scopeSel.value = "all"; rebuild(); },
    };
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
          el("td", {}, targetsLabel(s)),
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
    const targetPicker = buildTargetPicker();
    const typeSel = el("select", {}, ...EVENT_TYPES.map((t) => el("option", { value: t.id }, t.label)));
    const msgI = el("input", { placeholder: "Message text (only for “Show a message”)" });
    const addBtn = el("button", { class: "btn primary sm", onclick: () => {
      const targets = targetPicker.getTargets();
      if (!targets.length) return toast("Tick at least one class, building, or campus.");
      const et = EVENT_TYPES.find((t) => t.id === typeSel.value) || EVENT_TYPES[0];
      org({ op: "addSchedule", name: nameI.value.trim() || "Event", time: timeI.value || "12:00", days: dayState.slice(), targets, commands: et.build(msgI.value.trim()), enabled: true });
      nameI.value = "";
      msgI.value = "";
      dayState.length = 0;
      [...dayBtns.children].forEach((c) => c.classList.remove("active"));
      targetPicker.reset();
      toast("Scheduled event added.");
    } }, "Add event");

    body.append(
      el(
        "div",
        { class: "sched-form" },
        el("div", { class: "sched-row" }, fieldInline("Name", nameI), fieldInline("Time", timeI)),
        el("div", { class: "sched-row" }, fieldInline("Days (none = every day)", dayBtns)),
        el("div", { class: "sched-row" }, fieldInline("Event", typeSel), fieldInline("Message", msgI)),
        el("div", { class: "sched-row" }, fieldInline("Applies to (tick any campuses / buildings / classes)", targetPicker.node)),
        el("div", { class: "sched-row" }, addBtn)
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

  function adminComputers() {
    const devs = deviceList();
    const table = el("table", { class: "dev-table" });
    table.append(
      el("thead", {}, el("tr", {}, el("th", {}, "Computer"), el("th", {}, "Location"), el("th", {}, "Building"), el("th", {}, "Status"), el("th", {}, "Assigned class")))
    );
    const tbody = el("tbody", {});
    if (!devs.length) tbody.append(el("tr", {}, el("td", { colspan: "5", class: "empty" }, "No computers have checked in yet.")));
    devs
      .sort((a, b) => nameOf(a).toLowerCase().localeCompare(nameOf(b).toLowerCase()))
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
        const nameInput = el("input", {
          class: "dev-rename",
          value: d.customName || "",
          placeholder: d.hostname,
          onchange: (e) => rename(d.device_id, e.target.value.trim()),
        });
        tbody.append(
          el(
            "tr",
            {},
            el("td", {}, el("div", { class: "dev-name" }, el("span", { class: "dot " + (d.online ? "on" : "off") }), nameInput), el("div", { class: "dev-id" }, `${d.hostname} · ${d.device_id}`)),
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
    if (confirm(`Delete ${kind} “${name}”? This also removes anything inside it.`)) fn();
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
  // live "x ago" ticker — grid monitor only (skip canvas/drags & admin inputs)
  setInterval(() => {
    if (nav.view === "monitor" && nav.classId && ui.monitorMode === "grid" && !ui.dragging && !busyEditing() && !scrolling()) render();
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
