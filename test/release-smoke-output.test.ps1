$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$assertConformance = Join-Path $root "scripts/assert-conformance.ps1"
$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) "pi-conformance-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null

function New-ConformanceFixture {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [string[]]$Lines,
    [int]$ExitCode = 0
  )

  if ($IsWindows) {
    $path = Join-Path $fixtureRoot "$Name.cmd"
    @(
      "@echo off"
      $Lines | ForEach-Object { "echo $_" }
      "exit /b $ExitCode"
    ) | Set-Content -LiteralPath $path -Encoding ascii
    return $path
  }

  $path = Join-Path $fixtureRoot "$Name.sh"
  @(
    "#!/bin/sh"
    $Lines | ForEach-Object { "echo '$_'" }
    "exit $ExitCode"
  ) | Set-Content -LiteralPath $path -Encoding utf8NoBOM
  & chmod +x $path
  return $path
}

function Assert-Fails {
  param(
    [Parameter(Mandatory = $true)]
    [scriptblock]$Action,
    [Parameter(Mandatory = $true)]
    [string]$ErrorPattern
  )

  try {
    $null = @(& $Action)
  } catch {
    if ($_.Exception.Message -notmatch $ErrorPattern) {
      throw "Expected failure matching '$ErrorPattern', got '$($_.Exception.Message)'"
    }
    return
  }
  throw "Expected failure matching '$ErrorPattern'"
}

try {
  $valid = New-ConformanceFixture -Name "valid" -Lines @(
    "PASS stable deferral"
    "PASS reload"
    "PASS teardown/reopen"
    "Deferred conformance passed (8/8)"
  )
  $validOutput = @(& $assertConformance -Pi $valid)
  if ($validOutput[-1] -cne "Deferred conformance passed (8/8)") {
    throw "Valid multiline output did not pass through the release-smoke assertion"
  }

  $missing = New-ConformanceFixture -Name "missing" -Lines @(
    "PASS stable deferral"
    "PASS reload"
  )
  Assert-Fails -ErrorPattern "exact success summary" -Action { & $assertConformance -Pi $missing }

  $wrong = New-ConformanceFixture -Name "wrong" -Lines @(
    "PASS stable deferral"
    "Deferred conformance passed (7/8)"
  )
  Assert-Fails -ErrorPattern "exact success summary" -Action { & $assertConformance -Pi $wrong }

  $wrongCase = New-ConformanceFixture -Name "wrong-case" -Lines @(
    "PASS stable deferral"
    "deferred conformance passed (8/8)"
  )
  Assert-Fails -ErrorPattern "exact success summary" -Action { & $assertConformance -Pi $wrongCase }

  $failed = New-ConformanceFixture -Name "failed" -Lines @(
    "Deferred conformance passed (8/8)"
  ) -ExitCode 17
  Assert-Fails -ErrorPattern "exit code 17" -Action { & $assertConformance -Pi $failed }

  $boundedLines = @(1..110 | ForEach-Object { "PASS case $_" }) + "Deferred conformance passed (8/8)"
  $bounded = New-ConformanceFixture -Name "bounded" -Lines $boundedLines
  $boundedOutput = @(& $assertConformance -Pi $bounded)
  if ($boundedOutput.Count -ne 100 -or $boundedOutput[0] -cne "PASS case 12") {
    throw "Release-smoke diagnostics were not bounded to the final 100 lines"
  }

  Write-Output "Release-smoke conformance assertion regression passed"
} finally {
  Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}
