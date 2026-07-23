param(
  [ValidateRange(1, 65535)]
  [int]$Port = 8765,
  [string]$ListenAddress = "0.0.0.0",
  [switch]$RebuildClient,
  [switch]$SkipClientBuild
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$node = Get-Command node.exe -ErrorAction Stop
$nodeMajor = [int]((& $node.Source -p "process.versions.node.split('.')[0]").Trim())
if ($nodeMajor -lt 22) {
  throw "Node.js 22 or newer is required. Found Node.js $(& $node.Source --version)."
}

$clientPath = Join-Path $repoRoot "dist\iD-Tech-Watch.exe"
if (-not $SkipClientBuild -and ($RebuildClient -or -not (Test-Path -LiteralPath $clientPath))) {
  Write-Host "Building the downloadable Windows client..."
  & (Join-Path $PSScriptRoot "build-agent-exe.ps1") -OutputPath $clientPath
}
if (-not (Test-Path -LiteralPath $clientPath)) {
  Write-Warning "The hub will start, but client downloads will return 404 because $clientPath is missing."
}

$env:HOST = $ListenAddress
$env:PORT = [string]$Port
Set-Location $repoRoot
Write-Host "Starting the hub on port $Port..."
& $node.Source "server/server.js"
exit $LASTEXITCODE
