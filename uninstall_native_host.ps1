param()

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$hostRoot = Join-Path $repoRoot "native_host"
$venvRoot = Join-Path $hostRoot ".venv"
$distRoot = Join-Path $hostRoot "dist"
$buildRoot = Join-Path $hostRoot "build"
$specRoot = Join-Path $hostRoot "spec"
$manifestPath = Join-Path $hostRoot "com.kiri.idm_watcher.json"
$registryPath = "HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.kiri.idm_watcher"

if (Test-Path $registryPath) {
  Remove-Item -LiteralPath $registryPath -Recurse -Force
}

foreach ($path in @($manifestPath, $distRoot, $buildRoot, $specRoot, $venvRoot)) {
  if (Test-Path $path) {
    Remove-Item -LiteralPath $path -Recurse -Force
  }
}

Write-Host ""
Write-Host "Native host uninstalled."
Write-Host "Removed registry key: $registryPath"
Write-Host "Removed artifacts from: $hostRoot"
