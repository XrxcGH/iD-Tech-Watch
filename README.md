# iD Tech Classroom Monitor

A small classroom dashboard for monitoring and managing student Windows
computers. The hub runs on one computer; each student computer runs the
`iD-Tech-Watch` client.

## Set up the hub

You need:

- Windows 10 or 11
- [Node.js 22 or newer](https://nodejs.org/)
- This project downloaded or cloned to the hub computer

Open PowerShell in the project folder and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_server.ps1
```

The script checks Node, builds the Windows client if needed, and starts the
hub. No `npm install` is required.

Open `http://localhost:8765/` on the hub computer. Other computers must use the
LAN address printed in the PowerShell window, such as
`http://192.168.1.20:8765/`.

Default sign-ins for a fresh setup:

- Admin password: `miffy`
- Instructor password: `flaco`

Sign in as Admin to add locations, buildings, classes, and building access
codes. Change the default passwords in Admin settings when the hub is used
outside a local test.

The first start saves settings to `data\config.json`. Defaults do not replace
credentials already stored there.

### Optional hub settings

Set these in the same PowerShell window before starting the hub:

```powershell
$env:IDT_ENROLL_TOKEN = "shared-client-token"
$env:IDT_KEEP_AWAKE = "1"
```

If an enrollment token is set, enter the same token on every client. Set it
again each time the hub is restarted.

Useful startup options:

```powershell
# Use another port
powershell -File .\scripts\run_server.ps1 -Port 9000

# Rebuild the downloadable client
powershell -File .\scripts\run_server.ps1 -RebuildClient
```

If Windows Firewall asks, allow Node.js on the private camp network.

## Set up a student computer

Each student computer needs Windows and Node.js 22 or newer.

1. Open the hub's LAN address in a browser.
2. Sign in as an instructor or admin.
3. Click **Download iD-Tech-Watch** in the bottom-right corner.
4. Run `iD-Tech-Watch.exe` and approve the administrator prompt.
5. Enter the hub WebSocket address, for example
   `ws://192.168.1.20:8765`.
6. Enter the location, building, optional class, and enrollment token.
7. Check the dashboard to confirm that the computer is online.

The client stores its runtime files in:

```text
Documents\iD-Tech-Watch\
```

Run the downloaded executable again after a reboot. This beta does not install
itself as a Windows service or startup task.

To change the client setup:

```powershell
.\iD-Tech-Watch.exe --configure
```

To stop the client and watchdog:

```powershell
.\iD-Tech-Watch.exe --shutdown
```

## Build the client manually

The hub startup script normally handles this. To build it yourself:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-agent-exe.ps1
```

The output is:

```text
dist\iD-Tech-Watch.exe
```

The download button only works after this file exists.

## Development

Run the hub directly:

```powershell
node server/server.js
```

Run an unpackaged client:

```powershell
powershell -File .\scripts\run_agent.ps1 `
  -Server ws://127.0.0.1:8765 `
  -Location Stanford `
  -Building "Main Building" `
  -Class "Room 101"
```

Run the tests:

```powershell
npm test
```

Main files:

```text
server/server.js             Hub, authentication, storage, and WebSockets
dashboard/                   Browser interface
agent/agent.js               Student-computer agent
launcher/                    Windows launcher
scripts/build-agent-exe.ps1  Client build
scripts/run_server.ps1       Hub startup
test/                        Integration tests
```

## Responsible use

Use this on computers you are authorized to manage, and let students and staff
know when classroom monitoring is active. Keep the hub on a trusted network,
change the default credentials, and use an enrollment token.

The current beta uses plain HTTP/WebSockets, an unsigned client, and local JSON
storage. A broader deployment should add TLS, signed binaries, managed startup,
and stronger identity controls.
