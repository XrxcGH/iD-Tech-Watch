# Install the AGENT as a Scheduled Task so it starts automatically at logon,
# runs elevated (so it can block websites), keeps the laptop awake, and restarts
# itself if it ever exits. RUN THIS IN AN ADMINISTRATOR PowerShell.
#
# Example:
#   .\scripts\install-agent-startup.ps1 -Server ws://10.0.0.42:8765 -Location "Stanford" -Building "Gates Computer Science"
#
# Remove it later with:
#   Unregister-ScheduledTask -TaskName "iDTechClassroomAgent" -Confirm:$false

param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$Location = "Stanford",
  [string]$Building = "Main Building",
  [string]$Class = "",
  [string]$TaskName = "iDTechClassroomAgent"
)

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "Please run this script in an Administrator PowerShell." }

$root = Split-Path -Parent $PSScriptRoot
$agent = Join-Path $root "agent\agent.js"
$node = (Get-Command node -ErrorAction Stop).Source

$argLine = "`"$agent`" --server $Server --location `"$Location`" --building `"$Building`" --keep-awake"
if ($Class) { $argLine += " --class `"$Class`"" }

$action = New-ScheduledTaskAction -Execute $node -Argument $argLine -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

Write-Host "Installed scheduled task '$TaskName'."
Write-Host "It will start the agent at each logon (elevated, keep-awake, auto-restart)."
Write-Host "Start it now with:  Start-ScheduledTask -TaskName '$TaskName'"
