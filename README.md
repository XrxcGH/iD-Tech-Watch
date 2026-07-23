# iD Tech Classroom Monitor

A lightweight classroom-control hub for instructors and directors at iD Tech Camps. A Node.js
server hosts the browser dashboard and communicates with a small agent on each
student Windows computer over WebSockets.

The project intentionally has no runtime npm dependencies and no frontend
framework.

## Current capabilities

- Instructor and director sign-in
- Location, building, and class organization with fuzzy location lookup and
  keyboard autocomplete
- Live computer status, open-application inventory, seating layouts, and
  class assignments
- Informational, warning, and transition messages, including optional
  server-authoritative expiration
- Pause/resume, browser closure, focused-window closure with per-device
  results, and temporary or indefinite application/site blocks
- Persistent class application rules selected from detected applications or
  entered as exact custom executable identifiers
- Scheduled classroom actions
- Authenticated download of the packaged `iD-Tech-Watch.exe` client
- A Windows watchdog that restarts an accidentally closed agent and honors an
  explicit shutdown

## Requirements

Hub:

- Windows 10/11 for the documented setup path and downloadable-client build
- Node.js 22 or newer. The server and tests use Node's built-in WebSocket
  client; there are no npm packages to install.

Student client:

- Windows
- Node.js 22 or newer available as `node.exe`
- Windows PowerShell 5.1

Building the downloadable client additionally requires Windows PowerShell 5.1
and the .NET Framework C# compiler included with Windows 10/11.

## First-time hub setup (Windows)

These steps assume no familiarity with this repository.

1. Install [Node.js 22 or newer](https://nodejs.org/) on the hub computer.
   Keep the installer option that adds Node to `PATH`.
2. Download or clone this project, extract it if necessary, and open PowerShell
   in the folder containing this `README.md`.
3. Choose a director password. This prompts without displaying it and makes it
   available to the first hub start:

   ```powershell
   $directorSecret = Read-Host "New director password" -AsSecureString
   $env:IDT_ADMIN_PASSWORD = [Net.NetworkCredential]::new("", $directorSecret).Password
   ```

4. Strongly recommended: choose one enrollment token that will also be entered
   during setup on every student computer:

   ```powershell
   $enrollmentSecret = Read-Host "Agent enrollment token" -AsSecureString
   $env:IDT_ENROLL_TOKEN = [Net.NetworkCredential]::new("", $enrollmentSecret).Password
   ```

5. Start the hub:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\run_server.ps1
   ```

   This checks Node, builds `dist\iD-Tech-Watch.exe` if it is missing, and then
   starts the server. No `npm install` is needed. If Windows Firewall prompts,
   allow Node.js on the private camp network.

6. Leave that PowerShell window running. Open the displayed
   `http://localhost:8765/` address on the hub, choose **Admin**, and sign in
   with the director password. Other computers must use the displayed LAN
   address, such as `http://192.168.1.20:8765/`; `localhost` works only on the
   hub itself.
7. In Admin, create or verify locations, buildings, classes, each building's
   four-digit instructor code, and the optional global instructor sign-in code.
   A first run seeds an empty Stanford location.

The director password is hashed into `data/config.json` on first start.
Changing `IDT_ADMIN_PASSWORD` later does not replace a password already stored;
use the Admin settings screen. The enrollment token is not stored by the hub,
so set `IDT_ENROLL_TOKEN` again before every later server start if enrollment
protection is enabled.

To force a fresh client build while starting:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_server.ps1 -RebuildClient
```

To change the port:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_server.ps1 -Port 9000
```

Direct development startup (`node server/server.js`) remains supported, but it
does not build a missing client first.

Important environment settings:

| Setting | Default | Purpose |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Hub bind address |
| `PORT` | `8765` | Hub HTTP/WebSocket port |
| `IDT_ADMIN_PASSWORD` | `changeme` | Initial director password; always override outside local development |
| `IDT_ENROLL_TOKEN` | empty | Optional shared secret required when agents enroll |
| `IDT_KEEP_AWAKE` | disabled | Set to `1` to keep the hub awake |
| `IDT_CONFIG_PATH` | `data/config.json` | Server configuration location |
| `IDT_AGENT_EXE_PATH` | `dist/iD-Tech-Watch.exe` | Server-controlled packaged-client path |

The first run creates `data/config.json`. Director and instructor settings can
then be managed in the dashboard. The director role is represented internally
as `admin`.

## Student-computer setup

Repeat these steps on each student Windows computer:

1. Install Node.js 22 or newer and make sure `node.exe` is available in
   `PATH`.
2. In a browser, open the hub computer's LAN URL—not `localhost`.
3. Sign in as an instructor or director. Instructors enter the global sign-in
   code if one is configured.
4. Click the fixed bottom-right **Download iD-Tech-Watch** button. If it reports
   that the client is unavailable, the hub operator must rebuild the client.
5. Run the downloaded `iD-Tech-Watch.exe`. Approve the Windows administrator
   prompt; elevation is required for process and website controls.
6. On first launch, enter:

   - Hub WebSocket URL using the same LAN host and port, for example
     `ws://192.168.1.20:8765`
   - Location and building names as configured by the director
   - Optional class hint
   - The enrollment token from hub setup, if enabled

7. The launcher exits after starting a hidden watchdog. Confirm the computer
   appears online in the director or instructor dashboard.

Keep a copy of `iD-Tech-Watch.exe` on the computer: it is also the supported
shutdown and reconfiguration entrypoint. Run it normally to refresh/start the
client, or run `.\iD-Tech-Watch.exe --configure` from PowerShell to change
setup and restart the running watchdog. This beta does not install a Windows
service or logon task, so run it again after a reboot.

### Manual client build

The server startup script builds the client automatically when it is missing.
To build it directly:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-agent-exe.ps1
```

Output:

```text
dist\iD-Tech-Watch.exe
```

The build script and all of its inputs are tracked:

```text
scripts\build-agent-exe.ps1
launcher\iD-Tech-Watch.cs
launcher\app.manifest
scripts\agent-watchdog.ps1
agent\agent.js
```

The browser sends the current session token for the download; the server
rechecks the instructor/director role and serves only the fixed executable
path. An unauthenticated request, unsupported HTTP method, or path variant is
rejected.

The executable embeds the JavaScript agent and watchdog. It extracts them and
stores its configuration under the active Windows user's Documents folder:

```text
%USERPROFILE%\Documents\iD-Tech-Watch\
```

The exact Documents directory is resolved through Windows, so redirected or
localized Documents folders are supported.

The runtime directory contains `agent.js`, `agent-watchdog.ps1`, `config.json`,
PID files while running, `watchdog.log`, and an optional `shutdown.flag`.
Rerunning the launcher updates the embedded runtime files and starts monitoring
without opening a second watchdog.

### Authorized shutdown

Open an Administrator PowerShell in the folder containing the downloaded
executable and run:

```powershell
.\iD-Tech-Watch.exe --shutdown
```

This writes `shutdown.flag`, stops the current agent and watchdog using their
recorded process IDs, and prevents watchdog restart. Running the executable
normally again removes the flag and resumes monitoring.

For scripted deployment, setup can be supplied without the dialog:

```powershell
iD-Tech-Watch.exe --server ws://HUB:8765 --location Stanford --building Lab --class Room101 --keep-awake
```

## Direct development agent

For development without the packaged launcher:

```powershell
powershell -File scripts/run_agent.ps1 `
  -Server ws://127.0.0.1:8765 `
  -Location Stanford `
  -Building "Main Building" `
  -Class "Room 101"
```

The agent may request elevation because pause overlays, process control, and
site blocking can require administrator access.

## Security model

- Dashboard WebSockets authenticate with a 12-hour in-memory session token.
- The download endpoint independently validates a Bearer token and permits
  instructor/director roles only.
- Dashboard commands are checked against a server allowlist; internal sync
  actions cannot be submitted by a browser.
- Building codes are verified by the hub. Instructor sessions do not receive a
  building's code or device inventory until that building is unlocked.
- Command targets and action parameters are normalized and validated before
  forwarding.
- Durations are validated server-side and converted to absolute expiration
  timestamps.
- Application rules use normalized exact executable identifiers. Client labels
  and detected status are not trusted blindly.
- The download route never accepts a filesystem path from the request.
- Dashboard DOM construction uses text nodes for untrusted values.

For deployment beyond a trusted camp LAN, add TLS (`https`/`wss`), a durable
identity provider, per-location authorization, signed binaries, and managed
device deployment. The current enrollment token and client configuration are
stored locally and should be protected with normal Windows account controls.

## Validation

Run all repository integration tests:

```powershell
npm test
```

Useful focused checks:

```powershell
node --test test/fuzzy-search.test.js
node --test test/message-state.test.js
node --test test/class-controls.test.js
node --test test/download-route.test.js
```

Syntax checks:

```powershell
node --check server/server.js
node --check agent/agent.js
node --check dashboard/app.js
```

The generated `dist/` directory is intentionally ignored. Build the executable
before starting a hub that must offer downloads.

## Repository map

```text
server/server.js                 HTTP, authentication, persistence, WebSockets
dashboard/                       Browser UI and fuzzy-search helper
agent/agent.js                   Windows monitoring/control agent
launcher/iD-Tech-Watch.cs        Packaged client bootstrap and setup UI
scripts/agent-watchdog.ps1       Agent restart and shutdown lifecycle
scripts/build-agent-exe.ps1      Self-contained EXE build
scripts/run_server.ps1           Validated hub launcher; builds missing client
scripts/run_agent.ps1            Direct agent development launcher
scripts/install-agent-startup.ps1 Legacy scheduled-task development installer
test/                            Focused protocol and integration tests
```
