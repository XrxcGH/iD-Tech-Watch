#!/usr/bin/env node
/*
 * iD Tech Classroom Monitor — student-laptop agent (Node.js, zero dependencies).
 *
 * Copy this single file onto each class laptop (Node 18+; uses the built-in
 * global WebSocket client, stable in Node 22+). It connects to the classroom
 * hub, reports a limited running-application inventory, and carries out instructor commands:
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
const classAppRules = new Map(); // exact executable -> readable display name
let sitesAvailable = true; // did the last hosts write succeed?
let lastAppliedSites = null; // signature of the last hosts write
let awakeChild = null; // keep-awake helper process
let pauseChild = null; // full-screen "paused" overlay process
let pauseActive = false; // true while paused (overlay reopens if student closes it)
let pauseMessage = ""; // text shown on the pause overlay
let messageChild = null; // current full-screen classroom-message overlay
let messageGeneration = 0; // invalidates exit handlers when a display is replaced
let activeMessage = null; // authoritative enforced warning/transition state
let messageExpiryTimer = null;
let messageRespawnTimer = null;

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
  const applications = new Map();

  function addApplication(processName, displayName) {
    const executable = normalizeExecutableIdentifier(processName);
    if (!executable) return;
    const readable = String(displayName || processName || "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, 100);
    const current = applications.get(executable);
    if (!current || current.display_name === current.process_name) {
      applications.set(executable, {
        process_name: executable,
        display_name: readable || executable,
        executable,
      });
    }
  }

  if (IS_WIN) {
    // FileDescription supplies a readable application name when available.
    // Window titles, command lines, file contents, and user input are never read.
    const out = await run("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "@(Get-Process | Where-Object {$_.MainWindowHandle -ne 0} | ForEach-Object {" +
        "$description='';try{$description=$_.FileVersionInfo.FileDescription}catch{};" +
        "[pscustomobject]@{process=$_.ProcessName;display=$description}" +
        "})|ConvertTo-Json -Compress",
    ]);
    try {
      const parsed = JSON.parse(out || "[]");
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        addApplication(item && item.process, item && item.display);
      }
    } catch (_) {}
  } else {
    const psOut = IS_MAC
      ? await run("osascript", [
          "-e",
          'tell application "System Events" to get the name of every process whose background only is false',
        ])
      : await run("ps", ["-axco", "comm"]);
    for (const line of psOut.split(IS_MAC ? /,\s*/ : /\r?\n/)) {
      const name = path.basename(line.trim());
      if (name && name !== "COMM") addApplication(name, name);
    }
  }

  return {
    applications: [...applications.values()]
      .sort((a, b) => a.display_name.toLowerCase().localeCompare(b.display_name.toLowerCase()))
      .slice(0, MAX_PROCESSES),
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

function normalizeExecutableIdentifier(value) {
  let executable = String(value || "").trim().toLowerCase();
  if (executable.endsWith(".exe")) executable = executable.slice(0, -4);
  return /^[a-z0-9][a-z0-9._ -]{0,79}$/.test(executable) ? executable : null;
}

async function killExact(executable) {
  const exact = normalizeExecutableIdentifier(executable);
  if (!exact) return [];
  const killed = [];
  if (IS_WIN) {
    const out = await run("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$n=$args[0]; $p=Get-Process -Name $n -ErrorAction SilentlyContinue; " +
        "$p|ForEach-Object{$_.ProcessName}; $p|Stop-Process -Force -ErrorAction SilentlyContinue",
      exact,
    ]);
    for (const line of out.split(/\r?\n/)) {
      const name = line.trim();
      if (name) killed.push(name);
    }
  } else {
    await run("pkill", ["-x", exact]);
    killed.push(exact);
  }
  return killed;
}

function closeForegroundWindowScript() {
  return [
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Text;",
    "using System.Runtime.InteropServices;",
    "public static class IDTechForegroundClose {",
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowTextLength(IntPtr hWnd);',
    '  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);',
    '  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);',
    "}",
    "'@;",
    "$h=[IDTechForegroundClose]::GetForegroundWindow();",
    "if($h -eq [IntPtr]::Zero){'no_foreground';exit};",
    "$length=[IDTechForegroundClose]::GetWindowTextLength($h);",
    "if($length -le 0){'no_foreground';exit};",
    "$title=[Text.StringBuilder]::new($length+1);",
    "[void][IDTechForegroundClose]::GetWindowText($h,$title,$title.Capacity);",
    "$result=[IntPtr]::Zero;",
    "$ok=[IDTechForegroundClose]::SendMessageTimeout($h,0x0010,[IntPtr]::Zero,[IntPtr]::Zero,0x0002,3000,[ref]$result);",
    "if($ok -eq [IntPtr]::Zero){",
    "  if([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1460){'timed_out'}else{'failed'}",
    "}else{'success'}",
  ].join("\n");
}

function closeForegroundWindow() {
  if (!IS_WIN) {
    return Promise.resolve({
      status: "unsupported",
      detail: "Closing the focused window is currently supported only on Windows.",
    });
  }
  return new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", closeForegroundWindowScript()],
      { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error && (error.killed || error.code === "ETIMEDOUT")) {
          resolve({ status: "timed_out", detail: "The foreground application did not respond." });
          return;
        }
        const status = String(stdout || "").trim().split(/\s+/)[0];
        if (status === "success") {
          resolve({ status, detail: "The foreground window received a graceful close request." });
        } else if (status === "no_foreground") {
          resolve({ status, detail: "No foreground window was available to close." });
        } else if (status === "timed_out") {
          resolve({ status, detail: "The foreground application did not respond." });
        } else {
          resolve({ status: "failed", detail: "The foreground window could not be closed." });
        }
      }
    );
  });
}

// ------------------------------------------------------- classroom messages
// Windows uses documented WPF/SystemParameters APIs. The overlay spans the
// virtual desktop, remains Topmost, and updates its bounds when monitors change.
// Message content is base64-encoded JSON data, never interpolated as script.
function messageKind(kind) {
  return kind === "warning" || kind === "transition" ? kind : "info";
}

function stopMessageWindow() {
  messageGeneration++;
  if (messageRespawnTimer) clearTimeout(messageRespawnTimer);
  messageRespawnTimer = null;
  const child = messageChild;
  messageChild = null;
  if (child) {
    try {
      child.kill();
    } catch (_) {}
  }
}

function messageWindowScript(payload) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return (
    "Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase; " +
    `$json=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); ` +
    "$data=$json|ConvertFrom-Json; " +
    "$w=New-Object System.Windows.Window; $w.Title='iD Tech Classroom Message'; " +
    "$w.WindowStyle='None'; $w.ResizeMode='NoResize'; $w.SizeToContent='Manual'; " +
    "$w.Topmost=$true; $w.ShowInTaskbar=$true; $w.Background='#000000'; " +
    "$root=New-Object System.Windows.Controls.Grid; $root.Margin='48'; " +
    "$panel=New-Object System.Windows.Controls.Border; $panel.Background='#151515'; " +
    "$panel.BorderBrush='#94D60A'; $panel.BorderThickness='4'; $panel.CornerRadius='18'; " +
    "$panel.Padding='48'; $panel.MaxWidth=1100; $panel.HorizontalAlignment='Center'; $panel.VerticalAlignment='Center'; " +
    "$stack=New-Object System.Windows.Controls.StackPanel; " +
    "$brand=New-Object System.Windows.Controls.TextBlock; $brand.Text='iD TECH CLASSROOM MESSAGE'; " +
    "$brand.Foreground='#94D60A'; $brand.FontSize=22; $brand.FontWeight='Bold'; $brand.TextAlignment='Center'; " +
    "$kind=New-Object System.Windows.Controls.TextBlock; " +
    "$kind.Text=if($data.kind -eq 'warning'){'STUDENT WARNING'}elseif($data.kind -eq 'transition'){'TRANSITION TIME'}else{'INFORMATION'}; " +
    "$kind.Foreground='#FFFFFF'; $kind.FontSize=30; $kind.FontWeight='Bold'; $kind.TextAlignment='Center'; $kind.Margin='0,18,0,24'; " +
    "$text=New-Object System.Windows.Controls.TextBlock; $text.Text=[string]$data.text; " +
    "$text.Foreground='#FFFFFF'; $text.FontSize=[Math]::Max(30,[Math]::Min(54,[System.Windows.SystemParameters]::PrimaryScreenWidth/28)); " +
    "$text.FontWeight='SemiBold'; $text.TextWrapping='Wrap'; $text.TextAlignment='Center'; $text.MaxWidth=980; " +
    "$stack.Children.Add($brand)|Out-Null; $stack.Children.Add($kind)|Out-Null; $stack.Children.Add($text)|Out-Null; " +
    "if($data.enforced){" +
    "$note=New-Object System.Windows.Controls.TextBlock; $note.Text='Your instructor will clear this classroom message.'; " +
    "$note.Foreground='#BFC5C9'; $note.FontSize=18; $note.TextAlignment='Center'; $note.Margin='0,30,0,0'; " +
    "$stack.Children.Add($note)|Out-Null" +
    "}else{" +
    "$button=New-Object System.Windows.Controls.Button; $button.Content='Dismiss'; $button.Width=150; $button.Height=46; " +
    "$button.FontSize=18; $button.FontWeight='Bold'; $button.Background='#94D60A'; $button.Foreground='#000000'; " +
    "$button.HorizontalAlignment='Center'; $button.Margin='0,30,0,0'; $button.Add_Click({$w.Close()}); " +
    "$stack.Children.Add($button)|Out-Null" +
    "}; " +
    "$panel.Child=$stack; $root.Children.Add($panel)|Out-Null; $w.Content=$root; " +
    "$fit={ $w.WindowState='Normal'; $w.Left=[System.Windows.SystemParameters]::VirtualScreenLeft; " +
    "$w.Top=[System.Windows.SystemParameters]::VirtualScreenTop; $w.Width=[System.Windows.SystemParameters]::VirtualScreenWidth; " +
    "$w.Height=[System.Windows.SystemParameters]::VirtualScreenHeight; $w.Topmost=$true }; " +
    "$monitorTimer=New-Object System.Windows.Threading.DispatcherTimer; $monitorTimer.Interval=[TimeSpan]::FromSeconds(1); " +
    "$monitorTimer.Add_Tick($fit); " +
    "if((-not $data.enforced) -and ([double]$data.timeout_sec -gt 0)){" +
    "$closeTimer=New-Object System.Windows.Threading.DispatcherTimer; " +
    "$closeTimer.Interval=[TimeSpan]::FromSeconds([double]$data.timeout_sec); " +
    "$closeTimer.Add_Tick({$closeTimer.Stop();$w.Close()})" +
    "}; " +
    "$w.Add_Loaded({& $fit;$monitorTimer.Start();if($closeTimer){$closeTimer.Start()};$w.Activate()}); " +
    "$w.Add_Closed({$monitorTimer.Stop();if($closeTimer){$closeTimer.Stop()}}); [void]$w.ShowDialog();"
  );
}

function spawnMessageWindow(message, enforced) {
  if (!message || !message.text || messageChild) return;
  const kind = messageKind(message.kind);
  const text = String(message.text).slice(0, 4000);
  const generation = ++messageGeneration;

  if (!IS_WIN) {
    if (kind !== "info" || !IS_MAC) {
      log("WARNING: enforced full-screen classroom messages currently require Windows.");
      return;
    }
    const script =
      'on run argv\n display dialog (item 1 of argv) with title "iD Tech Classroom Message" buttons {"Dismiss"}\nend run';
    messageChild = spawn("osascript", ["-e", script, "--", text], { stdio: "ignore" });
  } else {
    const ps = messageWindowScript({
      kind,
      text,
      enforced: !!enforced,
      timeout_sec: Number(message.timeout_sec) || 0,
    });
    messageChild = spawn("powershell", ["-NoProfile", "-STA", "-WindowStyle", "Hidden", "-Command", ps], {
      windowsHide: true,
      stdio: "ignore",
    });
  }

  const child = messageChild;
  child.on("exit", () => {
    if (generation !== messageGeneration) return;
    messageChild = null;
    if (enforced && activeMessage && activeMessage.id === message.id) {
      messageRespawnTimer = setTimeout(() => {
        messageRespawnTimer = null;
        spawnMessageWindow(activeMessage, true);
      }, 400);
    }
  });
}

function scheduleMessageExpiry() {
  if (messageExpiryTimer) clearTimeout(messageExpiryTimer);
  messageExpiryTimer = null;
  if (!activeMessage || !activeMessage.expires_at) return;
  const delay = Math.max(0, activeMessage.expires_at * 1000 - Date.now());
  const id = activeMessage.id;
  messageExpiryTimer = setTimeout(() => {
    messageExpiryTimer = null;
    if (activeMessage && activeMessage.id === id) {
      activeMessage = null;
      stopMessageWindow();
      log(`enforced classroom message ${id} expired`);
    }
  }, Math.min(delay, 2147483647));
}

function applyMessageState(message) {
  const valid =
    message &&
    message.id &&
    (message.kind === "warning" || message.kind === "transition") &&
    String(message.text || "").trim();
  if (!valid || (message.expires_at && message.expires_at <= Date.now() / 1000)) {
    const previous = activeMessage && activeMessage.id;
    activeMessage = null;
    if (messageExpiryTimer) clearTimeout(messageExpiryTimer);
    messageExpiryTimer = null;
    stopMessageWindow();
    if (previous) log(`enforced classroom message ${previous} cleared`);
    return;
  }

  const next = {
    id: String(message.id),
    kind: messageKind(message.kind),
    text: String(message.text).slice(0, 4000),
    expires_at: Number(message.expires_at) || 0,
  };
  const unchanged =
    activeMessage &&
    activeMessage.id === next.id &&
    activeMessage.kind === next.kind &&
    activeMessage.text === next.text;
  activeMessage = next;
  scheduleMessageExpiry();
  if (!unchanged || !messageChild) {
    stopMessageWindow();
    spawnMessageWindow(activeMessage, true);
    log(`enforced ${activeMessage.kind} message ${activeMessage.id} active`);
  }
}

function showInformationalMessage(params) {
  const text = String((params && params.text) || "").trim().slice(0, 4000);
  if (!text) return;
  const expiresAt = Number(params && params.expires_at) || 0;
  if (expiresAt && expiresAt <= Date.now() / 1000) {
    log("expired informational classroom message ignored");
    return;
  }
  if (activeMessage) {
    log("informational message skipped while an enforced classroom message is active");
    return;
  }
  stopMessageWindow();
  const message = {
    kind: "info",
    text,
    timeout_sec: expiresAt ? Math.max(0, expiresAt - Date.now() / 1000) : 0,
  };
  spawnMessageWindow(message, false);
  log(`informational classroom message displayed${message.timeout_sec ? ` (${message.timeout_sec}s)` : ""}`);
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
  for (const executable of classAppRules.keys()) {
    const killed = await killExact(executable);
    if (killed.length && IS_WIN) log(`class rule blocked exact executable '${executable}'`);
  }
  enforceSites();
}

// ------------------------------------------------------------------- status
async function sendStatus(ws) {
  const { applications } = await inspect();
  const blocked = [...activeAppBlocks()].map(([pattern, exp]) => ({
    pattern,
    expires_at: exp ? exp / 1000 : 0,
  }));
  const blockedSites = [...activeSiteBlocks()].map(([domain, exp]) => ({
    domain,
    expires_at: exp ? exp / 1000 : 0,
  }));
  const classBlockedApplications = [...classAppRules].map(([executable, display_name]) => ({
    executable,
    display_name,
  }));
  ws.send(
    JSON.stringify({
      type: "status",
      applications,
      blocked,
      blockedSites,
      classBlockedApplications,
      sitesAvailable,
    })
  );
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

function blockExpiryFromParams(params, now = Date.now()) {
  const source = params || {};
  if (Object.prototype.hasOwnProperty.call(source, "expires_at")) {
    const expiresAt = source.expires_at;
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt < 0) return null;
    if (expiresAt === 0) return 0;
    const expiry = expiresAt * 1000;
    return expiry > now ? expiry : null;
  }

  // Compatibility with older hubs. Current hubs always send expires_at so a
  // reconnect or delayed delivery cannot restart the original duration.
  if (!Object.prototype.hasOwnProperty.call(source, "duration_sec")) return 0;
  const duration = source.duration_sec;
  if (
    typeof duration !== "number" ||
    !Number.isInteger(duration) ||
    duration <= 0 ||
    duration > 20 * 60 * 60
  )
    return null;
  return now + duration * 1000;
}

function syncClassAppRules(rules) {
  const next = new Map();
  for (const rule of Array.isArray(rules) ? rules : []) {
    const executable = normalizeExecutableIdentifier(rule && rule.executable);
    const displayName = String((rule && rule.display_name) || "").trim().slice(0, 100);
    if (executable && displayName) next.set(executable, displayName);
  }
  classAppRules.clear();
  for (const [executable, displayName] of next) classAppRules.set(executable, displayName);
  log(`synchronized ${classAppRules.size} class application rule(s)`);
}

async function handleCommand(ws, msg) {
  const action = msg.action;
  const p = msg.params || {};
  const expiry =
    action === "block_app" || action === "block_site" ? blockExpiryFromParams(p) : 0;

  if (action === "kill_process") {
    const killed = await killMatching(p.pattern || "");
    log(`close app '${p.pattern}' -> ${killed.join(", ") || "(none)"}`);
  } else if (action === "block_app") {
    if (expiry === null) return log("ignored invalid or expired app block");
    const pats = collectPatterns(p);
    for (const pat of pats) appBlocks.set(pat, expiry);
    for (const pat of pats) await killMatching(pat);
    if (pats.length) log(`blocking apps: ${pats.join(", ")} (${expiry ? "timed" : "until lifted"})`);
  } else if (action === "unblock_app") {
    for (const pat of collectPatterns(p)) appBlocks.delete(pat);
  } else if (action === "block_site") {
    if (expiry === null) return log("ignored invalid or expired website block");
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
    showInformationalMessage(p);
  } else if (action === "message_state") {
    applyMessageState(p.message || null);
  } else if (action === "clear_message") {
    applyMessageState(null);
  } else if (action === "sync_class_app_rules") {
    syncClassAppRules(p.rules);
    await enforce();
    await sendStatus(ws);
  } else if (action === "close_foreground") {
    let result;
    try {
      result = await closeForegroundWindow();
    } catch (error) {
      result = { status: "failed", detail: error && error.message ? error.message : "Close request failed." };
    }
    log(`close focused window ${msg.request_id || "(no id)"}: ${result.status}`);
    ws.send(
      JSON.stringify({
        type: "command_result",
        action: "close_foreground",
        request_id: msg.request_id || "",
        status: result.status,
        detail: result.detail,
      })
    );
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
  activeMessage = null;
  if (messageExpiryTimer) clearTimeout(messageExpiryTimer);
  messageExpiryTimer = null;
  stopMessageWindow();
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
    server: process.env.IDT_SERVER || null,
    location: process.env.IDT_LOCATION || "Stanford", // stable physical campus
    building: process.env.IDT_BUILDING || "Main Building", // stable physical building
    klass: process.env.IDT_CLASS || "", // optional first-setup hint; class is normally managed by admin
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
      // Ask the hub for authoritative enforced-message state on every
      // connection so an overlay cleared while offline cannot return stale.
      ws.send(JSON.stringify({ type: "message_state_request" }));
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

if (require.main === module) main();
else
  module.exports = {
    blockExpiryFromParams,
    closeForegroundWindowScript,
    messageKind,
    messageWindowScript,
    normalizeExecutableIdentifier,
  };
