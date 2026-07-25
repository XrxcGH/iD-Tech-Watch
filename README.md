# iD Tech Watch

A classroom-management system for iD Tech Camps. Instructors watch the open
windows on every laptop in their class, close unauthorized apps, temporarily
block games and gaming websites (Roblox, Minecraft, Steam, poki.com, …), pause
screens, rename computers to the week's students, and schedule daily events.
Admins manage the whole org — **Location → Building → Class → Computer** — from a
web panel, with everything editable week to week.

Beta target: **Stanford campus** (single hub on the classroom LAN), seeded with
the **Tresidder, Grove, Phi Psi, French, and Warehaus** buildings. The Location
tier is the worldwide-scaling axis: add "MIT", "London", etc. when you expand.

**Hub + dashboard runtime: Node.js 18+ (Node 22+ recommended). The dashboard
vendors one small library (`fuzzysort`); the hub itself has no other deps. The
packaged client (`iD-Tech-Watch.zip`) bundles the signed `node.exe` — target
laptops need nothing installed.**

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
| Roblox            | `*roblox*`                   | roblox.com                                     |
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

**Close tabs / close a site now** — a hosts block only stops *new* page loads, so
there's a **Close tabs** button (and a "Close all browsers" item in the Block menu)
that closes every browser window immediately, clearing an already-open site.

**Always block for this class** — under the class toolbar, add apps that should
stay blocked for that class permanently (persists across restarts, re-applied when
a laptop reconnects). The add box **autocompletes from the apps currently open**
across the class (type or pick; Tab fills the top match and adds it; unknown names
are allowed too).

**Pause / full-screen warning** — **⏸ Pause** covers every screen with a
full-screen "eyes up front" overlay that **reopens if a student closes it**, until
you press **▶ Resume**. **⚠ Full-screen…** does the same with your own message (good
for transitions). **Message…** pops a dismissible note with an optional
**auto-close timeout**.

**Scheduled events** — in the Admin panel, schedule daily timed actions (e.g.
"Pause all computers at 12:00", "Block all games at 1:00, unblock at 1:30") by
location / building / class / everyone, on chosen days.

**Find things fast** — every picker (location → building → class) has a
right-aligned **fuzzy search** (powered by `fuzzysort`): matches float to the front,
non-matches dim but stay clickable, arrow keys / mouse navigate, and **Tab** jumps
straight into the top match.

**Try it with fake computers** — visit **`/demo`** (or the **Demo** button, top
right) for a simulated classroom with fake laptops to learn the flow. Nothing real
is touched.

**Bookmark your class** — once you're in a class the URL becomes
`/{Location}/{Instructor}` (e.g. `/Stanford/Ada%20Lovelace`), so you can bookmark it
and jump straight back in.

**Per-building instructor code** — buildings are gated by a 4-digit code (default
**8676**) that auto-submits when entered; admins set each building's code in the
panel.

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
- **Bookmarkable URLs**: the address bar tracks where you are — `/`, `/admin`
  (login-gated), `/Stanford`, `/Stanford/Tresidder`, `/Stanford/Tresidder/{Class}`.
- **Fuzzy search** (right of each picker) jumps to a location/building/class; Tab
  picks the top match.
- **Scheduled events** (Admin) run daily at a set time and can target **any mix of
  classes, whole buildings, and whole campuses** at once (e.g. one "Lunch pause"
  for Grove + Phi Psi + French + Warehaus, a different one for Tresidder).

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
block_site | unblock_site | unblock_all | close_browsers | pause | resume | message |
list_now`. `block_app` accepts `pattern` or `patterns[]`; `block_site` accepts
`domain` or `domains[]`; both accept `duration_sec` (omit/0 = until lifted).
`message` accepts `timeout_sec`; `pause` accepts `text`.

**Dashboard ↔ Hub:** REST `POST /api/login` → session token; WS `/ws/dashboard`
first sends `{type:"auth",token}`, then receives
`{type:"state", org, devices, layouts, schedules}`. Any authenticated role may
send `command`, `layout` (seat position), `classrule` (per-class always-block
apps), and `rename` (device → student name). `org` mutations (locations,
buildings, building codes, classes, class reorder, assignments, schedules,
admin password) require the **admin** role. Command / schedule targets: `{scope}`
∈ `device | class | building | location | all`; a schedule carries a `targets[]`
array so one event can hit several buildings/campuses at once.

---

## Packaged client — `iD-Tech-Watch.zip`

The client ships as a **zip that runs on the official, Microsoft-signed
`node.exe`** — *not* a `pkg`-packed `.exe`. This matters: packed single-file exes
trip Windows Defender's ML heuristic (a false `Trojan:Win32/Wacatac.B!ml`-style
flag), while a signed `node.exe` plus plain `.js` scripts does not. The laptop
still needs nothing installed — Node is inside the zip.

```bash
powershell -File scripts/build-client.ps1     # produces dist/iD-Tech-Watch.zip
```

Downloadable from the site: the **⬇ iD-Tech-Watch.zip** button (bottom-right,
after login) hits `/download/id-tech-watch.zip`. The zip contains `node.exe`,
`watch.js`, `agent.js`, a `watch-config.json` template, and
**Start / Stop iD Tech Watch.cmd**.

To deploy: unzip onto the laptop (or a USB) and double-click **Start iD Tech
Watch.cmd**. It (transparently) sets up a self-healing pair of processes:
- ensures `C:\Users\Student\projects\iD-Tech\` exists (creates it if missing);
- installs the scripts **and the signed `node.exe`** there (self-contained after
  the USB is removed) — the **client** and a **re-opener (guardian)**;
- each watches the other and **relaunches it if it's closed**; the client runs the
  monitoring agent (with keep-awake);
- **first run** pops a small window to enter the hub server / location / building
  (or pre-fill `watch-config.json` before handing out the folder);
- **to stop both:** run **Stop iD Tech Watch.cmd** (it drops a `stop.flag` that
  both processes watch for — no keyboard hook, which antivirus dislikes).

It is not hidden from Task Manager — deliberately transparent for a supervised lab.

### Antivirus & SmartScreen

- The zip runs on **signed `node.exe`**, so it avoids the packed-binary "virus
  detected" flag a `pkg` `.exe` gets. If you ever rebuild a `pkg` exe and Defender
  flags it, that's a **false positive** from the packer — not the code.
- On **camp-managed laptops** (the beta), add an **AV/Intune allow-list** entry for
  the install folder (`C:\Users\Student\projects\iD-Tech\`) or the file hash. This
  is the standard way to ship an internal tool and needs no certificate.
- For **open public download**, buy an **EV code-signing certificate** and sign the
  build — the only thing that fully clears the SmartScreen "unknown publisher"
  prompt for everyone.
- Either way you can **submit the file to Microsoft** (microsoft.com/wdsi/filesubmission)
  as a false positive; they usually clear it within a day.
- Runtime note: website blocking edits the hosts file, which Defender's *Controlled
  Folder Access* can block — allow the client through it (or leave CFA off on lab
  machines) if site blocks don't take effect.

---

## Deployment

### Option 1 — Run it in one classroom/building on an admin laptop (LAN)

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
   double-click **Start iD Tech Watch.cmd** (nothing to install — Node is in the
   zip). Enter the hub server (`ws://10.0.0.42:8765`), location, and building in the
   first-run window. Advanced: `scripts\run_agent.ps1 -Server ws://10.0.0.42:8765
   -Location "Stanford" -Building "Tresidder"` if the laptop already has Node.
6. Instructors browse to `http://10.0.0.42:8765/` from any device on the network,
   pick their building (enter its code), and go.

Notes: all machines must be on the **same LAN/subnet** (guest Wi-Fi that isolates
clients won't work). This is plain `ws://` and is only safe on a trusted network.
For a whole building with several rooms, one hub laptop is plenty.

### Option 2 — Host it as a public website (one hub for everyone)

Run the hub once on a small cloud server with a domain and TLS; agents and
instructors connect over the internet — no per-machine hub, no LAN requirement.

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
4. **Put it behind TLS** (required over the internet — enables `https://` +
   `wss://`). Easiest is **Caddy**, which auto-provisions a certificate:
   ```
   watch.idtech.com {
       reverse_proxy 127.0.0.1:8765
   }
   ```
   `caddy run`. (nginx with certbot works too — proxy `/` and upgrade
   `/ws/agent` + `/ws/dashboard` to WebSocket.)
5. **Require an enrollment token** so only your agents can join. Add
   `Environment=IDT_ENROLL_TOKEN=some-secret` to the service and pass
   `--token some-secret` (or put it in `watch-config.json`) on each agent.
6. **Point clients at the domain:** agents use `--server wss://watch.idtech.com`
   (note `wss`), and everyone opens `https://watch.idtech.com/`. Build the zip once
   with that server baked into its `watch-config.json` and hand it out; the site's
   **⬇ iD-Tech-Watch.zip** button serves it.

Before a real public rollout, also do the "next" items below (a proper database,
per-instructor accounts, per-device certificates). The current build stores state
in a JSON file and uses one shared admin password + per-building codes — fine for
a controlled beta, light for open public use.

## Scaling worldwide (structure in place; most dormant for beta)

- **Location tier — done.** Model + UI support many campuses; beta uses one.
- **Persistence — done (beta grade).** JSON at `data/config.json`. `// TODO(scale)`
  marks where Postgres/Redis would go for many hubs.
- **Auth — done (beta grade).** Admin password (scrypt) + per-building 4-digit
  codes + session tokens. Next: per-instructor SSO accounts and per-device certs.
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
