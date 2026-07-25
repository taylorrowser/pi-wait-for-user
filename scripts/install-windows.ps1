[CmdletBinding()]
param(
  [switch]$ManagePi,
  [string]$DataRoot,
  [string]$BinDir,
  [string]$LegacyDir
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Fail([string]$Message) {
  throw "pi-wait-for-user: $Message"
}

if (-not (Get-Command node -CommandType Application -ErrorAction SilentlyContinue)) {
  Fail "required command not found: node"
}
if (-not (Get-Command tar -CommandType Application -ErrorAction SilentlyContinue)) {
  Fail "required command not found: tar"
}
$nodeVersion = [Version](& node -p "process.versions.node")
if ($nodeVersion -lt [Version]"22.19.0") {
  Fail "managed installation requires Node.js 22.19 or newer"
}
if ($env:PROCESSOR_ARCHITECTURE -notin @("AMD64", "ARM64")) {
  Fail "managed installation supports Windows x64 and ARM64 only"
}

$commands = @("pi-wait-for-user")
if ($ManagePi) { $commands += "pi" }
foreach ($name in $commands) {
  $sessionCommand = Get-Command $name -CommandType Alias, Function, Cmdlet -ErrorAction SilentlyContinue
  if ($sessionCommand) {
    Fail "PowerShell command collision: $name resolves to $($sessionCommand.CommandType) '$($sessionCommand.Name)'. Remove or rename that current-session command explicitly; the installer will not replace it."
  }
}

$arguments = @()
if ($ManagePi) { $arguments += "--manage-pi" }
if ($DataRoot) { $arguments += @("--data-root", $DataRoot) }
if ($BinDir) { $arguments += @("--bin-dir", $BinDir) }
if ($LegacyDir) { $arguments += @("--legacy-dir", $LegacyDir) }

$bootstrap = Join-Path $PSScriptRoot "managed-install\windows-bootstrap.mjs"
if (-not (Test-Path -LiteralPath $bootstrap -PathType Leaf)) {
  Fail "signed Windows bootstrap payload is missing"
}
& node $bootstrap @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($ManagePi) {
  $resolved = Get-Command pi -CommandType Application -ErrorAction SilentlyContinue
  if (-not $resolved) {
    Fail "Managed Dispatcher was installed but PowerShell resolves no pi application. Put the managed bin directory first in PATH without removing foreign entries, open a new terminal, and rerun."
  }
}
