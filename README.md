# iD Tech Classroom Monitor

A classroom-management system for iD Tech Camps. Instructors watch the open
windows on every laptop in their class, close unauthorized apps, and temporarily
block games and gaming websites (Roblox, Minecraft, Steam, poki.com, …). Admins
manage the whole org — **Location → Building → Class → Computer** — from a web
panel, with everything editable week to week.

Beta target: **Stanford campus** (single hub on the classroom LAN). The Location
tier is the worldwide-scaling axis: add "MIT", "London", etc. when you expand.

**Runtime: Node.js 18+ (uses the built-in global WebSocket client, stable in
Node 22+). Zero external dependencies — nothing to `npm install`.**

---

## ⚠️ Responsible use (read first)

For **camp-managed laptops** in a **supervised, in-person classroom** with minors:

- **Transparent, not covert.** The agent runs visibly, prints what it's doing,
  and shows a "monitoring is active" notice. Tell students (and parents, per iD
  Tech policy) that class laptops are monitored.
- **Minimal data.** It reports *window titles and app names* only — no
  keystrokes, passwords, webcams, or continuous screenshots.
- Do not deploy on personal/BYO devices or outside a supervised class.

---

## What it can do

**View** — a live grid of every laptop in a class, showing open window titles and
running apps.

**Seating chart (canvas mode)** — switch the class view from **▦ Grid** to **🪑
Seating** to get a 2D map of the room. Drag each computer to where the student
actually sits so you remember who's who; positions are saved per class (and shared
with any co-instructor viewing the same class). Tap/click a computer on the map to
open its control panel (block games, close apps, message, refresh). Works with both
mouse and touch, so it's usable on a phone or tablet while you walk the room. Use
**Reset layout** to auto-arrange again.

**Block apps** — one click blocks a game everywhere it's selected; the agent kills
it now and keeps killing it for a chosen duration (5 min … until you lift it).
Built-in presets:

| Preset            | Blocks (apps)                | Blocks (websites)                              |
|-------------------|------------------------------|------------------------------------------------|
| Roblox            | `roblox*`                    | roblox.com                                     |
| Minecraft         | `*minecraft*`                | minecraft.net                                  |
| Fortnite          | `*fortnite*`                 | —                                              |
| Steam             | `*steam*`                    | steampowered.com, steamcommunity.com           |
| Epic Games        | `*epicgames*`, `*fortnite*`  | epicgames.com                                  |
| Gaming websites   | —                            | poki.com, coolmathgames.com, crazygames.com, miniclip.com, y8.com, addictinggames.com, kongregate.com, armorgames.com, friv.com, gamejolt.com |
| All games + sites | everything above             | everything above                               |

Plus **Custom app…** (any process-name substring, e.g. `discord`) and **Custom
website…** (any domain, e.g. `twitch.tv`). Also **Close app…** (kill once) and
**Message…** (pop a note on the student's screen).

**Block websites** works by editing the laptop's hosts file, so it needs the agent
to run **as Administrator** (see below). App blocking does not need elevation.

> Notes / limits: "minecraft" matches the launcher + Bedrock edition; Minecraft
> **Java** runs as `javaw.exe`, which is intentionally *not* matched so we don't
> kill legitimate Java used in coding classes (block `javaw` via Custom app if
> your camp doesn't use Java). Website blocks stop *new* page loads; an
> already-open tab isn't force-closed. If a browser has **Secure DNS / DNS-over-
> HTTPS** enabled it can bypass the hosts file — disable it (or push a browser
> policy) on lab machines.

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
  change every week — *without touching any laptop*. Admins assign computers to
  the week's class in the admin panel.
- **Locations & buildings** auto-populate as agents check in, and are editable.

## Roles

| Role       | Signs in with          | Can do                                                                 |
|------------|------------------------|------------------------------------------------------------------------|
| Instructor | (optional access code) | Drill down Location → Building → Class and control that class's computers |
| Admin      | admin password         | Everything an instructor can, plus manage the org, classes, instructors, computer assignments, and settings |

The initial admin password comes from `IDT_ADMIN_PASSWORD` (or defaults to
`changeme` with a warning). Change it in **Admin → Settings**. Only a salted
scrypt hash is stored, in `data/config.json`.

---

## 🧪 Beta test on ONE local machine (step by step)

This runs the **hub and a "student" agent on the same computer** — the fastest way
to try everything. (Windows PowerShell shown; macOS/Linux is the same commands.)

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
[hub] ready — open the console in a browser:
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

**6. Try controls** (on yourself — safe to test):
- Open a browser tab to `poki.com`, then in the class toolbar pick **Block… →
  Gaming websites**. Reload the tab — it should fail to load. (If it still loads,
  your browser's Secure DNS is bypassing the hosts file; turn it off.)
- Open something like Notepad, then **Block… → Custom app… →** `notepad`. It closes
  and stays closed for the chosen duration.
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

**Agent → Hub:** `register` (device_id, hostname, os, location, building, klass?,
token) · `status` (windows, processes, blocked, blockedSites, sitesAvailable).

**Hub → Agent:** `command` with `action` ∈ `kill_process | block_app | unblock_app |
block_site | unblock_site | unblock_all | message | list_now`. `block_app` accepts
`pattern` or `patterns[]`; `block_site` accepts `domain` or `domains[]`; both accept
`duration_sec` (omit/0 = until lifted).

**Dashboard ↔ Hub:** REST `POST /api/login` → session token; WS `/ws/dashboard`
first sends `{type:"auth",token}`, then receives `{type:"state", org, devices}` and
sends `command` (any role) / `org` mutations (admin only). Command targets:
`{scope}` ∈ `device | class | building | location | all`.

---

## Scaling worldwide (structure in place; most dormant for beta)

- **Location tier — done.** Model + UI support many campuses; beta uses one.
- **Persistence — done (beta grade).** JSON at `data/config.json`. `// TODO(scale)`
  marks where Postgres/Redis would go for many hubs.
- **Auth — done (beta grade).** Admin password (scrypt) + optional instructor code
  + session tokens. Next: per-instructor SSO accounts and per-device certs.
- **Transport security — next.** Put the hub behind Caddy/nginx for TLS + `wss://`.
  Never run plain `ws://` outside a trusted LAN.
- **Regional hubs — next.** One hub per region (or a cloud relay keyed by location).
- **Agent packaging — next.** Sign the agent and ship via MDM (Intune / Jamf); the
  Scheduled-Task script here is the beta stand-in.
- **Roster sync — next.** Pull locations/buildings/classes from iD Tech scheduling.

---

## Project layout

```
iD-Tech-Monitoring-App/
├── README.md
├── package.json
├── server/
│   └── server.js       # hub: WebSocket router, auth, org model, persistence (0 deps)
├── agent/
│   └── agent.js        # student-laptop agent: monitor, block apps + websites, keep-awake (0 deps)
├── dashboard/
│   ├── index.html
│   ├── app.js          # SPA: login / instructor drill-down + seating canvas / admin panel
│   └── style.css       # iD Green theme (brand colors are CSS variables)
├── scripts/
│   ├── run_server.ps1            # start the hub
│   ├── run_agent.ps1            # run an agent (self-elevates + keep-awake)
│   └── install-agent-startup.ps1 # auto-start the agent at logon (Scheduled Task)
└── data/               # created at runtime: config.json (git-ignored)
```

---

## Verified

Automated end-to-end tests pass, covering: admin login (rejects wrong password),
open instructor login, authenticated WebSocket + rejection of bad tokens, seeded
Stanford location, agents auto-populating buildings/classes, class-hint
auto-assignment, live window + process reporting, admin class edits persisting,
instructors blocked from admin ops, command routing by scope, timed app blocking,
**multi-app preset blocking**, **website blocking that writes/cleans the hosts file
(tested against a temp file — never the real one) and reports `sitesAvailable`**,
URL normalization, `unblock_all` clearing apps + sites, and config persistence. The
login, admin panel, instructor drill-down, iD Green theme, the Block menu, and the
**seating canvas** (drag-to-move persisting per class, tap-to-open control panel,
mobile bottom-sheet + touch-drag) were driven and confirmed in a browser (desktop
and mobile viewports) with no console errors.
