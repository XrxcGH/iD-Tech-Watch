# Start the iD Tech Classroom Monitor hub (Windows / PowerShell).
# Run from the project root:  .\scripts\run_server.ps1
#
# Requires Node.js 18+ (no npm install needed — zero dependencies).

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Optional: require agents to present a shared secret
# $env:IDT_ENROLL_TOKEN = "change-me"

# Optional: custom port (default 8765)
# $env:PORT = "8765"

Write-Host "Starting hub on http://0.0.0.0:8765/ ..."
node server/server.js
