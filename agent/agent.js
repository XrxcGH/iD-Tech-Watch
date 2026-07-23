#!/usr/bin/env node
/*
 * iD Tech Classroom Monitor — student-laptop agent (Node.js, zero dependencies).
 *
 * Copy this single file onto each class laptop (Node 18+; uses the built-in
 * global WebSocket client, stable in Node 22+). It connects to the classroom
 * hub, reports open windows + running apps, and carries out instructor commands:
 * close/block apps (Roblox, Minecraft, Steam, …) and block websites (poki.com …).
 *
 * TRANSPARENCY / RESPONSIBLE USE
 * ------------------------------
 * Intended for camp-managed laptops in a supervised classroom. It is NOT covert:
 * it prints what it does and shows an on-screen notice. Students (and parents,
 * per iD Tech policy) should be told these laptops are monitored. It reports
 * window titles and app names only — no keystrokes, screenshots, or camera.
 *
 * NOTE: blocking *websites* edits the system hosts file, which requires the
 * agent to run elevated (Administrator on Windows / root on macOS). Blocking
 * *apps* works without elevation. See --keep-awake to stop the laptop sleeping.
 *
 * Usage:
 *   node agent.js --server ws://SERVER_IP:8765 \
 *       --location "Stanford" --building "Gates Computer Science" [--keep-awake]
 */

"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

const ENFORCE_INTERVAL_MS = 2000; // how often to sweep the blocklists
const STATUS_INTERVAL_DEFAULT = 4; // seconds between status reports
const MAX_PROCESSES = 400;

// hosts-file website blocking
const HOSTS_PATH =
  process.env.IDT_HOSTS_PATH ||
  (IS_WIN
    ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "drivers", "etc", "hosts")
    : "/etc/hosts");
const HOSTS_BEGIN = "# >>> iD Tech Classroom Monitor >>>";
const HOSTS_END = "# <<< iD Tech Classroom Monitor <<<";

// pattern/domain -> expiry (ms epoch, 0 = until explicitly unblocked)
const appBlocks = new Map();
const siteBlocks = new Map();
let sitesAvailable = true; // did the last hosts write succeed?
let lastAppliedSites = null; // signature of the last hosts write
let awakeChild = null; // keep-awake helper process
let pauseChild = null; // full-screen "paused" overlay process
let pauseActive = false; // true while paused (overlay reopens if student closes it)
let pauseMessage = ""; // text shown on the pause overlay

// Browser process names used by "close browsers" (to clear an already-open tab
// that a hosts block can't retroactively close).
const BROWSER_NAMES = IS_MAC
  ? ["Google Chrome", "Safari", "firefox", "Microsoft Edge", "Opera", "Brave Browser", "Vivaldi"]
  : ["msedge", "chrome", "firefox", "opera", "brave", "vivaldi", "iexplore"];

function log(msg) {
  console.log(`[agent] ${msg}`);
}

function osName() {
  if (IS_WIN) return "Windows";
  if (IS_MAC) return "Darwin";
  return process.platform;
}

function stableDeviceId(explicit) {
  if (explicit) return explicit;
  const ifaces = os.networkInterfaces();
  let mac = "";
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.mac && ni.mac !== "00:00:00:00:00:00" && !ni.internal) {
        mac = ni.mac;
        break;
      }
    }
    if (mac) break;
  }
  return `${os.hostname()}-${mac.replace(/:/g, "")}`;
}

// -------------------------------------------------------------- shell helper
function run(cmd, args, timeoutMs = 6000) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (_err, stdout) => resolve(stdout ? stdout.toString() : "")
    );
  });
}

// ---------------------------------------------------------------- inspection
async function inspect() {
  const processes = new Set();
  const windows = new Set();

  if (IS_WIN) {
    // One fast PowerShell call emitting "<ProcessName>\t<MainWindowTitle>" per
    // process. (`tasklist /v` is reliable but painfully slow on some machines.)
    const out = await run("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      'Get-Process | ForEach-Object { $_.ProcessName + "`t" + $_.MainWindowTitle }',
    ]);
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const tab = line.indexOf("\t");
      const name = (tab === -1 ? line : line.slice(0, tab)).trim();
      const title = (tab === -1 ? "" : line.slice(tab + 1)).trim();
      if (name) processes.add(name);
      if (title) windows.add(title);
    }
  } else {
    const psOut = await run("ps", ["-axco", "comm"]);
    for (const line of psOut.split(/\r?\n/)) {
      const name = line.trim();
      if (name && name !== "COMM") processes.add(name);
    }
    if (IS_MAC) {
      const script =
        'tell application "System Events" to get the title of ' +
        "every window of (every process whose visible is true)";
      const w = await run("osascript", ["-e", script]);
      for (const chunk of w.split(",")) {
        const t = chunk.trim();
        if (t) windows.add(t);
      }
    }
  }

  return {
    processes: [...processes].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).slice(0, MAX_PROCESSES),
    windows: [...windows].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
  };
}

// Terminate every process whose name contains `pattern` (case-insensitive).
async function killMatching(pattern) {
  const pat = (pattern || "").toLowerCase().trim();
  if (!pat) return [];
  const killed = [];
  if (IS_WIN) {
    // Restrict the pattern to safe characters before interpolating into PS.
    const safe = pat.replace(/[^a-z0-9 ._-]/gi, "");
    if (!safe) return killed;
    const out = await run("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$p = Get-Process | Where-Object { $_.ProcessName -like '*${safe}*' }; ` +
        `$p | ForEach-Object { $_.ProcessName }; ` +
        `$p | Stop-Process -Force -ErrorAction SilentlyContinue`,
    ]);
    for (const line of out.split(/\r?\n/)) {
      const n = line.trim();
      if (n) killed.push(n);
    }
  } else {
    // -i = case-insensitive, -f = match against full argument list
    await run("pkill", ["-if", pat]);
    killed.push(pat);
  }
  return killed;
}

// A pop-up message. Optional timeoutSec auto-closes it (a centered, top-most
// window with an OK button + optional auto-dismiss timer).
function showMessage(text, timeoutSec) {
  text = text || "";
  timeoutSec = Number(timeoutSec) || 0;
  log(`instructor message: ${text}${timeoutSec ? ` (auto-close ${timeoutSec}s)` : ""}`);
  try {
    if (IS_WIN) {
      const safe = text.replace(/'/g, "''");
      const timeoutMs = timeoutSec > 0 ? Math.round(timeoutSec * 1000) : 0;
      const ps =
        "Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase; " +
        "$w=New-Object System.Windows.Window; $w.Title='iD Tech Instructor'; $w.SizeToContent='WidthAndHeight'; " +
        "$w.WindowStartupLocation='CenterScreen'; $w.Topmost=$true; $w.ResizeMode='NoResize'; " +
        "$sp=New-Object System.Windows.Controls.StackPanel; $sp.Margin='24'; " +
        "$t=New-Object System.Windows.Controls.TextBlock; $t.Text='" + safe + "'; $t.FontSize=20; " +
        "$t.TextWrapping='Wrap'; $t.MaxWidth=520; $t.Margin='0,0,0,16'; " +
        "$b=New-Object System.Windows.Controls.Button; $b.Content='OK'; $b.Width=90; $b.HorizontalAlignment='Right'; " +
        "$b.Add_Click({ $w.Close() }); $sp.Children.Add($t)|Out-Null; $sp.Children.Add($b)|Out-Null; $w.Content=$sp; " +
        (timeoutMs > 0
          ? "$tm=New-Object System.Windows.Threading.DispatcherTimer; $tm.Interval=[TimeSpan]::FromMilliseconds(" +
            timeoutMs +
            "); $tm.Add_Tick({ $tm.Stop(); $w.Close() }); $w.Add_Loaded({ $tm.Start() }); "
          : "") +
        "[void]$w.ShowDialog();";
      execFile("powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], { windowsHide: true }, () => {});
    } else if (IS_MAC) {
      const safe = text.replace(/"/g, '\\"');
      const giveUp = timeoutSec > 0 ? ` giving up after ${Math.round(timeoutSec)}` : "";
      execFile("osascript", ["-e", `display dialog "${safe}" with title "iD Tech Instructor" buttons {"OK"}${giveUp}`], () => {});
    }
  } catch (_) {
    /* best effort */
  }
}

// ------------------------------------------------------- website (hosts) block
function normalizeDomain(d) {
  return String(d || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "");
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripHostsSection(text) {
  const re = new RegExp(`\\r?\\n?${escapeRe(HOSTS_BEGIN)}[\\s\\S]*?${escapeRe(HOSTS_END)}\\r?\\n?`, "g");
  return text.replace(re, "\n");
}

function flushDns() {
  if (IS_WIN) execFile("ipconfig", ["/flushdns"], { windowsHide: true }, () => {});
  else if (IS_MAC)
    execFile("sh", ["-c", "dscacheutil -flushcache; killall -HUP mDNSResponder"], () => {});
}

// Rewrite the hosts file so it blocks exactly the domains passed in.
function applyHostsBlock(domains) {
  let existing = "";
  try {
    existing = fs.readFileSync(HOSTS_PATH, "utf8");
  } catch (_) {
    existing = "";
  }
  let out = stripHostsSection(existing).replace(/\s*$/, "");
  if (domains.length) {
    const lines = [HOSTS_BEGIN];
    for (const d of domains) {
      lines.push(`0.0.0.0 ${d}`);
      lines.push(`0.0.0.0 www.${d}`);
    }
    lines.push(HOSTS_END);
    out += "\r\n" + lines.join("\r\n") + "\r\n";
  } else {
    out += "\r\n";
  }
  try {
    fs.writeFileSync(HOSTS_PATH, out);
    if (!sitesAvailable) log("website blocking is now active (hosts file writable).");
    sitesAvailable = true;
    flushDns();
    return true;
  } catch (_) {
    if (sitesAvailable)
      log("WARNING: cannot edit hosts file — run the agent as Administrator to block websites.");
    sitesAvailable = false;
    return false;
  }
}

function cleanupHosts() {
  try {
    const existing = fs.readFileSync(HOSTS_PATH, "utf8");
    const cleaned = stripHostsSection(existing);
    if (cleaned !== existing) fs.writeFileSync(HOSTS_PATH, cleaned);
  } catch (_) {
    /* ignore */
  }
}

// ---------------------------------------------------------------- blocklists
function activeAppBlocks() {
  const now = Date.now();
  for (const [pat, exp] of appBlocks)
    if (exp && exp < now) {
      appBlocks.delete(pat);
      log(`app block expired: ${pat}`);
    }
  return appBlocks;
}

function activeSiteBlocks() {
  const now = Date.now();
  for (const [dom, exp] of siteBlocks)
    if (exp && exp < now) {
      siteBlocks.delete(dom);
      log(`site block expired: ${dom}`);
    }
  return siteBlocks;
}

function enforceSites() {
  const domains = [...activeSiteBlocks().keys()].sort();
  const sig = domains.join(",");
  if (sig !== lastAppliedSites) {
    applyHostsBlock(domains);
    lastAppliedSites = sig;
    if (domains.length) log(`blocking sites: ${domains.join(", ")}`);
  }
}

async function enforce() {
  for (const pat of [...activeAppBlocks().keys()]) {
    const killed = await killMatching(pat);
    if (killed.length && IS_WIN) log(`blocked '${pat}' -> killed ${killed.join(", ")}`);
  }
  enforceSites();
}

// ------------------------------------------------------------------- status
async function sendStatus(ws) {
  const { processes, windows } = await inspect();
  const blocked = [...activeAppBlocks()].map(([pattern, exp]) => ({
    pattern,
    expires_at: exp ? exp / 1000 : 0,
  }));
  const blockedSites = [...activeSiteBlocks()].map(([domain, exp]) => ({
    domain,
    expires_at: exp ? exp / 1000 : 0,
  }));
  ws.send(JSON.stringify({ type: "status", windows, processes, blocked, blockedSites, sitesAvailable }));
}

// ------------------------------------------------------------------ commands
function collectPatterns(p) {
  const arr = [];
  if (p.pattern) arr.push(String(p.pattern).toLowerCase().trim());
  if (Array.isArray(p.patterns)) for (const x of p.patterns) arr.push(String(x).toLowerCase().trim());
  return [...new Set(arr.filter(Boolean))];
}
function collectDomains(p) {
  const arr = [];
  if (p.domain) arr.push(normalizeDomain(p.domain));
  if (Array.isArray(p.domains)) for (const x of p.domains) arr.push(normalizeDomain(x));
  return [...new Set(arr.filter(Boolean))];
}

async function handleCommand(ws, msg) {
  const action = msg.action;
  const p = msg.params || {};
  const expiry = p.duration_sec ? Date.now() + p.duration_sec * 1000 : 0;

  if (action === "kill_process") {
    const killed = await killMatching(p.pattern || "");
    log(`close app '${p.pattern}' -> ${killed.join(", ") || "(none)"}`);
  } else if (action === "block_app") {
    const pats = collectPatterns(p);
    for (const pat of pats) appBlocks.set(pat, expiry);
    for (const pat of pats) await killMatching(pat);
    if (pats.length) log(`blocking apps: ${pats.join(", ")} (${p.duration_sec ? p.duration_sec + "s" : "until lifted"})`);
  } else if (action === "unblock_app") {
    for (const pat of collectPatterns(p)) appBlocks.delete(pat);
  } else if (action === "block_site") {
    const doms = collectDomains(p);
    for (const d of doms) siteBlocks.set(d, expiry);
    enforceSites();
  } else if (action === "unblock_site") {
    for (const d of collectDomains(p)) siteBlocks.delete(d);
    enforceSites();
  } else if (action === "unblock_all") {
    appBlocks.clear();
    siteBlocks.clear();
    enforceSites();
    log("all blocks cleared");
  } else if (action === "close_browsers") {
    await closeBrowsers();
  } else if (action === "pause") {
    pauseScreen(p.text);
  } else if (action === "resume") {
    resumeScreen();
  } else if (action === "message") {
    showMessage(p.text || "", p.timeout_sec);
  } else if (action === "list_now") {
    await sendStatus(ws);
  } else {
    log(`unknown command: ${action}`);
  }
}

// ------------------------------------------------------------------ keep awake
function keepAwake() {
  try {
    if (IS_WIN) {
      // ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED
      const script =
        "$sig='[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint e);'; " +
        "$t=Add-Type -MemberDefinition $sig -Name Power -Namespace Win32 -PassThru; " +
        "while($true){ [void]$t::SetThreadExecutionState(0x80000041); Start-Sleep -Seconds 30 }";
      awakeChild = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else if (IS_MAC) {
      awakeChild = spawn("caffeinate", ["-dimsu"], { stdio: "ignore" });
    }
    if (awakeChild) {
      awakeChild.unref();
      log("keep-awake enabled (system will not sleep while the agent runs).");
    }
  } catch (_) {
    /* best effort */
  }
}

// ------------------------------------------------------------ close browsers
async function closeBrowsers() {
  for (const b of BROWSER_NAMES) await killMatching(b);
  log("closed browsers");
}

// -------------------------------------------------------------- pause / resume
// A full-screen, always-on-top overlay so students stop and look up. It stays
// until the instructor resumes, and REOPENS if the student closes it. It is not
// an OS lock (an admin could Task-Manager out of it) — deliberately transparent,
// meant for a supervised classroom.
function pauseScreen(text) {
  pauseMessage = text || "Paused by your instructor — eyes up front.";
  pauseActive = true;
  if (!IS_WIN) {
    if (pauseChild) return;
    const safe = pauseMessage.replace(/"/g, '\\"');
    pauseChild = spawn(
      "osascript",
      ["-e", `repeat\n display dialog "${safe}" with title "iD Tech" buttons {"OK"} giving up after 3\n end repeat`],
      { stdio: "ignore" }
    );
    pauseChild.on("exit", () => {
      pauseChild = null;
      if (pauseActive) setTimeout(spawnPauseWindow, 400);
    });
    return;
  }
  spawnPauseWindow();
  log("screen paused");
}

function spawnPauseWindow() {
  if (pauseChild || !pauseActive) return;
  if (!IS_WIN) return pauseScreen(pauseMessage);
  const safe = pauseMessage.replace(/'/g, "''");
  const ps =
    "Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase; " +
    "$w=New-Object System.Windows.Window; $w.WindowStyle='None'; $w.WindowState='Maximized'; " +
    "$w.Topmost=$true; $w.ResizeMode='NoResize'; " +
    "$w.Background=(New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromRgb(0,0,0))); " +
    "$t=New-Object System.Windows.Controls.TextBlock; $t.Text='" + safe + "'; " +
    "$t.Foreground=(New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromRgb(148,214,10))); " +
    "$t.FontSize=44; $t.FontWeight='Bold'; $t.TextWrapping='Wrap'; $t.TextAlignment='Center'; " +
    "$t.HorizontalAlignment='Center'; $t.VerticalAlignment='Center'; $t.Margin='40'; " +
    "$w.Content=$t; $w.Add_Loaded({ $w.Activate() }); [void]$w.ShowDialog();";
  pauseChild = spawn("powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], {
    windowsHide: true,
    stdio: "ignore",
  });
  pauseChild.on("exit", () => {
    pauseChild = null;
    // student closed it but instructor hasn't resumed — bring it back
    if (pauseActive) setTimeout(spawnPauseWindow, 400);
  });
}

function resumeScreen() {
  pauseActive = false;
  if (pauseChild) {
    try {
      pauseChild.kill();
    } catch (_) {}
    pauseChild = null;
    log("screen resumed");
  }
}

// --------------------------------------------------------------- exit cleanup
function killHelpers() {
  pauseActive = false; // don't let the overlay respawn during shutdown
  try {
    if (awakeChild) awakeChild.kill();
  } catch (_) {}
  try {
    if (pauseChild) pauseChild.kill();
  } catch (_) {}
}
function cleanupAndExit(code) {
  cleanupHosts();
  killHelpers();
  process.exit(code);
}
process.on("exit", () => {
  cleanupHosts();
  killHelpers();
});
process.on("SIGINT", () => cleanupAndExit(0));
process.on("SIGTERM", () => cleanupAndExit(0));

// --------------------------------------------------------------------- args
function parseArgs() {
  const a = {
    server: null,
    location: "Stanford", // stable physical campus
    building: "Main Building", // stable physical building
    klass: "", // optional first-setup hint; class is normally managed by admin
    device: null,
    token: process.env.IDT_ENROLL_TOKEN || "",
    interval: STATUS_INTERVAL_DEFAULT,
    keepAwake: false,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === "--server") (a.server = val), i++;
    else if (key === "--location") (a.location = val), i++;
    else if (key === "--building") (a.building = val), i++;
    else if (key === "--class") (a.klass = val), i++;
    else if (key === "--device") (a.device = val), i++;
    else if (key === "--token") (a.token = val), i++;
    else if (key === "--interval") (a.interval = parseFloat(val)), i++;
    else if (key === "--keep-awake") a.keepAwake = true;
  }
  if (!a.server) {
    console.error(
      "Usage: node agent.js --server ws://SERVER_IP:8765 " +
        '--location "Stanford" --building "Gates Computer Science" [--class "Rm 101"] [--keep-awake]'
    );
    process.exit(1);
  }
  return a;
}

// ------------------------------------------------------------------- runtime
function main() {
  const args = parseArgs();
  const deviceId = stableDeviceId(args.device);

  if (typeof WebSocket === "undefined") {
    console.error(
      "This Node version lacks a global WebSocket client (needs Node 22+). " +
        "Upgrade Node, or ask for the `ws`-based variant."
    );
    process.exit(1);
  }

  log(`id=${deviceId}`);
  log(
    `location=${JSON.stringify(args.location)} building=${JSON.stringify(args.building)}` +
      (args.klass ? ` class-hint=${JSON.stringify(args.klass)}` : "")
  );
  log("MONITORING ACTIVE — this laptop is managed by an iD Tech instructor.");
  if (args.keepAwake) keepAwake();

  // Enforce blocks on a steady cadence, independent of connectivity.
  setInterval(() => {
    enforce().catch(() => {});
  }, ENFORCE_INTERVAL_MS);

  function connect() {
    const url = args.server.replace(/\/+$/, "") + "/ws/agent";
    log(`connecting to ${url}`);
    const ws = new WebSocket(url);
    let statusTimer = null;

    ws.onopen = () => {
      log("connected.");
      ws.send(
        JSON.stringify({
          type: "register",
          device_id: deviceId,
          hostname: os.hostname(),
          os: osName(),
          location: args.location,
          building: args.building,
          klass: args.klass,
          token: args.token || "",
        })
      );
      sendStatus(ws).catch(() => {});
      statusTimer = setInterval(() => sendStatus(ws).catch(() => {}), args.interval * 1000);
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (_) {
        return;
      }
      if (msg.type === "command") handleCommand(ws, msg).catch(() => {});
    };

    ws.onclose = () => {
      if (statusTimer) clearInterval(statusTimer);
      log("disconnected; retrying in 5s");
      setTimeout(connect, 5000);
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch (_) {
        /* ignore */
      }
    };
  }

  connect();
}

main();
