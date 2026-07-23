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

- Node.js 22 or newer. The server and tests use Node's built-in WebSocket
  client; there are no npm packages to install.

Student client:

- Windows
- Node.js 22 or newer available as `node.exe`
- Windows PowerShell 5.1

Building the downloadable client additionally requires the .NET Framework C#
compiler included with supported Windows installations.

## Run the hub

From the repository root:

```powershell
node server/server.js
```

Or:

```powershell
powershell -File scripts/run_server.ps1
```

Open `http://localhost:8765/`. Other computers on the LAN use the hub
machine's displayed LAN address.

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

## Build and distribute the Windows client

Build the exact file served by the dashboard:

```powershell
powershell -File scripts/build-agent-exe.ps1
```

Output:

```text
dist\iD-Tech-Watch.exe
```

After signing in as an instructor or director, use the fixed bottom-right
`Download iD-Tech-Watch` button. The browser sends the current session token;
the server rechecks the role and serves only the fixed executable path. An
unauthenticated request, an unsupported HTTP method, or a path variant is
rejected.

On first launch, the client asks for:

- Hub WebSocket URL, such as `ws://192.168.1.20:8765`
- Location
- Building
- Optional class hint
- Optional enrollment token

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

Run the same executable with:

```powershell
iD-Tech-Watch.exe --shutdown
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
scripts/run_server.ps1           Hub development launcher
scripts/run_agent.ps1            Direct agent development launcher
scripts/install-agent-startup.ps1 Legacy scheduled-task development installer
test/                            Focused protocol and integration tests
```
