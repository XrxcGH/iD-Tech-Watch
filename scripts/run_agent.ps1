# Run the iD Tech Classroom Monitor AGENT on a student laptop (Windows).
#
# Self-elevates to Administrator (needed to block websites via the hosts file)
# and runs with --keep-awake so the laptop won't sleep while class is running.
#
# Example:
#   .\scripts\run_agent.ps1 -Server ws://10.0.0.42:8765 -Location "Stanford" -Building "Gates Computer Science"
#
# Add -NoElevate to run without Administrator (app blocking still works; website
# blocking will be disabled).

param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$Location = "Stanford",
  [string]$Building = "Main Building",
  [string]$Class = "",
  [switch]$NoElevate
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$agent = Join-Path $root "agent\agent.js"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin -and -not $NoElevate) {
  Write-Host "Requesting Administrator (needed to block websites)..."
  $a = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"",
    "-Server", "`"$Server`"", "-Location", "`"$Location`"", "-Building", "`"$Building`"")
  if ($Class) { $a += @("-Class", "`"$Class`"") }
  Start-Process powershell -Verb RunAs -ArgumentList $a
  return
}

$nodeArgs = @("`"$agent`"", "--server", $Server, "--location", $Location, "--building", $Building, "--keep-awake")
if ($Class) { $nodeArgs += @("--class", $Class) }

Write-Host "Starting agent -> $Server  ($Location / $Building)"
& node @nodeArgs
