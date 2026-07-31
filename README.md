# iD Tech Watch

A classroom-management system for iD Tech Camps. Instructors watch the open
windows on every laptop in their class, close unauthorized apps, temporarily
block games and gaming websites (Roblox, Minecraft, Steam, poki.com and so on),
pause screens, rename computers to the week's students, and schedule daily
events. Admins manage the whole org (**Location → Building → Class → Computer**)
from a web panel, with everything editable week to week.

Beta target: **Stanford campus** (single hub on the classroom LAN), seeded with
the Tresidder, Grove, Phi Psi, French, and Warehaus buildings. The Location tier
is the worldwide-scaling axis: add "MIT", "London", and so on when you expand.

The hub and dashboard need Node.js 18+ (22 or newer recommended). The dashboard
vendors one small library, `fuzzysort`; the hub has no other dependencies. The
packaged client (`iD-Tech-Watch.zip`) bundles the signed `node.exe`, so target
laptops need nothing installed.

---

## ⚠️ Responsible use (read first)

For **camp-managed laptops** in a **supervised, in-person classroom** with minors:

- **Transparent, not covert.** The agent runs visibly, prints what it's doing,
  and shows a "monitoring is active" notice. Tell students (and parents, per iD
  Tech policy) that class laptops are monitored.
- **Minimal data.** What it reports continuously is window titles and app names.
  No keystrokes, passwords, webcams, or background screen recording. A live
  screen thumbnail can be viewed on demand: it is captured only while an
  instructor has that one computer's control panel open, at roughly 1 fps and low
  resolution, and it stops the moment the panel closes. Nothing is stored. Tell
  students their screen may be viewed while class laptops are monitored, and set
  `IDT_ALLOW_SCREENSHOT=0` on the agent to turn the feature off entirely.
- Do not deploy on personal or BYO devices, or outside a supervised class.

---

## What it can do

**View.** A live grid of every laptop in a class, showing open window titles and
running apps.

**Seating chart (canvas mode).** Switch the class view from **▦ Grid** to **🪑
Seating** for a 2D map of the room. Drag each computer to where the student
actually sits so you remember who's who. Positions are saved per class and shared
with any co-instructor viewing that class. Tap a computer on the map to open its
control panel (block games, close apps, message, refresh). It works with mouse and
touch alike, so you can use it on a phone or tablet while you walk the room.
**Reset layout** auto-arranges everything again.

**House lab layout (building canvas).** Drill into a building and switch **▦
Classes** to **🪑 Lab layout** to see every classroom in that house on one canvas,
under a shared "front of classes ↑" header. Each room is a mini seating chart.
Unlock (🔓) and drag a room by its title bar to arrange the classrooms the way the
house is physically laid out. Positions are saved per building and shared with
anyone else viewing it. Tap a room's title to drill into that class, or tap a
computer to control it. **Reset layout** puts the rooms back into rows.

**Block apps.** One click blocks a game everywhere it's selected, for a chosen
duration (5 minutes up to until you lift it). The **Method** control in the top
bar decides how a block is enforced:

- **Minimize** (the default) keeps shoving the game's window back down. The game
  stays running but is unusable, and if the student restores it, the next
  enforcement pass a couple of seconds later minimizes it again.
- **Force close** terminates the app outright.

> ⚠️ **Use Minimize for games with anti-cheat, Roblox especially.** Repeatedly
> force-closing a game client from an outside process looks like tampering, and
> student Roblox accounts were being flagged for cheating and macros, then
> disabled for the rest of the day. Minimizing only asks the window manager to
> move a window. It opens no handle on the game process and injects no keystrokes,
> so it doesn't trip those checks. Force close is still there for ordinary apps
> where you genuinely want the process gone.

Built-in presets:

| Preset            | Blocks (apps)                | Blocks (websites)                              |
|-------------------|------------------------------|------------------------------------------------|
| Roblox (Player)   | `*roblox*` **except** `*studio*` | roblox.com                                  |
| Minecraft †       | `*minecraft*`, **plus** `*javaw*`/`*java*` whose **command line** contains `minecraft` | minecraft.net, classic.minecraft.net |
| Fortnite          | `*fortnite*`                 | —                                              |
| Steam             | `*steam*`                    | steampowered.com, steamcommunity.com           |
| Epic Games        | `*epicgames*`, `*fortnite*`  | epicgames.com                                  |
| Gaming websites   | —                            | poki.com, coolmathgames.com, crazygames.com, miniclip.com, y8.com, addictinggames.com, kongregate.com, armorgames.com, friv.com, gamejolt.com |
| All games + sites | everything above **except Minecraft** | everything above **except Minecraft**  |

† **Minecraft is handled specially, for two reasons.**

*Blocking the running game.* Java Edition doesn't run as `minecraft.exe`. The
launcher does, but the game itself is `javaw.exe`, which is why a plain name block
could stop the launcher and the website yet never touch a student already in a
world. The preset adds a second block matching `javaw` or `java` only when the
process command line mentions minecraft, so the game is caught while BlueJ,
Processing, IntelliJ and any Java coursework on the same laptop are left alone.

*Kept out of "all games".* Minecraft is taught in some classes, so it is
deliberately left out of **Block all games + sites**, and out of the "Block all
games" scheduled event. Block it explicitly for the periods a class shouldn't be
playing, either from the Block menu or with the **Block Minecraft** scheduled
event. Saved "Block all games" events from before this change are migrated when
the hub starts, so they stop blocking Minecraft too.

> **Caveat:** the match is a plain substring on the command line, so a Java program
> that legitimately mentions minecraft will also be caught: a student's
> `MinecraftClone` project run from BlueJ, say, or Forge mod-development tooling.
> In a class that codes Minecraft-adjacent Java, block the launcher by name only
> (**Custom app…** → `minecraft`) instead of using the preset.

There is also **Custom app…** for any process-name substring such as `discord`,
and **Custom website…** for any domain such as `twitch.tv`. **Close app…** kills
an app once, and **Message…** pops a note on the student's screen.

**Block websites** works by editing the laptop's hosts file, so it needs the agent
to run as Administrator (see below). App blocking does not need elevation.

**Close tabs.** A hosts block only stops new page loads, so a **Close tabs**
button (and a "Close all browsers" item in the Block menu) closes every browser
window immediately, clearing a site that is already open.

**Always block for this class.** Under the class toolbar, add apps that should
stay blocked for that class permanently. These persist across restarts and are
re-applied when a laptop reconnects. The add box autocompletes from the apps
currently open across the class: type or pick one, and Tab fills the top match and
adds it. Unknown names are allowed too. This is the right place for "this class
never plays Minecraft", and an entry can use the form `name (command-line text)`,
for example `javaw (minecraft)`, to match a host process only when its command
line contains that text. That way the Java game is blocked and other Java programs
aren't. It's the same form shown on the block chips, so a chip can be handed
straight back to unblock it.

**Pause.** **⏸ Pause** covers every screen with a full-screen "eyes up front"
overlay that reopens if a student closes it, until you press **▶ Resume**. While
paused, the agent suppresses the usual escape routes: the Windows key (which also
stops Win+Ctrl+←/→ hopping to another virtual desktop), Alt+Tab, Alt+Esc, Alt+F4,
Alt+Space, Ctrl+Esc and Ctrl+Shift+Esc. It refuses any close it didn't initiate,
and it survives a reboot: a laptop that restarts while paused gets the lock back
as soon as it reconnects, and a timed pause returns with only the time still left
on it. Ctrl+Alt+Del is a kernel-level sequence and can't be blocked from user
mode.

A locked full-screen message holds the machine the same way a pause does. For as
long as its hold is running it installs the same key lock, so it can't be Alt+F4'd
away or escaped with Win+Ctrl+←/→ onto another virtual desktop.

Keys alone aren't enough, though. A three-finger touchpad swipe changes desktop
with no keystroke at all, so no keyboard hook can see it. While a pause or a held
message is up, the agent also runs a **focus guard**: roughly once a second it
minimizes every window that isn't allowed, wherever it appears. Switching desktops
still works, it just gets you an empty one, because anything you open is pushed
straight back down. The guard skips windows with no title, which is what the lock
itself reports, so it can never minimize the lock it is protecting.

**🎯 Focus…** exposes the same mechanism on its own, for keeping a class in the
curriculum apps. Give it a list of window-title substrings (the default is
`gameplan, new tab, vex, v5`) and anything whose title doesn't match is minimized
on sight. Matching on the title rather than the app means a browser
counts as allowed only while it is on an allowed page: *New Tab* passes, the same
browser on a game site does not. Clear the list to allow nothing at all.

**Message / Lock (one composer).** The **✉ Message / Lock…** button opens a real
in-app dialog, with no browser pop-ups, that does both jobs. A **Pop-up message**
is a dismissible note; you can lock the OK button for a few seconds, auto-dismiss
it after a while, or both. **Lock the screen** puts up a full-screen cover that
stays, reopening if closed, until you Resume or until it auto-resumes after a set
number of minutes. The hold timer genuinely holds: OK stays hidden until it
elapses, and the window re-asserts itself if the student clicks away.

**Advanced actions**, under "Do now" in the Block… menu. **Send keyboard
shortcut…** presses any combo on the front window (`win+d`, `ctrl+w`, `alt+F4`).
For admins, **Run command…** runs a shell command on the target computers and
shows the output; see the security note under the packaged client.

**Scheduled events.** In the Admin panel, schedule daily timed actions such as
"Pause all computers at 12:00" or "Block all games at 1:00, unblock at 1:30", by
location, building, class or everyone, on chosen days. Two event types take a
duration. **Pause** uses `Pause for (min)`, where 0 keeps it up until a Resume.
**Full-screen message** uses `Show for (sec)`: the message is locked on screen for
that long and then dismisses itself, and 0 shows it as dismissible straight away
and leaves it until the student clicks OK.

**Find things fast.** Every picker (location, building, class) has a right-aligned
fuzzy search powered by `fuzzysort`. Matches float to the front, non-matches dim
but stay clickable, arrow keys and mouse both navigate, and Tab jumps straight
into the top match.

**Try it with fake computers.** Visit `/demo`, or the **Demo** button at top
right, for a simulated classroom with fake laptops to learn the flow. Nothing real
is touched.

**Bookmark your class.** Once you're in a class the URL becomes
`/{Location}/{Instructor}`, for example `/Stanford/Ada%20Lovelace`, so you can
bookmark it and jump straight back in.

**Per-building instructor code.** Buildings are gated by a 4-digit code, 8676 by
default, that auto-submits when entered. Admins set each building's code in the
panel.

> Notes and limits: the Roblox preset blocks the Player (`RobloxPlayerBeta`) but
> spares Roblox Studio (`RobloxStudioBeta`), the tool used in Roblox coding
> classes, by blocking `roblox` while excluding `studio`. The `minecraft` pattern
> catches the launcher and Bedrock edition; Java Edition is caught by the separate
> command-line rule described above. Website blocks stop new page loads, so an
> already-open tab isn't force-closed. A browser with Secure DNS (DNS-over-HTTPS)
> enabled can bypass the hosts file, so disable it or push a browser policy on lab
> machines.

---

## Concepts

```
Location (Stanford)
  └─ Building (Gates Computer Science)
       └─ Class (Roblox Game Dev — instructor, room)   ← renamed weekly by admin
            └─ Computer (a laptop running the agent)
```

- **Computers** are physical laptops. Each runs the agent, configured once with
  its stable **location + building**. They appear in the console automatically.
- **Classes** are managed centrally by an admin (name, instructor, room) and
  change every week, without touching any laptop. Admins assign computers to the
  week's class in the admin panel.
- **Locations & buildings** auto-populate as agents check in, and are editable.

## Roles & access

| Role       | Signs in with     | Can do                                                                 |
|------------|-------------------|------------------------------------------------------------------------|
| Instructor | nothing (open)    | Drill down Location → Building → Class and control that class's computers |
| Admin      | admin password    | Everything an instructor can, plus manage the org, classes, instructors, computer assignments, scheduled events, and settings |

- **Instructors sign in with no password.** Access is gated **per building** by a
  **4-digit code** (default **8676**) that auto-submits when typed. Admins set each
  building's code in the Organization panel.
- The initial **admin password** comes from `IDT_ADMIN_PASSWORD` (or defaults to
  `changeme` with a warning). Change it in **Admin → Settings**. Only a salted
  scrypt hash is stored, in `data/config.json`.

## Other instructor tools

- **Rename computers** to the week's student (✎ Rename on a card / seat / admin
  table). The name persists by device and survives reconnects; blank resets it to
  the hostname.
- **Seating chart** (🪑 Seating): drag computers onto a 16×12 room grid; positions
  snap to the grid and save per class. Tap one to control it.
- **Bookmarkable URLs**: the address bar tracks where you are, through `/`,
  `/admin` (login-gated), `/Stanford`, `/Stanford/Tresidder` and
  `/Stanford/Tresidder/{Class}`.
- **Fuzzy search** (right of each picker) jumps to a location/building/class; Tab
  picks the top match.
- **Scheduled events** (Admin) run daily at a set time and can target **any mix of
  classes, whole buildings, and whole campuses** at once (e.g. one "Lunch pause"
  for Grove + Phi Psi + French + Warehaus, a different one for Tresidder).

---

## 🧪 Beta test on ONE local machine (step by step)

This runs the hub and a "student" agent on the same computer, which is the
fastest way to try everything. Windows PowerShell is shown below; macOS and Linux
use the same commands.

**1. Install Node.js 18+** (22+ recommended). Check it:

```bash
node --version
```

If that errors, install from https://nodejs.org (LTS), then reopen your terminal.

**2. Start the hub.** In a terminal, from the project folder:

```bash
$env:IDT_ADMIN_PASSWORD = "letmein"
node server/server.js
```

You'll see something like:

```
[hub] ready - open the console in a browser:
[hub]   on this computer:    http://localhost:8765/
[hub]   from other laptops:  http://10.0.0.42:8765/
```

Leave this terminal running.

**3. Start an agent.** Open a **second** terminal in the same folder. For the full
experience (including website blocking) run it elevated with the helper:

```bash
.\scripts\run_agent.ps1 -Server ws://localhost:8765 -Location "Stanford" -Building "Gates Computer Science" -Class "My Test Class"
```

This asks for Administrator (needed for website blocking) and adds `--keep-awake`.
To skip elevation (app blocking only), add `-NoElevate`, or run the agent directly:

```bash
node agent/agent.js --server ws://localhost:8765 --location "Stanford" --building "Gates Computer Science" --class "My Test Class"
```

**4. Open the console.** Go to **http://localhost:8765/**, click **Admin**, and
sign in with the password from step 2 (`letmein`).

**5. Look around.**
- **Admin panel** → *Organization*: rename the class, set the instructor and room.
  *Computers*: your laptop is listed and assigned to the class.
- Click **Monitor** (top bar) → **Stanford → Gates… → your class**. You'll see this
  laptop with its live open windows.
- Switch to **🪑 Seating** and drag the computer around the room; reload the page and
  it stays put. Tap it to open its control panel.

**6. Try the controls** on yourself; it's safe to test.
- Open a browser tab to `poki.com`, then pick **Block… → Gaming websites** in the
  class toolbar. Reload the tab and it should fail to load. If it still loads,
  your browser's Secure DNS is bypassing the hosts file, so turn that off.
- Open something like Notepad, then **Block… → Custom app… →** `notepad`. With the
  default Minimize method its window is pushed back down every couple of seconds
  for the chosen duration; switch **Method** to Force close if you want it killed.
- Click **Unblock all** to clear everything.

That's a full end-to-end beta on one machine.

---

## Adding a second laptop (or a whole classroom)

The hub stays on one machine (your admin/instructor laptop). Each **student laptop**
just needs Node and the agent:

1. Copy this folder to the laptop (or at minimum `agent/agent.js` + the `scripts`
   folder). A USB stick or shared drive is fine.
2. Install Node.js 18+ on it.
3. Find the hub's **LAN address** in the hub's startup log (e.g.
   `http://10.0.0.42:8765/`).
4. On the hub machine, allow Node through the firewall the first time Windows asks
   (choose **Private networks**). Both machines must be on the same Wi-Fi/LAN.
5. On the student laptop, run the agent pointed at the hub's LAN IP:

```bash
.\scripts\run_agent.ps1 -Server ws://10.0.0.42:8765 -Location "Stanford" -Building "Gates Computer Science"
```

The laptop appears in the admin **Computers** list automatically; assign it to a
class and it shows up for the instructor.

Optional shared secret so only your agents can join: set `IDT_ENROLL_TOKEN` on the
hub, and pass `--token <same value>` to each agent.

---

## Keeping it running (even when laptops sleep)

- **Don't sleep while running.** The agent's `--keep-awake` (added automatically by
  `run_agent.ps1`) holds a wake lock so the laptop won't sleep while class is on.
  For the hub, start it with `$env:IDT_KEEP_AWAKE = "1"` before `node server/server.js`.
  The wake lock is released as soon as the process stops (screens may still turn
  off; the machine just won't sleep).
- **Auto-start on boot + auto-restart.** On each student laptop, in an
  **Administrator** PowerShell:

```bash
.\scripts\install-agent-startup.ps1 -Server ws://10.0.0.42:8765 -Location "Stanford" -Building "Gates Computer Science"
```

  This registers a Scheduled Task that launches the agent at every logon, elevated
  (so website blocking works), keeps it awake, and restarts it if it exits. Remove
  it with `Unregister-ScheduledTask -TaskName "iDTechClassroomAgent" -Confirm:$false`.
- The agent also **auto-reconnects** to the hub after any network drop or sleep, and
  keeps enforcing active blocks even while briefly offline.

> Even with a wake lock, if a laptop is manually closed/hibernated it stops until it
> wakes; on wake the agent reconnects within a few seconds. Fully preventing
> hibernation is a Windows power-plan setting (`powercfg`) that's best pushed via
> your device policy.

---

## Message protocol (WebSocket JSON)

**Agent → Hub:** `register` (device_id, hostname, **name** (student/display name),
**build** (agent version, so the hub can flag outdated laptops), os, location,
building, klass?, token) · `status` (windows, **activeWindow** (the foreground
window's title, highlighted in the instructor's list), processes, blocked,
blockedSites, sitesAvailable) · `exec_result` (result of a `run_command`, relayed
to admin dashboards) · `screenshot_frame` (a base64 JPEG live-screen frame, relayed
only to the dashboard viewing that computer) · `update_result` (outcome of a remote
software update). The `device_id` is a stable
machine id (derived from hostname+MAC, or an explicit `--device`); `name` is the
editable display name and seeds the dashboard's per-device name (a dashboard rename
overrides it).

**Hub → Agent:** `command` with `action` ∈ `kill_process | block_app | unblock_app |
block_site | unblock_site | unblock_all | close_browsers | close_tab | minimize_all |
send_keys | run_command | stop_watch | start_screenshot | stop_screenshot | pause |
resume | message | list_now`. `block_app` accepts `pattern` or `patterns[]` plus an
optional `exclude[]`, a list of substrings to spare (block `roblox` while sparing
`studio`, for instance). `block_site` accepts `domain` or `domains[]`. Both accept
`duration_sec`, where omitting it or passing 0 means until lifted.

`block_app` also accepts `mode`: `"minimize"` is the default and keeps the app's
windows minimized via `EnumWindows` and `ShowWindow(SW_FORCEMINIMIZE)`, opening no
handle on the process; `"kill"` force-closes. An older hub that sends no `mode`
gets the safe minimize behaviour automatically. It further accepts `cmd_match`, a
substring that must appear in the process's command line for the block to apply.
That is how `javaw.exe` is blocked when, and only when, it is running Minecraft.
Command lines are read with `Get-CimInstance Win32_Process`, which is slower than
`Get-Process`, so that path is only taken when a block actually asks for it.

`pause` accepts `text` and an optional `duration_sec` for auto-resume, where the
agent lifts the lock on its own and the hub also sends a resume. `message` accepts
`hold_sec`, which hides and locks the OK button for that long, and
`auto_close_sec` for self-dismissal.

`focus_lock` takes `on`, `allow[]` (window-title substrings) and an optional
`duration_sec`. While on, a single persistent helper minimizes every visible,
titled, non-allowed window about once a second. It is switched on automatically
for the duration of a pause or a held message, with an empty allow-list so nothing
gets through, and released when the lock lifts.

`close_tab` closes the active browser tab by sending Ctrl+W to the focused window
via `keybd_event`. `minimize_all` toggles show-desktop through the shell's own COM
automation (`Shell.Application` `MinimizeAll` and `UndoMinimizeALL`), minimizing
every window and restoring them on a second press. That route is deliberately not
injected keystrokes, because injected input is what game anti-cheat reads as macro
activity. Both work with the agent elevated: Windows UIPI only blocks low-to-high
input, so a High-integrity agent may inject into the normal (Medium) browser, and
a hidden helper never steals the browser's focus.

`start_screenshot` and `stop_screenshot` begin and end an on-demand JPEG screen
stream at roughly 1 fps and about 640px wide. The hub starts it only while an
instructor has that computer's panel open and stops it when the last viewer
leaves, so nothing is captured in the background. Set `IDT_ALLOW_SCREENSHOT=0` on
the agent to disable it entirely.

`update_agent` is admin-only and carries the hub's current `agent.js` and
`watch.js` source. The agent syntax-checks each file, backs up the old copy and
writes the new one, leaving `watch-config.json` (device name, server) untouched,
then re-launches on the new code. A bad push is refused and the running version
kept. The **Computers** admin table shows each laptop's version and an **Update**
button alongside "Update all"; the hub compares each agent's `build` against its
own to flag outdated laptops. Only the app restarts, and it does that itself: the
laptop is not rebooted and the student doesn't have to do anything. The agent
writes the new files, then re-launches through the installed launcher, which
clean-restarts both workers on the fresh code in a few seconds. A full reboot is
never required for an update.

`send_keys` presses a `keys` combo such as `"win+d"`, `"ctrl+w"` or `"alt+F4"` on
the front window via `keybd_event`. `run_command` runs a shell `command`; it is
admin-only (enforced by the hub) and each agent ignores it unless started with
`IDT_ALLOW_EXEC=1`. The command is logged and its output returned. `stop_watch`
decommissions a laptop: the agent drops the same `stop.flag` that "Stop iD Tech
Watch.cmd" writes, so the watchdog stops both the agent and its guardian, then
exits. The admin **Remove** button uses it.

**Dashboard ↔ Hub:** REST `POST /api/login` → session token; WS `/ws/dashboard`
first sends `{type:"auth",token}`, then receives
`{type:"state", org, devices, layouts, schedules}`. Any authenticated role may
send `command`, `layout` (seat position), `classrule` (per-class always-block
apps), and `rename` (device → student name). `run_command`, `removeDevice` (stop &
forget a laptop), and `org` mutations (locations, buildings, building codes,
classes, class reorder, assignments, schedules, admin password) require the
**admin** role. Command / schedule targets:
`{scope}` ∈ `device | class | building | location | all`; a schedule carries a
`targets[]` array so one event can hit several buildings/campuses at once.

---

## Packaged client: `iD-Tech-Watch.zip`

The client ships as a zip that runs on the official, Microsoft-signed `node.exe`,
rather than a `pkg`-packed `.exe`. That distinction matters: packed single-file
exes trip Windows Defender's ML heuristic with a false
`Trojan:Win32/Wacatac.B!ml`-style flag, while a signed `node.exe` plus plain `.js`
scripts does not. The laptop still needs nothing installed, since Node is inside
the zip.

```bash
powershell -File scripts/build-client.ps1     # produces dist/iD-Tech-Watch.zip
```

Downloadable from the site: the **⬇ iD-Tech-Watch.zip** button (bottom-right,
after login) hits `/download/id-tech-watch.zip`. The zip contains `node.exe`,
`watch.js`, `agent.js`, a `watch-config.json` template, and
**Start / Stop iD Tech Watch.cmd**.

> ⚠️ **`dist/` is git-ignored, so `git pull` does not update the zip.** After
> pulling new code on the hub machine, re-run `build-client.ps1`. Otherwise the
> Download button keeps serving the old agent, and every laptop you install it on
> shows as outdated in the Computers table straight away. The admin panel warns
> when the packaged build no longer matches the hub's, and shows both versions.
> Once laptops run a build from 2026-07-28 or later you can skip the zip entirely
> and use **Update** or **Update all** to push new code remotely.

To deploy, unzip onto the laptop (or a USB) and double-click **Start iD Tech
Watch.cmd**. It sets up a self-healing pair of processes, openly:
- ensures `C:\Users\Student\projects\iD-Tech\` exists, creating it if missing;
- installs the scripts and the signed `node.exe` there, so the install is
  self-contained once the USB is removed: a **client** and a **re-opener
  (guardian)**;
- each watches the other and relaunches it if it's closed. The client runs the
  monitoring agent, with keep-awake;
- on first run a small window asks for the hub server, location and building, or
  you can pre-fill `watch-config.json` before handing out the folder;
- to stop both, run **Stop iD Tech Watch.cmd**. It drops a `stop.flag` that both
  processes watch for, avoiding a keyboard hook, which antivirus dislikes.

It is not hidden from Task Manager, which is deliberate for a supervised lab.

### Restarting the laptop is not an escape

Shutting down used to clear everything: the agent came back with an empty head,
so an active pause and any blocks were simply gone. Two things close that.

**The agent comes back.** Auto-start is registered three ways, so removing one
isn't enough: the **Startup folder** `.vbs`, an **HKCU\…\Run** entry, and a
**logon Scheduled Task**. Every successful run also clears the *StartupApproved*
flag, so an entry switched off in **Task Manager → Startup apps** is re-enabled
for the next boot. The scheduled task needs an elevated install to register
(installs are normally elevated anyway, since website blocking requires it); when
it can't, the launcher logs that and the other two still work.

**The hub restores what was in force.** The hub, not the laptop, is the authority
on current state. On every registration it resets the laptop to a known state and
replays, in order:

1. `unblock_all`, so a block lifted while the laptop was offline doesn't come back
2. house (building) rules, then class rules, with building winning as always
3. blocks aimed at that computer, class or building, carrying only the time still
   left on a timed block
4. the pause, or an explicit resume when there isn't one, so a laptop can never
   come back showing a lock the hub has already released

So a student who reboots mid-pause logs back in and is paused again, with their
blocks intact. This state is **also written to `config.json`**, so it survives the
**hub** restarting too, not just the laptop. A pause older than 12 hours is
dropped rather than resurrected the next morning.

> A determined student with local administrator rights can still remove any of
> this. Real lockdown is an MDM or kiosk policy. What's here raises the bar for a
> standard camp account; it is not a security boundary.

### Remote command execution (opt-in)

The **Run command…** admin tool lets you run a shell command on a class laptop for
one-off maintenance. Because that is arbitrary code execution it is **off by
default** and triple-gated: the hub only accepts it from the **admin** role, and
each agent ignores it unless it was started with `IDT_ALLOW_EXEC=1`. When enabled,
every command is logged on the laptop and its output is returned to the admin. Only
turn it on for camp-managed laptops on a trusted network, and never expose the hub
over plain `ws://` outside a LAN. Leave it off if you don't need it.

### Antivirus & SmartScreen

- The zip runs on signed `node.exe`, so it avoids the packed-binary "virus
  detected" flag a `pkg` `.exe` gets. If you ever rebuild a `pkg` exe and Defender
  flags it, that's a false positive from the packer rather than the code.
- On camp-managed laptops (the beta), add an AV or Intune allow-list entry for the
  install folder, `C:\Users\Student\projects\iD-Tech\`, or for the file hash. This
  is the standard way to ship an internal tool and needs no certificate.
- For open public download, buy an EV code-signing certificate and sign the build.
  That is the only thing that fully clears the SmartScreen "unknown publisher"
  prompt for everyone.
- Either way you can submit the file to Microsoft as a false positive at
  microsoft.com/wdsi/filesubmission; they usually clear it within a day.
- Runtime note: website blocking edits the hosts file, which Defender's Controlled
  Folder Access can block. If site blocks don't take effect, allow the client
  through it, or leave CFA off on lab machines.

---

## Deployment

### Option 1: run it in one classroom or building on an admin laptop (LAN)

The admin laptop runs the hub; every student laptop's agent connects to it over
the same Wi-Fi/wired network. Nothing leaves the local network.

1. **On the admin laptop**, install Node.js 18+ (22+ recommended) and copy this
   folder onto it.
2. **Find the laptop's LAN IP.** `ipconfig` (Windows) → the IPv4 like
   `10.0.0.42`. The hub also prints it on startup.
3. **Start the hub** with a real admin password and keep-awake so the laptop
   doesn't sleep:
   ```powershell
   $env:IDT_ADMIN_PASSWORD = "your-strong-password"
   $env:IDT_KEEP_AWAKE = "1"
   node server/server.js
   ```
   Leave this window open (or use `scripts/run_server.ps1`). When Windows Firewall
   prompts, **Allow** Node on **Private** networks.
4. **Open the console** on the admin laptop at `http://localhost:8765/` and sign
   in as **Admin**. Set each building's 4-digit code, add classes, etc.
5. **On each student laptop** (same network): unzip **`iD-Tech-Watch.zip`** and
   double-click **Start iD Tech Watch.cmd**. Nothing to install, since Node is in the
   zip). Enter the hub server (`ws://10.0.0.42:8765`), location, and building in the
   first-run window. Advanced: `scripts\run_agent.ps1 -Server ws://10.0.0.42:8765
   -Location "Stanford" -Building "Tresidder"` if the laptop already has Node.
6. Instructors browse to `http://10.0.0.42:8765/` from any device on the network,
   pick their building (enter its code), and go.

Notes: all machines must be on the **same LAN/subnet** (guest Wi-Fi that isolates
clients won't work). This is plain `ws://` and is only safe on a trusted network.
For a whole building with several rooms, one hub laptop is plenty.

### Option 2: host it as a public website (one hub for everyone)

Run the hub once on a small cloud server with a domain and TLS; agents and
instructors connect over the internet, with no per-machine hub and no LAN requirement.

1. **Get a server + domain.** Any small Linux VM (e.g. 1 vCPU / 1 GB: DigitalOcean,
   Lightsail, Fly.io, Azure) and a domain like `watch.idtech.com` pointed (A
   record) at the VM's IP.
2. **Install Node 18+** on the VM and copy this project there.
3. **Run the hub as a service** so it restarts on reboot/crash. With systemd
   (`/etc/systemd/system/idtech.service`):
   ```ini
   [Service]
   Environment=IDT_ADMIN_PASSWORD=your-strong-password
   Environment=PORT=8765
   WorkingDirectory=/opt/id-tech-watch
   ExecStart=/usr/bin/node server/server.js
   Restart=always
   [Install]
   WantedBy=multi-user.target
   ```
   `sudo systemctl enable --now idtech`.
4. **Put it behind TLS.** This is required over the internet and enables `https://` and
   `wss://`). Easiest is **Caddy**, which auto-provisions a certificate:
   ```
   watch.idtech.com {
       reverse_proxy 127.0.0.1:8765
   }
   ```
   Then `caddy run`. nginx with certbot works too: proxy `/` and upgrade
   `/ws/agent` + `/ws/dashboard` to WebSocket.)
5. **Require an enrollment token** so only your agents can join. Add
   `Environment=IDT_ENROLL_TOKEN=some-secret` to the service and pass
   `--token some-secret` (or put it in `watch-config.json`) on each agent.
6. **Point clients at the domain:** agents use `--server wss://watch.idtech.com`
   (note `wss`), and everyone opens `https://watch.idtech.com/`. Build the zip once
   with that server baked into its `watch-config.json` and hand it out; the site's
   **⬇ iD-Tech-Watch.zip** button serves it.

Before a real public rollout, also do the "next" items below: a proper database,
per-instructor accounts, per-device certificates. The current build stores state
in a JSON file and uses one shared admin password plus per-building codes, which
is fine for a controlled beta and light for open public use.

## Scaling worldwide (structure in place, most of it dormant for beta)

- **Location tier: done.** Model and UI support many campuses; the beta uses one.
- **Persistence: done, beta grade.** JSON at `data/config.json`. `// TODO(scale)`
  marks where Postgres or Redis would go for many hubs.
- **Auth: done, beta grade.** Admin password (scrypt), per-building 4-digit codes
  and session tokens. Next: per-instructor SSO accounts and per-device certs.
- **Transport security: next.** Put the hub behind Caddy or nginx for TLS and
  `wss://`. Never run plain `ws://` outside a trusted LAN.
- **Regional hubs: next.** One hub per region, or a cloud relay keyed by location.
- **Agent packaging: next.** Sign the agent and ship it via MDM (Intune, Jamf).
  The Scheduled-Task script here is the beta stand-in.
- **Roster sync: next.** Pull locations, buildings and classes from iD Tech
  scheduling.

---

## Project layout

```
iD-Tech-Monitoring-App/
├── README.md
├── package.json
├── server/
│   └── server.js       # hub: WebSocket router, auth, org model, persistence (0 deps)
├── agent/
│   ├── agent.js        # student-laptop agent: monitor, block apps/sites, pause, keep-awake (0 deps)
│   └── watch.js        # "iD Tech Watch" launcher/watchdog: two mutually-watching processes
├── dashboard/
│   ├── index.html
│   ├── app.js          # SPA: login / instructor drill-down + seating canvas / admin panel
│   ├── style.css       # iD Green theme (brand colors are CSS variables)
│   └── fuzzysort.js    # vendored search library (served locally, no CDN)
├── scripts/
│   ├── run_server.ps1             # start the hub
│   ├── run_agent.ps1             # run an agent (self-elevates + keep-awake)
│   ├── install-agent-startup.ps1 # auto-start the agent at logon (Scheduled Task)
│   └── build-client.ps1          # build dist/iD-Tech-Watch.zip (signed node.exe + scripts)
└── data/               # created at runtime: config.json (git-ignored)
```

---

## Verified

Automated end-to-end tests pass, covering admin login (including rejection of a
wrong password), open instructor login, authenticated WebSockets and rejection of
bad tokens, the seeded Stanford location, agents auto-populating buildings and
classes, class-hint auto-assignment, live window and process reporting, admin
class edits persisting, instructors being blocked from admin operations, command
routing by scope, timed app blocking, multi-app preset blocking, website blocking
that writes and cleans the hosts file (tested against a temp file, never the real
one) and reports `sitesAvailable`, URL normalization, `unblock_all` clearing both
apps and sites, and config persistence.

The login, admin panel, instructor drill-down, iD Green theme, Block menu and
seating canvas (drag-to-move persisting per class, tap-to-open control panel,
mobile bottom sheet and touch-drag) were driven and confirmed in a browser, on
desktop and mobile viewports, with no console errors.
