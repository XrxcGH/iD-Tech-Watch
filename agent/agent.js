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

// Prefer Node's built-in global WebSocket (Node 22+). Fall back to the `ws`
// package when packaged into an exe on an older embedded Node (bundled at build
// time; not needed for plain `node agent.js` on a modern Node).
const WS =
  typeof WebSocket !== "undefined"
    ? WebSocket
    : (() => {
        try {
          return require("ws");
        } catch (_) {
          return null;
        }
      })();

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

// Build stamp — logged on startup so you can confirm which agent version a
// laptop is actually running (see watch-client.log in the install folder).
const BUILD = "2026-07-30 focus-guard · fullscreen-capture · state-cache";

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

// app pattern -> { expiry: ms epoch (0 = until lifted), exclude: [substrings] }
// `exclude` lets a block match a family but spare a sibling — e.g. block
// "roblox" (the player) while leaving "studio" (Roblox Studio, used in class).
const appBlocks = new Map();
// domain -> expiry (ms epoch, 0 = until explicitly unblocked)
const siteBlocks = new Map();
let sitesAvailable = true; // did the last hosts write succeed?
let lastAppliedSites = null; // signature of the last hosts write
let enforcing = false; // guard so app-block sweeps never overlap/pile up
let awakeChild = null; // keep-awake helper process
let pauseChild = null; // full-screen "paused" overlay process
let pauseActive = false; // true while paused (overlay reopens if student closes it)
let pauseMessage = ""; // text shown on the pause overlay
let pauseTimer = null; // auto-resume timer (timed/scheduled pauses)
let screenshotChild = null; // persistent screen-capture helper (only while viewed)

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
  let activeWindow = ""; // title of the current foreground window (for highlighting)

  if (IS_WIN) {
    // Only report apps that actually have a window on screen — the handful the
    // student is using, not the ~100 background/system processes. (Blocking still
    // scans every process via killMatching, so it's unaffected.) We also emit the
    // FOREGROUND window's title (as an @ACTIVE@ line) so the instructor's window
    // list can highlight what the student is actually looking at right now.
    const out = await run("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Add-Type -Namespace IDTa -Name W -MemberDefinition '" +
        "[DllImport(\"user32.dll\")] public static extern System.IntPtr GetForegroundWindow();" +
        "[DllImport(\"user32.dll\", CharSet=CharSet.Auto)] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder s, int n);" +
        "'; " +
        "$fg=[IDTa.W]::GetForegroundWindow(); $sb=New-Object System.Text.StringBuilder 512; [void][IDTa.W]::GetWindowText($fg,$sb,512); " +
        "Write-Output ('@ACTIVE@`t' + $sb.ToString()); " +
        'Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.ProcessName + "`t" + $_.MainWindowTitle }',
    ]);
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const tab = line.indexOf("\t");
      const name = (tab === -1 ? line : line.slice(0, tab)).trim();
      const title = (tab === -1 ? "" : line.slice(tab + 1)).trim();
      if (name === "@ACTIVE@") {
        if (title) activeWindow = title;
        continue;
      }
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
    activeWindow,
  };
}

// Sanitize a substring before interpolating it into a PowerShell -like clause.
function safePat(s) {
  return String(s || "").toLowerCase().trim().replace(/[^a-z0-9 ._-]/gi, "");
}

// A pattern may carry its own command-line requirement inline as "name (cmd)" —
// the same form shown on a dashboard block chip, so a chip can be handed
// straight back, and the form the per-class "always block" list (plain strings,
// no cmd_match field) uses to express "javaw (minecraft)".
function parsePattern(raw, fallbackCmd) {
  const m = /^(.+?)\s*\(([^()]+)\)$/.exec(String(raw || "").trim());
  return m ? { pat: m[1].trim(), cmd: m[2].trim() } : { pat: raw, cmd: fallbackCmd || "" };
}

// Terminate every process whose name contains `pattern` (case-insensitive).
async function killMatching(pattern) {
  const e = parsePattern(pattern, "");
  return killMatchingMany([{ pat: e.pat, exclude: [], cmd: e.cmd }]);
}

// Build the match clauses shared by the kill and minimize sweeps.
// Each block = { pat, exclude:[substrings], cmd }:
//   pat     — substring of the process name
//   exclude — spare a sibling that also matches (block Roblox Player, keep Studio)
//   cmd     — ALSO require this substring in the process's command line
//
// `cmd` is what makes Minecraft Java blockable. The running game is not
// "minecraft.exe", it is javaw.exe — and blocking every javaw would take out
// BlueJ, Processing, IntelliJ and any Java coursework with it. Matching
// javaw + a command line containing "minecraft" hits the game and nothing else.
function matchClauses(blocks) {
  const clauses = [];
  const pats = [];
  let needsCmd = false;
  for (const b of blocks || []) {
    const pat = safePat(b && b.pat);
    if (!pat) continue;
    pats.push(pat);
    let clause = `$n -like '*${pat}*'`;
    const cmd = safePat(b && b.cmd);
    if (cmd) {
      clause += ` -and $c -like '*${cmd}*'`;
      needsCmd = true;
    }
    for (const e of (b.exclude || [])) {
      const ex = safePat(e);
      if (ex) clause += ` -and $n -notlike '*${ex}*'`;
    }
    clauses.push(`(${clause})`);
  }
  return { clauses, pats, needsCmd };
}

// PowerShell that leaves the matching process ids in $ids.
// Command lines only come from Win32_Process (a WMI call, noticeably slower than
// Get-Process), so we only pay for it when a block actually asks for one — the
// ordinary name-only sweep, which runs every couple of seconds, stays on the
// fast path. `[string]$_.CommandLine` keeps a null command line as "" so it
// simply fails to match instead of throwing.
// Marker carried in every sweep's own command line. A command-line sweep would
// otherwise MATCH ITSELF: our query text literally contains the pattern we are
// searching for (`-like '*minecraft*'`), so the agent's own helper PowerShells
// looked like Minecraft and got swept. Every sweep sets this variable, and the
// command-line query skips marked processes.
//
// The skip is deliberately narrowed to PowerShell processes: excluding *any*
// process whose command line mentions the marker would hand students an opt-out
// — Minecraft's launcher lets you edit the JVM arguments, so `-DIDT_SWEEP`
// would make the game invisible to the block. Only powershell.exe can plausibly
// be one of our sweeps.
const SWEEP_MARK = "$IDT_SWEEP=1; ";
function selectIdsPs(clauses, needsCmd) {
  const where = clauses.join(" -or ");
  if (needsCmd) {
    return (
      SWEEP_MARK +
      `$ids = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $n=$_.Name; $c=[string]$_.CommandLine; (-not ($n -like 'powershell*' -and $c -like '*IDT_SWEEP*')) -and (${where}) } | ForEach-Object { [uint32]$_.ProcessId }); `
    );
  }
  return SWEEP_MARK + `$ids = @(Get-Process | Where-Object { $n=$_.ProcessName; $c=''; ${where} } | ForEach-Object { [uint32]$_.Id }); `;
}

// Terminate every process matching ANY of `blocks` in a SINGLE PowerShell call.
// Batching one sweep into one spawn (instead of one spawn per pattern) is what
// makes repeated/large blocks reliable — the old per-pattern loop spawned N
// PowerShells every 2s and, once enforcement congested, kills started missing
// (the "first attempt works, later ones don't" bug).
//
// NOTE: this is no longer the default for app blocks — see minimizeMatchingMany.
// Force-terminating a game client is what got student Roblox accounts flagged.
async function killMatchingMany(blocks) {
  const { clauses, pats: macos, needsCmd } = matchClauses(blocks);
  if (!clauses.length) return [];
  const killed = [];
  if (IS_WIN) {
    const out = await run("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      selectIdsPs(clauses, needsCmd) +
        `if ($ids.Count -gt 0) { ` +
        `Get-Process -Id $ids -ErrorAction SilentlyContinue | ForEach-Object { $_.ProcessName }; ` +
        `Stop-Process -Id $ids -Force -ErrorAction SilentlyContinue }`,
    ]);
    for (const line of out.split(/\r?\n/)) {
      const n = line.trim();
      if (n) killed.push(n);
    }
  } else {
    // -i = case-insensitive, -f = match against full argument list. (Exclusions
    // are a Windows-only refinement; the presets that use them are Windows apps.)
    for (const pat of macos) {
      await run("pkill", ["-if", pat]);
      killed.push(pat);
    }
  }
  return killed;
}

// Find every visible, titled, not-already-minimized top-level window owned by
// the given PIDs and minimize it.
//   * EnumWindows + GetWindowThreadProcessId (not .NET MainWindowHandle, which
//     is 0 for a surprising number of apps) so we actually find game windows.
//   * SW_FORCEMINIMIZE (11) so a busy or full-screen client still goes down.
//   * Opens NO handle on the target process and injects NO input.
const MIN_CSHARP = [
  "using System;",
  "using System.Collections.Generic;",
  "using System.Runtime.InteropServices;",
  "public static class IDTWin {",
  "  public delegate bool EnumProc(IntPtr h, IntPtr p);",
  "  [DllImport(\"user32.dll\")] static extern bool EnumWindows(EnumProc cb, IntPtr p);",
  "  [DllImport(\"user32.dll\")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);",
  "  [DllImport(\"user32.dll\")] static extern bool IsWindowVisible(IntPtr h);",
  "  [DllImport(\"user32.dll\")] static extern bool IsIconic(IntPtr h);",
  "  [DllImport(\"user32.dll\")] static extern bool ShowWindow(IntPtr h, int n);",
  "  [DllImport(\"user32.dll\")] static extern int GetWindowTextLength(IntPtr h);",
  "  const int SW_FORCEMINIMIZE = 11;",
  "  public static int Minimize(uint[] pids) {",
  "    int n = 0;",
  "    var set = new HashSet<uint>(pids);",
  "    EnumProc cb = delegate(IntPtr h, IntPtr l) {",
  "      uint pid; GetWindowThreadProcessId(h, out pid);",
  "      if (set.Contains(pid) && IsWindowVisible(h) && !IsIconic(h) && GetWindowTextLength(h) > 0) {",
  "        ShowWindow(h, SW_FORCEMINIMIZE); n++;",
  "      }",
  "      return true;",
  "    };",
  "    EnumWindows(cb, IntPtr.Zero);",
  "    GC.KeepAlive(cb);",
  "    return n;",
  "  }",
  "}",
].join("\n");

// Focus guard: keep pushing down every window that isn't allowed.
//
// A full-screen lock only covers the virtual desktop it lives on. A student can
// switch desktops — and crucially, a THREE-FINGER TOUCHPAD SWIPE does that with
// no keystroke at all, so the keyboard lock can't see it — landing on a clean
// desktop with the lock stranded behind them. Rather than fight the (undocumented,
// build-specific) desktop-pinning APIs, this makes the escape pointless: whatever
// they raise over there is minimized again within a second.
//
// Skips windows with an EMPTY title, which is what our own WPF locks report
// (verified), so the guard can never minimize the lock it is protecting.
const FOCUS_CSHARP = [
  "using System;",
  "using System.Text;",
  "using System.Runtime.InteropServices;",
  "public static class IDTFocus {",
  "  public delegate bool EnumProc(IntPtr h, IntPtr p);",
  "  [DllImport(\"user32.dll\")] static extern bool EnumWindows(EnumProc cb, IntPtr p);",
  "  [DllImport(\"user32.dll\")] static extern bool IsWindowVisible(IntPtr h);",
  "  [DllImport(\"user32.dll\")] static extern bool IsIconic(IntPtr h);",
  "  [DllImport(\"user32.dll\")] static extern bool ShowWindow(IntPtr h, int n);",
  "  [DllImport(\"user32.dll\")] static extern int GetWindowTextLength(IntPtr h);",
  "  [DllImport(\"user32.dll\")] static extern int GetWindowText(IntPtr h, StringBuilder s, int c);",
  "  const int SW_FORCEMINIMIZE = 11;",
  "  public static int MinimizeExcept(string[] allow) {",
  "    int n = 0;",
  "    EnumProc cb = delegate(IntPtr h, IntPtr l) {",
  "      if (!IsWindowVisible(h) || IsIconic(h)) return true;",
  "      int len = GetWindowTextLength(h);",
  "      if (len <= 0) return true;",                       // our own locks + tool windows
  "      var sb = new StringBuilder(len + 1);",
  "      GetWindowText(h, sb, sb.Capacity);",
  "      string t = sb.ToString();",
  "      if (t == \"Program Manager\") return true;",       // the desktop itself
  "      string lt = t.ToLowerInvariant();",
  "      for (int i = 0; i < allow.Length; i++) {",
  "        if (allow[i].Length > 0 && lt.Contains(allow[i])) return true;",
  "      }",
  "      ShowWindow(h, SW_FORCEMINIMIZE); n++;",
  "      return true;",
  "    };",
  "    EnumWindows(cb, IntPtr.Zero);",
  "    GC.KeepAlive(cb);",
  "    return n;",
  "  }",
  "}",
].join("\n");

let focusChild = null; // persistent sweeper (one process, not one per tick)
const focusReasons = new Map(); // reason -> allowed title substrings

// Effective allow-list: a hard lock (pause / held message) passes an EMPTY list
// and must win, so nothing is allowed through while one is up.
function effectiveFocusAllow() {
  const lists = [...focusReasons.values()];
  if (!lists.length) return null;
  if (lists.some((l) => !l.length)) return [];
  return [...new Set(lists.flat())];
}

function applyFocusGuard() {
  const allow = effectiveFocusAllow();
  if (focusChild) {
    try {
      focusChild.kill();
    } catch (_) {}
    focusChild = null;
  }
  if (allow === null || !IS_WIN) return; // nothing holding the guard
  const psArray = allow.length ? allow.map((a) => `'${safePat(a).replace(/'/g, "''")}'`).join(",") : "";
  const ps =
    "$src = @'\n" + FOCUS_CSHARP + "\n'@\n" +
    "Add-Type -TypeDefinition $src -ErrorAction SilentlyContinue\n" +
    `$allow = @(${psArray}); ` +
    "while($true){ try { [void][IDTFocus]::MinimizeExcept([string[]]$allow) } catch {} Start-Sleep -Milliseconds 900 }";
  focusChild = spawn("powershell", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps], {
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  focusChild.on("exit", () => {
    focusChild = null;
  });
  log(`focus guard ON (allowed: ${allow.length ? allow.join(", ") : "nothing — full lock"})`);
}

function startFocusGuard(reason, allow) {
  focusReasons.set(reason, (allow || []).map((a) => String(a).toLowerCase().trim()).filter(Boolean));
  applyFocusGuard();
}
function stopFocusGuard(reason) {
  if (!focusReasons.delete(reason)) return;
  applyFocusGuard();
  if (!focusReasons.size) log("focus guard OFF");
}

// Minimize — rather than kill — every window of the processes matching `blocks`.
// This is the DEFAULT enforcement for app blocks.
//
// WHY: repeatedly force-terminating a game client from an outside process is
// exactly the signature anti-cheat looks for (Roblox's Hyperion), and student
// accounts were being flagged for cheating/macros and disabled for the day.
// Minimizing touches only the window manager — no process handle, no injected
// keystrokes — so it does not look like tampering. The enforce loop re-runs
// every couple of seconds, so a window the student restores is pushed straight
// back down and the game stays unusable without ever being killed.
// Already-minimized windows are skipped, so a steady state costs nothing and
// never steals focus.
async function minimizeMatchingMany(blocks) {
  const { clauses, needsCmd } = matchClauses(blocks);
  if (!clauses.length) return 0;
  // No window-manager equivalent off Windows; fall back to the old behaviour
  // there rather than silently doing nothing (camp laptops are all Windows).
  if (!IS_WIN) return (await killMatchingMany(blocks)).length;
  // Find the processes FIRST and only compile the C# if something matched.
  // Add-Type spawns csc.exe (~0.8-1s); in the steady state — a block active but
  // the game not running — this sweep now costs one Get-Process and nothing
  // else, instead of recompiling every 2s all day on a student laptop.
  const ps =
    selectIdsPs(clauses, needsCmd) +
    "\nif ($ids.Count -gt 0) {\n$src = @'\n" + MIN_CSHARP + "\n'@\n" +
    "Add-Type -TypeDefinition $src -ErrorAction SilentlyContinue\n" +
    "[IDTWin]::Minimize($ids)\n} else { 0 }";
  const out = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps]);
  const m = /(\d+)\s*$/.exec(String(out).trim());
  if (!m) {
    // No count came back: the 6s timeout hit, or Add-Type was blocked (AV,
    // Constrained Language Mode). Say so — otherwise the dashboard shows the
    // block as active while the laptop silently enforces nothing.
    log("WARNING: minimize sweep returned no result — blocks may not be enforced on this laptop.");
    return 0;
  }
  return parseInt(m[1], 10);
}

// Low-level keyboard lock, shared by the pause overlay AND the locked
// full-screen message. Suppresses only — it never records a key — and is
// removed the moment the lock ends.
//
// The Windows-key suppression is what stops a student sliding out of a
// full-screen lock with Win+Ctrl+←/→ onto another virtual desktop, which left
// them with a free machine while the instructor's screen still showed the lock.
const LOCK_CSHARP = [
  "using System;",
  "using System.Runtime.InteropServices;",
  "public static class IDTLock {",
  "  public delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);",
  "  [DllImport(\"user32.dll\")] static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);",
  "  [DllImport(\"user32.dll\")] static extern bool UnhookWindowsHookEx(IntPtr hhk);",
  "  [DllImport(\"user32.dll\")] static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);",
  "  [DllImport(\"kernel32.dll\")] static extern IntPtr GetModuleHandle(string name);",
  "  [DllImport(\"user32.dll\")] static extern short GetAsyncKeyState(int vKey);",
  "  [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);",
  "  static IntPtr hook = IntPtr.Zero;",
  "  static HookProc proc = HookCallback;",
  "  const int WH_KEYBOARD_LL = 13;",
  "  public static void Install(){ if(hook==IntPtr.Zero){ hook = SetWindowsHookEx(WH_KEYBOARD_LL, proc, GetModuleHandle(null), 0); } }",
  "  public static void Uninstall(){ if(hook!=IntPtr.Zero){ UnhookWindowsHookEx(hook); hook=IntPtr.Zero; } }",
  "  static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam){",
  "    if(nCode>=0){",
  "      int vk = Marshal.ReadInt32(lParam);",
  "      bool alt=(GetAsyncKeyState(0x12)&0x8000)!=0; bool ctrl=(GetAsyncKeyState(0x11)&0x8000)!=0;",
  "      if(vk==0x5B||vk==0x5C) return (IntPtr)1;",          // LWIN / RWIN (kills Win+Ctrl+Arrow desktop hop, Win+D/Tab/M/R)
  "      if(alt && (vk==0x09||vk==0x1B)) return (IntPtr)1;", // Alt+Tab, Alt+Esc
  "      if(alt && (vk==0x73||vk==0x20)) return (IntPtr)1;", // Alt+F4 (closes the lock, then opens Shut Down), Alt+Space (window menu -> Close)
  "      if(ctrl && vk==0x1B) return (IntPtr)1;",            // Ctrl+Esc (Start), Ctrl+Shift+Esc (Task Manager)
  "    }",
  "    return CallNextHookEx(hook, nCode, wParam, lParam);",
  "  }",
  "}",
].join("\n");

// Full-screen instructor message.
//   holdSec       — the OK button is HIDDEN and the window cannot be closed
//                   until this many seconds pass (a live countdown shows the
//                   remaining time). While locked, the window re-asserts itself
//                   if the student clicks away — so the cooldown can't be
//                   sidestepped by switching windows, only by killing the
//                   process from Task Manager (deliberately transparent).
//   autoCloseSec  — if >0, the message dismisses itself after this long.
function showMessage(text, holdSec, autoCloseSec) {
  text = text || "";
  holdSec = Math.max(0, Math.round(Number(holdSec) || 0));
  autoCloseSec = Math.max(0, Math.round(Number(autoCloseSec) || 0));
  log(`instructor message (fullscreen, hold ${holdSec}s${autoCloseSec ? `, auto-close ${autoCloseSec}s` : ""}): ${text}`);
  try {
    if (IS_WIN) {
      const safe = text.replace(/'/g, "''");
      const body =
        "Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase; " +
        "$script:rem=" + holdSec + "; $script:auto=" + autoCloseSec + "; $script:forceClose=$false; " +
        "$w=New-Object System.Windows.Window; $w.WindowStyle='None'; $w.WindowState='Maximized'; " +
        "$w.Topmost=$true; $w.ResizeMode='NoResize'; " +
        "$w.Background=(New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromRgb(10,13,8))); " +
        "$sp=New-Object System.Windows.Controls.StackPanel; $sp.VerticalAlignment='Center'; $sp.HorizontalAlignment='Center'; $sp.MaxWidth=1100; " +
        "$t=New-Object System.Windows.Controls.TextBlock; $t.Text='" + safe + "'; $t.FontSize=46; $t.FontWeight='Bold'; $t.TextWrapping='Wrap'; $t.TextAlignment='Center'; " +
        "$t.Foreground=(New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromRgb(148,214,10))); $t.Margin='40,40,40,24'; " +
        "$cd=New-Object System.Windows.Controls.TextBlock; $cd.FontSize=20; $cd.TextAlignment='Center'; $cd.Margin='0,0,0,20'; " +
        "$cd.Foreground=(New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromRgb(150,160,140))); " +
        "$b=New-Object System.Windows.Controls.Button; $b.Content='OK'; $b.Width=140; $b.Height=40; $b.FontSize=16; $b.HorizontalAlignment='Center'; " +
        "$b.Add_Click({ $script:forceClose=$true; $w.Close() }); " +
        "$sp.Children.Add($t)|Out-Null; $sp.Children.Add($cd)|Out-Null; $sp.Children.Add($b)|Out-Null; $w.Content=$sp; " +
        // block every close path (Alt+F4, task-switch close) until the hold elapses
        "$w.Add_Closing({ param($s,$e) if(($script:rem -gt 0) -and (-not $script:forceClose)){ $e.Cancel=$true } }); " +
        // re-assert focus while locked so the student can't just click away past it
        "$w.Add_Deactivated({ if($script:rem -gt 0){ $w.Topmost=$true; [void]$w.Activate() } }); " +
        "if($script:rem -le 0){ $b.Visibility='Visible'; $cd.Text='' } else { $b.Visibility='Collapsed'; $cd.Text=(\"You can dismiss this in {0}s\" -f $script:rem) } " +
        "if(($script:rem -gt 0) -or ($script:auto -gt 0)){ " +
        "$tm=New-Object System.Windows.Threading.DispatcherTimer; $tm.Interval=[TimeSpan]::FromSeconds(1); " +
        "$tm.Add_Tick({ " +
        "if($script:rem -gt 0){ $script:rem--; if($script:rem -le 0){ $b.Visibility='Visible'; $cd.Text='' } else { $cd.Text=(\"You can dismiss this in {0}s\" -f $script:rem) } } " +
        "if($script:auto -gt 0){ $script:auto--; if($script:auto -le 0){ $script:rem=0; $script:forceClose=$true; $tm.Stop(); $w.Close() } } " +
        // drop the keyboard lock the moment the message stops being compulsory
        "if($script:rem -le 0 -and $script:locked){ $script:locked=$false; [IDTLock]::Uninstall() } }); " +
        "$w.Add_Loaded({ $tm.Start() }) } " +
        // While the message is LOCKED, hold it the same way the pause screen does:
        // install the keyboard lock (which suppresses the Windows key, so
        // Win+Ctrl+arrow can't slide the student onto a clean virtual desktop and
        // out of the message) and re-grab the foreground on a timer.
        "$script:locked=$false; " +
        "$w.Add_Loaded({ [void]$w.Activate(); " +
        "  if($script:rem -gt 0){ $script:locked=$true; [IDTLock]::Install(); " +
        "    $hh=(New-Object System.Windows.Interop.WindowInteropHelper $w).Handle; " +
        "    $fg=New-Object System.Windows.Threading.DispatcherTimer; $fg.Interval=[TimeSpan]::FromMilliseconds(250); " +
        "    $fg.Add_Tick({ if($script:rem -gt 0){ [void][IDTLock]::SetForegroundWindow($hh); $w.Topmost=$true } else { $fg.Stop() } }); $fg.Start() } }); " +
        "$w.Add_Closed({ [IDTLock]::Uninstall() }); " +
        "[void]$w.ShowDialog();";
      // the shared lock class has to exist before the window script runs
      const ps = "$src = @'\n" + LOCK_CSHARP + "\n'@\nAdd-Type -TypeDefinition $src -ErrorAction SilentlyContinue\n" + body;
      // While the message is COMPULSORY, hold the whole machine: the keyboard
      // lock can't see a touchpad swipe to another virtual desktop, so the focus
      // guard makes that escape useless too. Lifted when the hold expires.
      if (holdSec > 0) {
        startFocusGuard("message", []);
        setTimeout(() => stopFocusGuard("message"), holdSec * 1000 + 500);
      }
      execFile("powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], { windowsHide: true }, () => {
        if (holdSec > 0) stopFocusGuard("message"); // dismissed early / window died
      });
    } else if (IS_MAC) {
      const safe = text.replace(/"/g, '\\"');
      const giveUp = autoCloseSec > 0 ? ` giving up after ${autoCloseSec}` : "";
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
  for (const [pat, meta] of appBlocks)
    if (meta && meta.expiry && meta.expiry < now) {
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
  // Never let two sweeps overlap: PowerShell spawns are slow, and overlapping
  // sweeps used to pile up and starve each other, making blocks flaky.
  if (enforcing) return;
  enforcing = true;
  try {
    // Blocks are enforced by MINIMIZING by default (anti-cheat safe); only
    // blocks explicitly sent with mode:"kill" are force-closed. Each group is
    // still one batched sweep, so at most two PowerShell spawns per pass.
    const minBlocks = [];
    const killBlocks = [];
    for (const [key, meta] of activeAppBlocks()) {
      // meta.pat is the real process-name pattern; `key` is its display form
      const b = { pat: (meta && meta.pat) || key, exclude: (meta && meta.exclude) || [], cmd: (meta && meta.cmd) || "" };
      if (meta && meta.mode === "kill") killBlocks.push(b);
      else minBlocks.push(b);
    }
    if (minBlocks.length) {
      const n = await minimizeMatchingMany(minBlocks);
      if (n > 0) log(`enforced blocks -> minimized ${n} window(s)`);
    }
    if (killBlocks.length) {
      const killed = await killMatchingMany(killBlocks);
      if (killed.length && IS_WIN) log(`enforced blocks -> killed ${killed.join(", ")}`);
    }
    enforceSites();
  } finally {
    enforcing = false;
  }
}

// ------------------------------------------------------------------- status
async function sendStatus(ws) {
  const { processes, windows, activeWindow } = await inspect();
  const blocked = [...activeAppBlocks()].map(([pattern, meta]) => ({
    pattern,
    expires_at: meta && meta.expiry ? meta.expiry / 1000 : 0,
    mode: meta && meta.mode === "kill" ? "kill" : "minimize",
  }));
  const blockedSites = [...activeSiteBlocks()].map(([domain, exp]) => ({
    domain,
    expires_at: exp ? exp / 1000 : 0,
  }));
  ws.send(JSON.stringify({ type: "status", windows, processes, activeWindow, blocked, blockedSites, sitesAvailable }));
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
// Optional exclusion substrings for a block (e.g. exclude "studio" so a Roblox
// block spares Roblox Studio). Applies to every pattern in the same command.
function collectExcludes(p) {
  const arr = [];
  if (p.exclude) arr.push(String(p.exclude).toLowerCase().trim());
  if (Array.isArray(p.excludes)) for (const x of p.excludes) arr.push(String(x).toLowerCase().trim());
  return [...new Set(arr.filter(Boolean))];
}
// Optional command-line requirement for a block — lets a block target a generic
// host process only when it is running the thing we care about (javaw running
// Minecraft, say, rather than every Java program on the laptop).
function collectCmd(p) {
  return String(p.cmd_match || p.cmdMatch || "").toLowerCase().trim();
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
    const exclude = collectExcludes(p);
    // Default to minimizing. Only an explicit mode:"kill" force-closes, so an
    // older hub (which sends no mode) gets the safe behaviour automatically.
    const mode = String(p.mode || "").toLowerCase() === "kill" ? "kill" : "minimize";
    const cmdAll = collectCmd(p);
    // A pattern may carry its own command-line requirement inline as
    // "name (cmd)" — the same form the dashboard shows on a block chip. That
    // makes the round trip work (a chip can be handed straight back to unblock)
    // and lets the per-class "always block" list, which stores plain strings and
    // has no cmd_match field, still express "javaw (minecraft)".
    const entries = pats.map((raw) => {
      const m = /^(.+?)\s*\(([^()]+)\)$/.exec(raw);
      return m ? { pat: m[1].trim(), cmd: m[2].trim() } : { pat: raw, cmd: cmdAll };
    });
    // Keyed by its display form so a command-line block is distinct from a plain
    // name block, and so the chip the dashboard shows is exactly the key an
    // unblock comes back with.
    for (const e of entries) appBlocks.set(e.cmd ? `${e.pat} (${e.cmd})` : e.pat, { expiry, exclude, mode, cmd: e.cmd, pat: e.pat });
    // one batched sweep now (not one PowerShell per pattern) so the first hit is snappy
    if (pats.length) {
      const blocks = entries.map((e) => ({ pat: e.pat, exclude, cmd: e.cmd }));
      if (mode === "kill") await killMatchingMany(blocks);
      else await minimizeMatchingMany(blocks);
      log(`blocking apps (${mode}): ${pats.join(", ")}${exclude.length ? ` (except ${exclude.join(", ")})` : ""} (${p.duration_sec ? p.duration_sec + "s" : "until lifted"})`);
    }
  } else if (action === "unblock_app") {
    // Accept either the display key the dashboard shows ("javaw (minecraft)") or
    // the bare process pattern ("javaw"), so unblocking works from either side.
    for (const pat of collectPatterns(p)) {
      appBlocks.delete(pat);
      for (const [key, meta] of [...appBlocks]) {
        if (key.startsWith(`${pat} (`) || (meta && meta.pat === pat)) appBlocks.delete(key);
      }
    }
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
  } else if (action === "close_tab") {
    closeCurrentTab();
  } else if (action === "focus_lock") {
    // Keep the student in the approved apps: anything whose window title doesn't
    // match the allow-list gets minimized about once a second. Titles, not
    // process names, so a browser counts as allowed only while it is on an
    // allowed page ("New Tab") and not once it has navigated somewhere else.
    if (p.on === false) {
      stopFocusGuard("manual");
    } else {
      const allow = (Array.isArray(p.allow) ? p.allow : String(p.allow || "").split(",")).map((s) => String(s).trim()).filter(Boolean);
      startFocusGuard("manual", allow);
      if (p.duration_sec) setTimeout(() => stopFocusGuard("manual"), Number(p.duration_sec) * 1000);
    }
  } else if (action === "minimize_all") {
    minimizeAll(p.direction);
  } else if (action === "send_keys") {
    sendKeys(p.keys != null ? p.keys : p.combo);
  } else if (action === "run_command") {
    runRemoteCommand(ws, p.command, p.request_id);
  } else if (action === "start_screenshot") {
    startScreenshot(ws);
  } else if (action === "stop_screenshot") {
    stopScreenshot();
  } else if (action === "stop_watch") {
    stopWatch();
  } else if (action === "update_agent") {
    updateAgent(ws, p.files, p.build);
  } else if (action === "pause") {
    pauseScreen(p.text, p.duration_sec);
  } else if (action === "resume") {
    resumeScreen();
  } else if (action === "message") {
    // hold_sec = OK stays locked this long; auto_close_sec = self-dismiss after
    // this long (0/omitted = neither). timeout_sec kept as a legacy alias for hold.
    showMessage(p.text || "", p.hold_sec != null ? p.hold_sec : p.timeout_sec, p.auto_close_sec);
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

// Close just the active browser TAB (Ctrl+W) — NOT the whole window. We inject
// the keystroke with keybd_event (see pressVks): a hidden PowerShell can't steal
// foreground focus, so the keys land on the focused browser, and an elevated
// (High-integrity) agent is allowed to inject into a normal (Medium) browser —
// UIPI only blocks the low→high direction. (WM_CLOSE closed the entire window;
// WScript.Shell.SendKeys was unreliable.)
function closeCurrentTab() {
  if (!IS_WIN) return;
  pressVks([0x11, 0x57]); // Ctrl (0x11) + W (0x57)
  log("close tab (Ctrl+W)");
}

// Show the desktop — minimize every window. We PostMessage the shell's own
// "minimize all" command (WM_COMMAND 419) to Shell_TrayWnd instead of
// SendKeys('#m'): synthetic Win+M is UIPI-blocked from an elevated agent, but a
// window message from high→medium integrity (the agent → explorer's tray) is
// allowed, so this works elevated or not.
// Show/hide the desktop — a REVERSIBLE toggle. Driven through the shell's own
// COM automation (Shell.Application MinimizeAll / UndoMinimizeALL) rather than
// by injecting Win+D with keybd_event.
//
// WHY NOT Win+D: injected keystrokes carry the LLKHF_INJECTED flag and game
// anti-cheat watches for them as macro/automation activity — the same class of
// problem that got student Roblox accounts flagged. The COM route asks the
// shell to do exactly what Win+D does, with no synthetic input at all.
// `direction`: "minimize" | "restore" | "toggle" (default).
// The instructor's Minimize button toggles; a SCHEDULED minimize must not —
// a blind toggle would minimize on Monday and then *restore* on Tuesday. The
// boolean is only our guess at the current state (COM has no "is it shown?"
// query) and drifts if the student restores windows by hand, so anything that
// wants a definite outcome says so explicitly.
let desktopShown = false;
function minimizeAll(direction) {
  if (!IS_WIN) return;
  const dir = String(direction || "toggle").toLowerCase();
  const restore = dir === "restore" ? true : dir === "minimize" ? false : desktopShown;
  const method = restore ? "UndoMinimizeALL" : "MinimizeAll";
  desktopShown = !restore;
  run("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `(New-Object -ComObject Shell.Application).${method}()`,
  ]);
  log(`toggle desktop (${method})`);
}

// ------------------------------------------------------ generic keystroke sender
// A modular building block: press an arbitrary modifier+key combo on the
// foreground window (e.g. win+d, win+m, ctrl+w, alt+F4, ctrl+shift+t). Uses
// keybd_event low-level injection — an elevated (High-integrity) agent CAN
// inject into a normal (Medium) window, so this works whether or not the agent
// runs as Administrator, unlike WScript.Shell.SendKeys. New shortcuts can be
// driven from the hub without shipping a new agent.
const VK = {
  ctrl: 0x11, control: 0x11, ctl: 0x11, alt: 0x12, shift: 0x10,
  win: 0x5b, meta: 0x5b, cmd: 0x5b, super: 0x5b,
  enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, space: 0x20,
  backspace: 0x08, bksp: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d, ins: 0x2d,
  home: 0x24, end: 0x23, pageup: 0x21, pgup: 0x21, pagedown: 0x22, pgdn: 0x22,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27, printscreen: 0x2c, prtsc: 0x2c,
};
// keys that need KEYEVENTF_EXTENDEDKEY for the OS to interpret them correctly
const VK_EXTENDED = new Set([0x5b, 0x26, 0x28, 0x25, 0x27, 0x24, 0x23, 0x21, 0x22, 0x2e, 0x2d, 0x2c]);
function vkFor(token) {
  const t = String(token || "").toLowerCase().trim();
  if (!t) return null;
  if (VK[t] != null) return VK[t];
  if (/^[a-z]$/.test(t)) return t.toUpperCase().charCodeAt(0); // A-Z -> 0x41..0x5A
  if (/^[0-9]$/.test(t)) return t.charCodeAt(0); // 0-9 -> 0x30..0x39
  const f = /^f([1-9]|1[0-9]|2[0-4])$/.exec(t);
  if (f) return 0x70 + (parseInt(f[1], 10) - 1); // F1..F24 -> 0x70..0x87
  return null;
}
// Press a chord of virtual-key codes on the focused window (down in order, then
// up in reverse). Shared by sendKeys() and closeCurrentTab().
function pressVks(codes) {
  if (!IS_WIN || !codes || !codes.length) return;
  const vksCsv = codes.join(",");
  const extCsv = codes.map((c) => (VK_EXTENDED.has(c) ? 1 : 0)).join(",");
  const ps =
    "Add-Type -Namespace IDTWin -Name Key -MemberDefinition '" +
    "[DllImport(\"user32.dll\")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.IntPtr extra);" +
    "'; " +
    "$vks=@(" + vksCsv + "); $ext=@(" + extCsv + "); " +
    // press modifiers+key in order (down)
    "for($i=0;$i -lt $vks.Count;$i++){ [IDTWin.Key]::keybd_event([byte]$vks[$i],0,[uint32]$ext[$i],[System.IntPtr]::Zero) } " +
    "Start-Sleep -Milliseconds 30; " +
    // release in reverse (up = flag | KEYEVENTF_KEYUP(2))
    "for($i=$vks.Count-1;$i -ge 0;$i--){ [IDTWin.Key]::keybd_event([byte]$vks[$i],0,[uint32]($ext[$i] -bor 2),[System.IntPtr]::Zero) }";
  execFile("powershell", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps], { windowsHide: true }, () => {});
}
function sendKeys(spec) {
  if (!IS_WIN) return; // (macOS keystrokes would use osascript; not needed for the beta)
  const tokens = Array.isArray(spec) ? spec : String(spec || "").split(/[+\s]+/);
  const codes = tokens.map(vkFor).filter((c) => c != null);
  if (!codes.length) {
    log(`send_keys: unrecognized combo ${JSON.stringify(spec)}`);
    return;
  }
  pressVks(codes);
  log(`send_keys: ${tokens.join("+")}`);
}

// ---------------------------------------------------- remote command (opt-in)
// For "complicated tasks" an admin may need to run an arbitrary shell command on
// a laptop. This is powerful, so it is OFF by default and must be explicitly
// enabled per-agent with IDT_ALLOW_EXEC=1 (the hub additionally restricts the
// command to the admin role). It is transparent: the command is logged, and the
// result is sent back so the admin sees the output.
function runRemoteCommand(ws, cmdline, requestId) {
  const cmd = String(cmdline || "").trim();
  if (!cmd) return;
  if (process.env.IDT_ALLOW_EXEC !== "1") {
    log(`run_command refused (remote exec disabled — set IDT_ALLOW_EXEC=1 to allow): ${cmd}`);
    try {
      ws.send(JSON.stringify({ type: "exec_result", request_id: requestId || "", ok: false, code: -1, stdout: "", stderr: "Remote command execution is disabled on this computer (set IDT_ALLOW_EXEC=1 on the agent to enable)." }));
    } catch (_) {}
    return;
  }
  log(`REMOTE COMMAND: ${cmd}`);
  const shell = IS_WIN ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
  const args = IS_WIN ? ["/d", "/s", "/c", cmd] : ["-c", cmd];
  execFile(shell, args, { timeout: 20000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
    try {
      ws.send(JSON.stringify({
        type: "exec_result",
        request_id: requestId || "",
        ok: !err,
        code: err && typeof err.code === "number" ? err.code : err ? 1 : 0,
        stdout: String(stdout || "").slice(0, 4000),
        stderr: String(stderr || (err && err.message) || "").slice(0, 2000),
      }));
      log(`run_command finished (code ${err ? (err.code || 1) : 0}); result sent`);
    } catch (e) {
      log(`run_command result send failed: ${e.message}`);
    }
  });
}

// ------------------------------------------------------ on-demand screen view
// A LIVE, LOW-RES screen thumbnail — captured ONLY while an instructor has this
// computer's control panel open (the hub starts it on open, stops it on close),
// so there is no continuous/background screen recording. A single persistent
// PowerShell loop grabs the primary screen ~1x/sec, scales it down, JPEG-encodes
// it, and prints one base64 frame per line; we forward each frame to the hub,
// which relays it to the viewing dashboard. Set IDT_ALLOW_SCREENSHOT=0 to disable.
function screenshotLoopScript() {
  return (
    "Add-Type -AssemblyName System.Drawing,System.Windows.Forms; " +
    // MUST come before anything measures the screen. Without it PowerShell is a
    // DPI-unaware process, so Windows reports the *scaled* desktop size (e.g.
    // 1600x1067 on a 2400x1600 screen at 150%) while CopyFromScreen copies
    // PHYSICAL pixels — you get the top-left ~44% of the screen and nothing else.
    // That was the "screenshot is stuck to the top-left corner" bug.
    "Add-Type -Namespace IDTs -Name Dpi -MemberDefinition '" +
    "[DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();" +
    "[DllImport(\"user32.dll\")] public static extern int GetSystemMetrics(int i);" +
    "'; [void][IDTs.Dpi]::SetProcessDPIAware(); " +
    "$tw=640; " + // scaled width (~360-480p); a tiny thumbnail, light on bandwidth
    "$enc=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }; " +
    "$ep=New-Object System.Drawing.Imaging.EncoderParameters 1; " +
    "$ep.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality,[long]42); " +
    "while($true){ try { " +
    // The VIRTUAL screen: the union of every monitor in true physical pixels
    // (SM_X/Y/CX/CYVIRTUALSCREEN = 76/77/78/79), so a second display is included
    // and the origin is right even when a monitor sits left of / above the primary.
    "$vx=[IDTs.Dpi]::GetSystemMetrics(76); $vy=[IDTs.Dpi]::GetSystemMetrics(77); " +
    "$vw=[IDTs.Dpi]::GetSystemMetrics(78); $vh=[IDTs.Dpi]::GetSystemMetrics(79); " +
    "if($vw -le 0 -or $vh -le 0){ $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $vx=$b.X; $vy=$b.Y; $vw=$b.Width; $vh=$b.Height } " +
    "$b=New-Object System.Drawing.Rectangle $vx,$vy,$vw,$vh; " +
    "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; " +
    "$g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.X,$b.Y,0,0,$bmp.Size); $g.Dispose(); " +
    "$th=[int]($tw*$b.Height/$b.Width); " +
    "$sm=New-Object System.Drawing.Bitmap $tw,$th; " +
    "$g2=[System.Drawing.Graphics]::FromImage($sm); $g2.InterpolationMode='HighQualityBicubic'; $g2.DrawImage($bmp,0,0,$tw,$th); $g2.Dispose(); $bmp.Dispose(); " +
    "$ms=New-Object System.IO.MemoryStream; $sm.Save($ms,$enc,$ep); $sm.Dispose(); " +
    "Write-Output ('@FRAME@'+[Convert]::ToBase64String($ms.ToArray())); $ms.Dispose(); " +
    "} catch {} Start-Sleep -Milliseconds 1000 }"
  );
}
function startScreenshot(ws) {
  if (!IS_WIN) return;
  if (process.env.IDT_ALLOW_SCREENSHOT === "0") {
    log("screenshot requested but disabled (IDT_ALLOW_SCREENSHOT=0).");
    return;
  }
  if (screenshotChild) return; // already streaming
  log("screen view started (an instructor opened this computer's panel).");
  screenshotChild = spawn(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", screenshotLoopScript()],
    { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
  );
  let buf = "";
  screenshotChild.stdout.on("data", (chunk) => {
    buf += chunk.toString("latin1"); // base64 is ASCII; latin1 avoids UTF surprises
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line.startsWith("@FRAME@")) {
        try {
          ws.send(JSON.stringify({ type: "screenshot_frame", data: line.slice(7) }));
        } catch (_) {}
      }
    }
    if (buf.length > 1e6) buf = ""; // safety: never let the buffer grow unbounded
  });
  screenshotChild.on("exit", () => {
    screenshotChild = null;
  });
}
function stopScreenshot() {
  if (screenshotChild) {
    try {
      screenshotChild.kill();
    } catch (_) {}
    screenshotChild = null;
    log("screen view stopped.");
  }
}

// -------------------------------------------------------------- pause / resume
// A full-screen, always-on-top overlay so students stop and look up. It stays
// until the instructor resumes, and REOPENS if the student closes it. It is not
// an OS lock (an admin could Task-Manager out of it) — deliberately transparent,
// meant for a supervised classroom.
function pauseScreen(text, durationSec) {
  pauseMessage = text || "Paused by your instructor. Eyes up front.";
  pauseActive = true;
  // Optional auto-resume (used by timed/scheduled pauses): resume on our own
  // after durationSec so the instructor doesn't have to send a manual Resume.
  if (pauseTimer) {
    clearTimeout(pauseTimer);
    pauseTimer = null;
  }
  const dur = Math.max(0, Math.round(Number(durationSec) || 0));
  if (dur > 0) {
    pauseTimer = setTimeout(() => {
      pauseTimer = null;
      log(`auto-resume after ${dur}s`);
      resumeScreen();
    }, dur * 1000);
  }
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
  // Nothing is allowed while paused — if the student hops to another virtual
  // desktop (a touchpad swipe does it with no keystroke to intercept), whatever
  // they open there is pushed straight back down.
  startFocusGuard("pause", []);
  log("screen paused");
}

// A hardened full-screen "eyes up front" lock. Kids were escaping the old
// overlay via Alt+Tab, minimize (from Task Manager), and Win+Ctrl+→ (virtual
// desktop switch). This version:
//   • is NOT in the taskbar and snaps back to Maximized if anything minimizes it;
//   • re-grabs the foreground whenever it loses focus (defeats Alt+Tab) and on a
//     250ms timer (defeats desktop switches and "TM on top");
//   • installs a low-level keyboard hook WHILE PAUSED that suppresses the Windows
//     keys (kills Win+Ctrl+Arrow, Win+D/Tab/M/R), Alt+Tab/Alt+Esc, Alt+F4 /
//     Alt+Space, and Ctrl+Esc / Ctrl+Shift+Esc (Start menu / Task Manager). The
//     hook only suppresses — it never logs a key — and is removed the instant
//     the pause ends.
//   • refuses any close request it did not initiate (Add_Closing cancels), so
//     even a close that dodges the hook cannot drop the student to the desktop.
//     Alt+F4 was the live escape: it closed the lock, and a second Alt+F4 on the
//     bare desktop opens "Shut Down Windows" — letting a student reboot out.
//   • a 30-minute failsafe auto-closes it so a lock can never get stuck.
// NOTE: Ctrl+Alt+Del is a kernel Secure Attention Sequence and cannot be blocked
// from user mode; and a global keyboard hook can trip some AV heuristics (it's
// transient + suppress-only here). Full lockdown would need an MDM kiosk policy.
function spawnPauseWindow() {
  if (pauseChild || !pauseActive) return;
  if (!IS_WIN) return pauseScreen(pauseMessage);
  const safe = pauseMessage.replace(/'/g, "''");
  const csharp = LOCK_CSHARP;
  const win =
    "Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase; " +
    "$script:allowClose=$false; " +
    "$w=New-Object System.Windows.Window; $w.WindowStyle='None'; $w.WindowState='Maximized'; " +
    "$w.Topmost=$true; $w.ResizeMode='NoResize'; $w.ShowInTaskbar=$false; " +
    "$w.Background=(New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromRgb(0,0,0))); " +
    "$t=New-Object System.Windows.Controls.TextBlock; $t.Text='" + safe + "'; " +
    "$t.Foreground=(New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromRgb(148,214,10))); " +
    "$t.FontSize=44; $t.FontWeight='Bold'; $t.TextWrapping='Wrap'; $t.TextAlignment='Center'; " +
    "$t.HorizontalAlignment='Center'; $t.VerticalAlignment='Center'; $t.Margin='40'; $w.Content=$t; " +
    // snap back if anything minimizes/restores it; reclaim focus if Alt+Tabbed away
    "$w.Add_StateChanged({ if($w.WindowState -ne 'Maximized'){ $w.WindowState='Maximized' } }); " +
    "$w.Add_Deactivated({ $w.Topmost=$true; [void]$w.Activate() }); " +
    // Refuse EVERY close we did not ask for. Belt-and-braces with the Alt+F4 key
    // suppression above: if a close request still reaches the window (a stray
    // WM_CLOSE, a shell "close window" verb), it is cancelled rather than
    // leaving the desktop focused — which is what let a student Alt+F4 the lock
    // and then Alt+F4 again to reach the Shut Down dialog and reboot out of it.
    "$w.Add_Closing({ param($s,$e) if(-not $script:allowClose){ $e.Cancel=$true } }); " +
    "$w.Add_Loaded({ [IDTLock]::Install(); [void]$w.Activate(); " +
    "  $hh=(New-Object System.Windows.Interop.WindowInteropHelper $w).Handle; " +
    "  $tm=New-Object System.Windows.Threading.DispatcherTimer; $tm.Interval=[TimeSpan]::FromMilliseconds(250); " +
    "  $tm.Add_Tick({ [void][IDTLock]::SetForegroundWindow($hh); $w.Topmost=$true }); $tm.Start(); " +
    "  $fs=New-Object System.Windows.Threading.DispatcherTimer; $fs.Interval=[TimeSpan]::FromMinutes(30); " +
    "  $fs.Add_Tick({ $fs.Stop(); [IDTLock]::Uninstall(); $script:allowClose=$true; $w.Close() }); $fs.Start() }); " +
    "$w.Add_Closed({ [IDTLock]::Uninstall() }); " +
    "[void]$w.ShowDialog();";
  const ps = "$src = @'\n" + csharp + "\n'@\nAdd-Type -TypeDefinition $src -ErrorAction SilentlyContinue\n" + win;
  pauseChild = spawn("powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], {
    windowsHide: true,
    stdio: "ignore",
  });
  pauseChild.on("exit", () => {
    pauseChild = null;
    // The lock went away but the instructor hasn't resumed — bring it back.
    // Kept short: this gap is the window in which the bare desktop has focus,
    // and that is precisely where a second Alt+F4 would reach "Shut Down".
    if (pauseActive) setTimeout(spawnPauseWindow, 120);
  });
}

function resumeScreen() {
  pauseActive = false;
  stopFocusGuard("pause");
  if (pauseTimer) {
    clearTimeout(pauseTimer);
    pauseTimer = null;
  }
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
  try {
    if (screenshotChild) screenshotChild.kill();
  } catch (_) {}
  // never leave a sweeper minimizing the student's windows after we exit
  focusReasons.clear();
  try {
    if (focusChild) focusChild.kill();
  } catch (_) {}
}
function cleanupAndExit(code) {
  cleanupHosts();
  killHelpers();
  process.exit(code);
}

// Remote decommission: drop the same stop.flag that "Stop iD Tech Watch.cmd"
// writes, so the watchdog stops BOTH this agent and its guardian (no relaunch),
// then exit. Run standalone (no watchdog), writing the flag is harmless and we
// still exit. DIR matches watch.js (env override or the default install path).
function stopWatch() {
  try {
    const dir = process.env.IDT_WATCH_DIR || "C:\\Users\\Student\\projects\\iD-Tech";
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "stop.flag"), "stop");
    log("stop_watch: wrote stop.flag — the watchdog will stop both processes.");
  } catch (e) {
    log(`stop_watch: could not write stop.flag (${e.message}); exiting anyway.`);
  }
  setTimeout(() => cleanupAndExit(0), 800); // let the log flush, then drop off
}

// Remote software update: the hub (admin) pushes the latest agent.js / watch.js
// source; we write them into the install dir (leaving watch-config.json — device
// name/server/building — untouched) and re-launch on the new code. No per-laptop
// reinstall. Each incoming file is syntax-checked BEFORE it replaces the running
// copy, and the old copy is backed up (.bak), so a bad push can't brick a laptop.
function updateAgent(ws, files, build) {
  const dir = process.env.IDT_WATCH_DIR || "C:\\Users\\Student\\projects\\iD-Tech";
  // incoming file name -> destination file name in the install dir
  const dstFor = { "agent.js": "agent.js", "id-tech-watch.js": "id-tech-watch.js", "watch.js": "id-tech-watch.js" };
  const wrote = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files || {})) {
      const dstName = dstFor[name];
      if (!dstName || typeof content !== "string" || content.length < 500) {
        log(`update_agent: skipping ${name} (unknown/too small)`);
        continue;
      }
      // syntax-check before overwriting (strip a leading shebang; new Function
      // parses without executing — a syntax error throws and we abort this file).
      try {
        new Function(content.replace(/^#![^\n]*\n/, ""));
      } catch (e) {
        throw new Error(`${name} failed syntax check: ${e.message}`);
      }
      const dst = path.join(dir, dstName);
      try {
        if (fs.existsSync(dst)) fs.copyFileSync(dst, dst + ".bak");
      } catch (_) {}
      fs.writeFileSync(dst, content);
      wrote.push(dstName);
    }
    log(`update_agent: wrote ${wrote.join(", ") || "(nothing)"}${build ? ` (build ${build})` : ""}; relaunching…`);
    try {
      ws.send(JSON.stringify({ type: "update_result", ok: true, wrote, build: build || "" }));
    } catch (_) {}
    // Re-launch via the installed launcher, which clean-restarts BOTH workers on
    // the fresh code (it stop-flags the old pair, waits, then starts new ones).
    const launcher = path.join(dir, "id-tech-watch.js");
    if (wrote.length && fs.existsSync(launcher)) {
      setTimeout(() => {
        try {
          spawn(process.execPath, [launcher], { cwd: dir, detached: true, stdio: "ignore", windowsHide: true }).unref();
        } catch (e) {
          log(`update_agent: relaunch failed: ${e.message}`);
        }
      }, 700);
    } else if (wrote.length) {
      log("update_agent: no launcher in install dir — new code loads on next restart.");
    }
  } catch (e) {
    log(`update_agent FAILED (kept current version): ${e.message}`);
    try {
      ws.send(JSON.stringify({ type: "update_result", ok: false, error: e.message }));
    } catch (_) {}
  }
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
    name: "", // student/display name shown on the monitor (editable from dashboard)
    device: null, // optional explicit machine id (else derived from hostname+MAC)
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
    else if (key === "--name") (a.name = val), i++;
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

  if (!WS) {
    console.error(
      "No WebSocket client available (needs Node 22+ global WebSocket, or the `ws` package)."
    );
    process.exit(1);
  }

  log(`build ${BUILD}`);
  log(`id=${deviceId}`);
  log(
    `location=${JSON.stringify(args.location)} building=${JSON.stringify(args.building)}` +
      (args.klass ? ` class-hint=${JSON.stringify(args.klass)}` : "")
  );
  log("MONITORING ACTIVE: this laptop is managed by an iD Tech instructor.");
  if (args.keepAwake) keepAwake();

  // Enforce blocks on a steady cadence, independent of connectivity.
  setInterval(() => {
    enforce().catch(() => {});
  }, ENFORCE_INTERVAL_MS);

  function connect() {
    const url = args.server.replace(/\/+$/, "") + "/ws/agent";
    log(`connecting to ${url}`);
    const ws = new WS(url);
    let statusTimer = null;

    ws.onopen = () => {
      log("connected.");
      ws.send(
        JSON.stringify({
          type: "register",
          device_id: deviceId,
          hostname: os.hostname(),
          name: args.name || "", // student/display name (seeds the dashboard name)
          build: BUILD, // which agent version this laptop is running (for remote updates)
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

// Run when executed directly; export main() so the watchdog can run it in-process.
if (require.main === module) {
  main();
}
module.exports = { main };
