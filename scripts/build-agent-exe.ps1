param(
    [string]$OutputPath
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $repoRoot "dist\iD-Tech-Watch.exe"
}
$outputFullPath = [IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $outputFullPath
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

$compiler = Get-ChildItem -LiteralPath "$env:WINDIR\Microsoft.NET\Framework64" `
    -Filter csc.exe -Recurse -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending |
    Select-Object -First 1
if (-not $compiler) {
    throw "The Windows .NET Framework C# compiler was not found."
}

$source = Join-Path $repoRoot "launcher\iD-Tech-Watch.cs"
$agent = Join-Path $repoRoot "agent\agent.js"
$watchdog = Join-Path $repoRoot "scripts\agent-watchdog.ps1"
$compilerArgs = @(
    "/nologo",
    "/target:winexe",
    "/optimize+",
    "/out:$outputFullPath",
    "/reference:System.dll",
    "/reference:System.Drawing.dll",
    "/reference:System.Web.Extensions.dll",
    "/reference:System.Windows.Forms.dll",
    "/resource:$agent,IDTechWatch.Agent",
    "/resource:$watchdog,IDTechWatch.Watchdog",
    $source
)

& $compiler.FullName @compilerArgs
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $outputFullPath)) {
    throw "iD-Tech-Watch compilation failed."
}
Write-Host "Built $outputFullPath"
