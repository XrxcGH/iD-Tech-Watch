# Build the iD Tech Watch client as a folder + zip that runs on the official,
# Microsoft-signed node.exe — so it does NOT trip the packed-binary antivirus
# false positive that a pkg .exe does. Output: dist/iD-Tech-Watch.zip
#
# Run from the project root:  powershell -File scripts/build-client.ps1
# (Node.js 18+ must be installed; its node.exe is what gets bundled.)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$stage = Join-Path $root "dist\iD-Tech-Watch"
$zip = Join-Path $root "dist\iD-Tech-Watch.zip"
New-Item -ItemType Directory -Force -Path (Join-Path $root "dist") | Out-Null
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

# 1) the signed Node runtime (this machine's node.exe) + the scripts
$node = (Get-Command node -ErrorAction Stop).Source
Copy-Item $node (Join-Path $stage "node.exe")
Copy-Item (Join-Path $root "agent\watch.js") (Join-Path $stage "watch.js")
Copy-Item (Join-Path $root "agent\agent.js") (Join-Path $stage "agent.js")

# 2) launcher (a plain .cmd — scripts aren't flagged like packed exes)
Set-Content -Encoding ascii -Path (Join-Path $stage "Start iD Tech Watch.cmd") -Value @'
@echo off
cd /d "%~dp0"
start "" /min "%~dp0node.exe" "%~dp0watch.js"
'@

# a convenience stop script (writes the stop.flag the install watches for)
Set-Content -Encoding ascii -Path (Join-Path $stage "Stop iD Tech Watch.cmd") -Value @'
@echo off
if not exist "C:\Users\Student\projects\iD-Tech\" mkdir "C:\Users\Student\projects\iD-Tech\"
echo stop> "C:\Users\Student\projects\iD-Tech\stop.flag"
echo iD Tech Watch is stopping...
timeout /t 2 >nul
'@

# 3) optional pre-fill config + readme
Set-Content -Encoding ascii -Path (Join-Path $stage "watch-config.json") -Value @'
{
  "server": "ws://REPLACE-WITH-HUB-IP:8765",
  "location": "Stanford",
  "building": "",
  "token": ""
}
'@
Set-Content -Encoding ascii -Path (Join-Path $stage "README.txt") -Value @'
iD Tech Watch - classroom client

1. Double-click "Start iD Tech Watch.cmd".
2. On first run a small window asks for the hub server, location and building.
   (Or fill in watch-config.json before handing out the folder.)
3. To stop it, run "Stop iD Tech Watch.cmd".

Runs on Microsoft-signed node.exe - nothing to install. Website blocking needs
the client to run as Administrator.
'@

# 4) zip it
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -Force
$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "Built: $zip ($mb MB)"
Write-Host "Downloadable at /download/id-tech-watch.zip"
