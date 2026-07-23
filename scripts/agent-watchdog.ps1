param(
    [Parameter(Mandatory = $true)]
    [string]$RuntimeDir
)

$ErrorActionPreference = "Stop"
$runtimePath = [IO.Path]::GetFullPath($RuntimeDir)
$configPath = Join-Path $runtimePath "config.json"
$agentPath = Join-Path $runtimePath "agent.js"
$shutdownPath = Join-Path $runtimePath "shutdown.flag"
$watchdogPidPath = Join-Path $runtimePath "watchdog.pid"
$agentPidPath = Join-Path $runtimePath "agent.pid"
$logPath = Join-Path $runtimePath "watchdog.log"

function Write-WatchLog([string]$Message) {
    Add-Content -LiteralPath $logPath -Value "$([DateTime]::UtcNow.ToString('o')) $Message"
}

function Test-OwnedProcess([string]$PidPath, [string]$ExpectedName) {
    if (-not (Test-Path -LiteralPath $PidPath)) { return $false }
    $savedPid = 0
    if (-not [int]::TryParse((Get-Content -LiteralPath $PidPath -Raw).Trim(), [ref]$savedPid)) {
        return $false
    }
    $process = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
    return $null -ne $process -and $process.ProcessName -like "*$ExpectedName*"
}

if (Test-OwnedProcess $watchdogPidPath "powershell") {
    exit 0
}

Set-Content -LiteralPath $watchdogPidPath -Value $PID -NoNewline
try {
    if (-not (Test-Path -LiteralPath $configPath) -or -not (Test-Path -LiteralPath $agentPath)) {
        throw "The iD-Tech-Watch runtime is incomplete."
    }
    $node = Get-Command node.exe -ErrorAction Stop
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $env:IDT_SERVER = [string]$config.server
    $env:IDT_LOCATION = [string]$config.location
    $env:IDT_BUILDING = [string]$config.building
    $env:IDT_CLASS = [string]$config.klass
    $env:IDT_ENROLL_TOKEN = [string]$config.token

    while (-not (Test-Path -LiteralPath $shutdownPath)) {
        $arguments = @("`"$agentPath`"")
        if ($config.keepAwake) { $arguments += "--keep-awake" }
        $agent = Start-Process -FilePath $node.Source -ArgumentList $arguments -PassThru -WindowStyle Hidden
        Set-Content -LiteralPath $agentPidPath -Value $agent.Id -NoNewline
        Write-WatchLog "Started agent process $($agent.Id)."
        $agent.WaitForExit()
        Remove-Item -LiteralPath $agentPidPath -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path -LiteralPath $shutdownPath)) {
            Write-WatchLog "Agent exited with code $($agent.ExitCode); restarting."
            Start-Sleep -Seconds 2
        }
    }
    Write-WatchLog "Authorized shutdown flag detected; watchdog exiting."
}
catch {
    Write-WatchLog "Watchdog stopped: $($_.Exception.Message)"
    exit 1
}
finally {
    Remove-Item -LiteralPath $agentPidPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $watchdogPidPath -Force -ErrorAction SilentlyContinue
}
