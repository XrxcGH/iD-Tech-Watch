#!/usr/bin/env node
/*
 * iD Tech Watch — resilient launcher/watchdog for the classroom agent.
 *
 * TRANSPARENT BY DESIGN (for supervised, camp-managed laptops):
 *   - Runs two cooperating processes that watch each other. If either is closed,
 *     the other relaunches it. Neither hides from Task Manager.
 *   - To stop BOTH: run "Stop iD Tech Watch.cmd" in the install folder (it just
 *     drops a stop.flag that both processes watch for).
 *
 * On first launch it:
 *   1. Ensures  C:\Users\Student\projects\iD-Tech\  exists (creates it if not).
 *   2. Installs the scripts + signed node.exe there (self-contained after USB).
 *   3. Starts both; each restarts the other if it exits, until stop.flag appears.
 *
 * Ships as a folder/zip run on Microsoft-signed node.exe (no packed-binary AV
 * flag), NOT a pkg .exe. Config (hub URL etc.) comes from a first-run dialog, or
 * a watch-config.json next to it, or CLI flags / env.
 *
 * Run modes (argv[2]): (none)=launcher, "client", "guardian".
 *   node.exe watch.js --server ws://IP:8765 --location "Stanford" --building "Tresidder"
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const APP_NAME = "iD Tech Watch";
const DIR = process.env.IDT_WATCH_DIR || "C:\\Users\\Student\\projects\\iD-Tech";
const STOP_FLAG = path.join(DIR, "stop.flag");
const CONFIG_FILE = path.join(DIR, "watch-config.json");
const IS_WIN = process.platform === "win32";
const HUB_PORT = 8765;
// Fallback hub used if none is found by scanning the LAN. SET THIS to the PKP
// hub's address so a copied client "just works" with no typing.
const DEFAULT_SERVER = process.env.IDT_DEFAULT_SERVER || "ws://10.0.0.10:8765";

// Detect whether we're a compiled single-exe (pkg / Node SEA) or plain node.
// The SEA check uses an indirect require so bundlers don't try to resolve it.
const PACKAGED =
  !!process.pkg ||
  (() => {
    try {
      const req = eval("require");
      return req("node:sea").isSea();
    } catch (_) {
      return false;
    }
  })();

const ROLE = process.argv[2] === "client" || process.argv[2] === "guardian" ? process.argv[2] : "launcher";

function log(msg) {
  console.log(`[watch:${ROLE}] ${msg}`);
}
function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}
function pidFile(role) {
  return path.join(DIR, `${role}.pid`);
}
function writePid(role) {
  try {
    fs.writeFileSync(pidFile(role), String(process.pid));
  } catch (_) {}
}
function readPid(role) {
  try {
    return parseInt(fs.readFileSync(pidFile(role), "utf8"), 10) || 0;
  } catch (_) {
    return 0;
  }
}
function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but not permitted = alive
  }
}
function stopRequested() {
  return fs.existsSync(STOP_FLAG);
}

// ---- how to (re)launch a role, in either exe or node mode ----------------
function binForRole(role) {
  // In exe mode we run two copies of the exe; in node mode two script copies.
  if (PACKAGED) return path.join(DIR, role === "guardian" ? `${APP_NAME} (reopener).exe` : `${APP_NAME}.exe`);
  return path.join(DIR, role === "guardian" ? "id-tech-watch.js" : "id-tech-watch.js");
}
// Prefer the signed node.exe we install alongside the scripts, so the whole
// thing runs on Microsoft-trusted Node (no packed-binary antivirus flag).
function nodeBin() {
  const local = path.join(DIR, "node.exe");
  return IS_WIN && fs.existsSync(local) ? local : process.execPath;
}
function spawnRole(role) {
  const bin = binForRole(role);
  const args = PACKAGED ? [role] : [bin, role];
  const cmd = PACKAGED ? bin : nodeBin();
  // Capture each worker's output to a log file (the agent's own log lines end up
  // here) so you can see what's happening — e.g. "close tab (Ctrl+W)" and the
  // build stamp — and confirm which agent version is actually running.
  let stdio = "ignore";
  try {
    const fd = fs.openSync(path.join(DIR, `watch-${role}.log`), "a");
    stdio = ["ignore", fd, fd];
  } catch (_) {}
  const child = spawn(cmd, args, { cwd: DIR, detached: true, stdio, windowsHide: true });
  child.unref();
  log(`(re)launched ${role} pid≈${child.pid}`);
}

// Stop switch: instead of a global keyboard hook (which antivirus flags as a
// keylogger), stopping is done by creating stop.flag — the "Stop iD Tech Watch"
// script does this, and both processes poll for it and exit.
function writeStopScript() {
  if (!IS_WIN) return;
  try {
    const cmd = `@echo off\r\necho stop> "${STOP_FLAG}"\r\necho iD Tech Watch is stopping...\r\ntimeout /t 2 >nul\r\n`;
    fs.writeFileSync(path.join(DIR, "Stop iD Tech Watch.cmd"), cmd);
  } catch (_) {}
}

// Clone the launcher ("Start iD Tech Watch.cmd") into the install dir so the
// package is self-contained and can be re-launched after a full stop.
function writeStartScript() {
  if (!IS_WIN) return path.join(DIR, "Start iD Tech Watch.cmd");
  try {
    const cmd = `@echo off\r\ncd /d "%~dp0"\r\nstart "" /min "%~dp0node.exe" "%~dp0id-tech-watch.js"\r\n`;
    fs.writeFileSync(path.join(DIR, "Start iD Tech Watch.cmd"), cmd);
  } catch (_) {}
  return path.join(DIR, "Start iD Tech Watch.cmd");
}

// The install dir lives under a specific user's profile (C:\Users\<user>\...).
// Auto-start must land in THAT user's Startup folder — the classroom "Student"
// account — NOT whatever account launched us. This is the fix for "doesn't boot
// on startup": run_agent self-elevates, so the launcher often runs as an admin,
// and the old code wrote to the admin's APPDATA Startup, which Student never sees.
function profileFromDir() {
  const m = /^([a-z]:\\Users\\)([^\\]+)(?:\\|$)/i.exec(DIR);
  return m ? { root: m[1], user: m[2], profile: m[1] + m[2] } : null;
}
function userStartupDir() {
  const p = profileFromDir();
  if (p && fs.existsSync(p.profile))
    return path.join(p.profile, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  // fallback: whoever is running us
  return process.env.APPDATA
    ? path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
    : "";
}

// Auto-start on login by placing the launcher in that user's Startup folder
// (shell:startup). Uses a tiny hidden .vbs so no console flashes at logon.
function addToStartup() {
  if (!IS_WIN) return;
  try {
    const startupDir = userStartupDir();
    if (!startupDir) return;
    fs.mkdirSync(startupDir, { recursive: true }); // already exists for a real user; harmless
    const startCmd = path.join(DIR, "Start iD Tech Watch.cmd");
    const vbs = `Set s = CreateObject("WScript.Shell")\r\ns.Run """" & "${startCmd.replace(/\\/g, "\\\\")}" & """", 0, False\r\n`;
    fs.writeFileSync(path.join(startupDir, "iD Tech Watch.vbs"), vbs);
    log(`added to Startup for auto-start on login: ${startupDir}`);
  } catch (e) {
    log(`could not add to Startup: ${e.message}`);
  }
  addRunKey();
  enableStartupEntry();
  addLogonTask();
}

// Quietly run a Windows command; never throws, never blocks the launcher.
function winCmd(exe, args) {
  try {
    return require("child_process").execFileSync(exe, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
    }).toString();
  } catch (e) {
    return (e && e.stdout ? e.stdout.toString() : "") + (e && e.stderr ? e.stderr.toString() : "");
  }
}

// A second unelevated auto-start, so deleting the Startup shortcut alone isn't
// enough to stop the agent coming back.
function addRunKey() {
  if (!IS_WIN) return;
  const startupDir = userStartupDir();
  const vbs = startupDir ? path.join(startupDir, "iD Tech Watch.vbs") : "";
  // point at the same hidden .vbs so there's no console flash at logon
  const cmd = vbs && fs.existsSync(vbs) ? `wscript.exe "${vbs}"` : `"${path.join(DIR, "Start iD Tech Watch.cmd")}"`;
  winCmd("reg", ["add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", APP_NAME, "/t", "REG_SZ", "/d", cmd, "/f"]);
}

// Task Manager's "Startup apps" tab can DISABLE either of the above — one click,
// no admin rights, and the agent never comes back after a reboot. The choice is
// stored under StartupApproved; deleting our values returns them to enabled. We
// run as the student at logon, so HKCU is the right hive.
function enableStartupEntry() {
  if (!IS_WIN) return;
  const base = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\";
  const cleared = [
    winCmd("reg", ["delete", base + "StartupFolder", "/v", "iD Tech Watch.vbs", "/f"]),
    winCmd("reg", ["delete", base + "Run", "/v", APP_NAME, "/f"]),
  ].some((o) => /success/i.test(o));
  if (cleared) log("re-enabled a disabled auto-start entry (Task Manager > Startup apps)");
}

// Second, sturdier auto-start: a logon-triggered Scheduled Task. The Startup
// folder is a file in the student's own profile — they can simply delete it —
// and it is listed in Task Manager's Startup tab. A scheduled task is neither,
// so the two together survive the obvious "reboot to get rid of it" attempts.
// Best effort: if the account can't create tasks, the Startup folder still works.
function addLogonTask() {
  if (!IS_WIN) return;
  const startCmd = path.join(DIR, "Start iD Tech Watch.cmd");
  const out = winCmd("schtasks", [
    "/Create",
    "/TN", APP_NAME,
    "/TR", `"${startCmd}"`,
    "/SC", "ONLOGON",
    "/F", // replace an existing definition so upgrades re-point it
  ]);
  if (/SUCCESS/i.test(out)) log("registered logon scheduled task for auto-start");
  else log(`could not register logon task (Startup folder still active): ${out.trim().split(/\r?\n/)[0] || "unknown"}`);
}

// ---- config --------------------------------------------------------------
function loadConfig() {
  // `name` = the student/display name shown on the monitor (editable later from
  // the dashboard). `device` = an OPTIONAL explicit stable machine id; normally
  // left blank so the agent derives a stable id from hostname+MAC. The two are
  // different: the display name must not become the permanent device id.
  const cfg = { server: "", location: "Stanford", building: "Main Building", name: "", device: "", klass: "", token: "" };
  // 1) file next to the program / in DIR
  for (const f of [path.join(path.dirname(process.execPath), "watch-config.json"), CONFIG_FILE]) {
    try {
      Object.assign(cfg, JSON.parse(fs.readFileSync(f, "utf8")));
      break;
    } catch (_) {}
  }
  // 2) env
  cfg.server = process.env.IDT_SERVER || cfg.server;
  cfg.location = process.env.IDT_LOCATION || cfg.location;
  cfg.building = process.env.IDT_BUILDING || cfg.building;
  cfg.name = process.env.IDT_NAME || cfg.name;
  cfg.device = process.env.IDT_DEVICE || cfg.device;
  cfg.token = process.env.IDT_ENROLL_TOKEN || cfg.token;
  // 3) CLI flags (highest priority). The launcher has no role token at argv[2],
  //    so its flags start at index 2; workers have a role token, flags at 3.
  const a = process.argv.slice(ROLE === "launcher" ? 2 : 3);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--server") cfg.server = a[++i];
    else if (a[i] === "--location") cfg.location = a[++i];
    else if (a[i] === "--building") cfg.building = a[++i];
    else if (a[i] === "--name") cfg.name = a[++i];
    else if (a[i] === "--device") cfg.device = a[++i];
    else if (a[i] === "--class") cfg.klass = a[++i];
    else if (a[i] === "--token") cfg.token = a[++i];
  }
  return cfg;
}

// Scan the local /24 for a hub answering on the default port, so the client can
// auto-fill the server. Returns "ws://IP:8765" or null (falls back to DEFAULT_SERVER).
function discoverServer() {
  return new Promise((resolve) => {
    const nets = os.networkInterfaces();
    let base = null;
    for (const name of Object.keys(nets))
      for (const ni of nets[name] || [])
        if (ni.family === "IPv4" && !ni.internal && !base) base = ni.address.split(".").slice(0, 3).join(".");
    if (!base) return resolve(null);
    let done = false;
    let pending = 254;
    const finish = (ip) => {
      if (done) return;
      if (ip) {
        done = true;
        resolve(`ws://${ip}:${HUB_PORT}`);
      } else if (--pending <= 0) {
        done = true;
        resolve(null);
      }
    };
    for (let i = 1; i <= 254; i++) {
      const ip = `${base}.${i}`;
      const req = http.get({ host: ip, port: HUB_PORT, path: "/healthz", timeout: 600 }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            if (JSON.parse(data).ok) return finish(ip);
          } catch (_) {}
          finish(null);
        });
      });
      req.on("error", () => finish(null));
      req.on("timeout", () => {
        req.destroy();
        finish(null);
      });
    }
    setTimeout(() => finish(null), 4000); // hard cap
  });
}

// First-run GUI: a small window to collect hub server + location + building so a
// laptop can be set up by clicking, not editing config.json / running PowerShell.
function promptForConfig(cfg) {
  if (!IS_WIN) return null;
  const esc = (s) => String(s || "").replace(/'/g, "''");
  const ps =
    "Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase | Out-Null; " +
    "$w=New-Object System.Windows.Window; $w.Title='iD Tech Watch - Set up this laptop'; " +
    "$w.SizeToContent='WidthAndHeight'; $w.WindowStartupLocation='CenterScreen'; $w.Topmost=$true; $w.ResizeMode='NoResize'; " +
    "$g=New-Object System.Windows.Controls.StackPanel; $g.Margin='18'; $g.MinWidth=420; " +
    "$h=New-Object System.Windows.Controls.TextBlock; $h.Text='Set up this laptop'; $h.FontSize=18; $h.FontWeight='Bold'; $h.Margin='0,0,0,2'; [void]$g.Children.Add($h); " +
    "$sub=New-Object System.Windows.Controls.TextBlock; $sub.Text='Enter the student''s name so the instructor knows whose laptop this is. You can change it later from the dashboard.'; $sub.Foreground='#5f6a55'; $sub.Margin='0,0,0,10'; $sub.TextWrapping='Wrap'; [void]$g.Children.Add($sub); " +
    "function Field($lbl,$val){ $t=New-Object System.Windows.Controls.TextBlock; $t.Text=$lbl; $t.Margin='0,8,0,2'; [void]$g.Children.Add($t); $b=New-Object System.Windows.Controls.TextBox; $b.Text=$val; $b.Padding='5'; $b.FontSize=14; [void]$g.Children.Add($b); return $b }; " +
    "$dev=Field 'Student name (shown on the monitor) *' '" + esc(cfg.name) + "'; $dev.FontWeight='Bold'; " +
    "$srv=Field 'Hub server (auto-detected; edit if needed)' '" + esc(cfg.server) + "'; " +
    "$loc=Field 'Location / campus' '" + esc(cfg.location) + "'; " +
    "$bld=Field 'Building' '" + esc(cfg.building) + "'; " +
    "$err=New-Object System.Windows.Controls.TextBlock; $err.Foreground='#d92d20'; $err.Margin='0,8,0,0'; [void]$g.Children.Add($err); " +
    "$ok=New-Object System.Windows.Controls.Button; $ok.Content='Start monitoring'; $ok.Margin='0,14,0,0'; $ok.Padding='8'; $ok.FontWeight='Bold'; " +
    // require a name: if blank, prompt for it instead of silently starting
    "$ok.Add_Click({ if([string]::IsNullOrWhiteSpace($dev.Text)){ $err.Text='Please enter the student''s name.'; $dev.Focus() } else { $w.Tag='ok'; $w.Close() } }); [void]$g.Children.Add($ok); $w.Content=$g; " +
    "$dev.Focus() | Out-Null; $dev.SelectAll(); [void]$w.ShowDialog(); " +
    "if($w.Tag -eq 'ok'){ @{ name=$dev.Text.Trim(); server=$srv.Text.Trim(); location=$loc.Text.Trim(); building=$bld.Text.Trim() } | ConvertTo-Json -Compress | Write-Output }";
  try {
    const out = require("child_process").execFileSync(
      "powershell",
      ["-NoProfile", "-STA", "-Command", ps],
      { encoding: "utf8", windowsHide: false, stdio: ["ignore", "pipe", "ignore"] }
    );
    const j = JSON.parse((out || "").trim() || "{}");
    if (j && (j.server || j.building || j.name)) {
      log("setup captured from dialog.");
      return { server: j.server, location: j.location, building: j.building, name: j.name };
    }
  } catch (_) {
    /* dialog unavailable — fall back to config/flags */
  }
  return null;
}

// ==========================================================================
// Launcher: set up the folder + two files, then start both processes.
// ==========================================================================
async function runLauncher() {
  ensureDir();
  try {
    if (fs.existsSync(STOP_FLAG)) fs.unlinkSync(STOP_FLAG);
  } catch (_) {}

  let cfg = loadConfig();
  const firstRun = !fs.existsSync(CONFIG_FILE);

  // First run: auto-detect the hub on the LAN, default the device name to the
  // hostname, then (unless headless) pop a small window to confirm/edit — no
  // PowerShell, no hand-editing config.json per laptop. The very first launch
  // always shows the dialog so whoever sets up the laptop names it (the student).
  const needsSetup =
    firstRun || !cfg.server || !cfg.building || cfg.building === "Main Building" || !cfg.name;
  if (needsSetup) {
    if (!cfg.server) {
      log("scanning the network for a hub…");
      cfg.server = (await discoverServer()) || DEFAULT_SERVER;
      log(`prefilled server: ${cfg.server}`);
    }
    if (!cfg.name) cfg.name = os.hostname(); // pre-fill the dialog with the machine name
    if (process.env.IDT_NO_GUI !== "1") {
      const entered = promptForConfig(cfg);
      if (entered) cfg = Object.assign(cfg, entered);
    }
  }
  if (!cfg.server) cfg.server = DEFAULT_SERVER;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));

  // materialise the client + guardian in DIR
  if (PACKAGED) {
    for (const role of ["client", "guardian"]) {
      const dst = binForRole(role);
      try {
        fs.copyFileSync(process.execPath, dst);
      } catch (e) {
        log(`could not copy exe to ${dst}: ${e.message}`);
      }
    }
  } else {
    // script mode (signed-runtime package): copy the scripts AND the signed
    // node.exe into DIR so the install is self-contained after the USB is
    // removed. Each copy is guarded and skipped when source==destination —
    // otherwise the logon re-launch (which runs id-tech-watch.js FROM DIR) would
    // try to copy the file onto itself, throw EBUSY, and abort before starting
    // the agent (a cause of "doesn't boot on startup").
    const copyInto = (src, dstName) => {
      const dst = path.join(DIR, dstName);
      try {
        if (path.resolve(src).toLowerCase() === path.resolve(dst).toLowerCase()) return; // already in place
        fs.copyFileSync(src, dst);
      } catch (e) {
        log(`could not copy ${dstName}: ${e.message}`);
      }
    };
    copyInto(__filename, "id-tech-watch.js");
    copyInto(path.join(__dirname, "agent.js"), "agent.js");
    try {
      const localNode = path.join(DIR, "node.exe");
      if (IS_WIN && process.execPath.toLowerCase().endsWith("node.exe") && !fs.existsSync(localNode))
        fs.copyFileSync(process.execPath, localNode);
    } catch (e) {
      log(`could not copy node.exe: ${e.message}`);
    }
  }
  // Always (re)clone the Start/Stop scripts into the install dir so the package
  // is self-contained on the client and can be re-launched / auto-started.
  writeStartScript(); // the launcher, cloned into the install dir + startup
  writeStopScript();
  addToStartup();

  log(`installed to ${DIR}`);

  // Clean restart so re-running "Start" actually picks up refreshed code: if a
  // pair is already running (old build), signal it to exit and wait for it, then
  // start fresh. Without this, an update copied to disk wouldn't take effect
  // because the old client process keeps its old code loaded in memory.
  if (isAlive(readPid("client")) || isAlive(readPid("guardian"))) {
    log("existing agent running — restarting it on the refreshed code…");
    try {
      fs.writeFileSync(STOP_FLAG, "restart");
    } catch (_) {}
    for (let i = 0; i < 20 && (isAlive(readPid("client")) || isAlive(readPid("guardian"))); i++)
      await new Promise((r) => setTimeout(r, 200));
    try {
      if (fs.existsSync(STOP_FLAG)) fs.unlinkSync(STOP_FLAG);
    } catch (_) {}
  }

  if (!isAlive(readPid("client"))) spawnRole("client");
  if (!isAlive(readPid("guardian"))) spawnRole("guardian");
  log('both processes started — run "Stop iD Tech Watch.cmd" in that folder to stop both.');
}

// ==========================================================================
// A worked role (client or guardian): watch the counterpart + kill switch.
// ==========================================================================
function runWorker(role) {
  ensureDir();
  writePid(role);
  const counterpart = role === "client" ? "guardian" : "client";

  function cleanupAndExit() {
    try {
      fs.unlinkSync(pidFile(role));
    } catch (_) {}
    process.exit(0);
  }
  process.on("SIGINT", cleanupAndExit);
  process.on("SIGTERM", cleanupAndExit);

  // watch the counterpart every second; relaunch if it died (unless stopping)
  setInterval(() => {
    if (stopRequested()) return cleanupAndExit();
    if (!isAlive(readPid(counterpart))) {
      log(`${counterpart} is down — relaunching it.`);
      spawnRole(counterpart);
    }
  }, 1000);

  if (role === "client") {
    // run the real monitoring agent in-process
    const cfg = loadConfig();
    const argv = [process.argv[0], "agent", "--server", cfg.server, "--location", cfg.location, "--building", cfg.building, "--keep-awake"];
    if (cfg.name) argv.push("--name", cfg.name); // the student/display name shown on the monitor
    if (cfg.device) argv.push("--device", cfg.device); // optional explicit machine id (normally auto-derived)
    if (cfg.klass) argv.push("--class", cfg.klass);
    if (cfg.token) argv.push("--token", cfg.token);
    process.argv = argv;
    try {
      require("./agent.js").main();
    } catch (e) {
      log(`agent failed to start: ${e.message}`);
    }
  } else {
    log("guardian watching the client.");
  }
}

// --------------------------------------------------------------------------
if (ROLE === "launcher") runLauncher().catch((e) => log(`launcher error: ${e.message}`));
else runWorker(ROLE);
