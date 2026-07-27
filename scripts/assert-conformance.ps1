param(
  [Parameter(Mandatory = $true)]
  [string]$Pi
)

$conformanceOutput = @(& $Pi conformance 2>&1 | Select-Object -Last 100)
$conformanceExitCode = $LASTEXITCODE
$conformanceOutput | Write-Output

if ($conformanceExitCode -ne 0) {
  throw "Windows conformance command failed with exit code $conformanceExitCode"
}
if (-not ($conformanceOutput -ccontains "Deferred conformance passed (8/8)")) {
  throw "Windows conformance output did not contain the exact success summary"
}
