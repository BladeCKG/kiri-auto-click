param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionId
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$hostRoot = Join-Path $repoRoot "native_host"
$venvRoot = Join-Path $hostRoot ".venv"
$pythonExe = Join-Path $venvRoot "Scripts\\python.exe"
$pyInstallerExe = Join-Path $venvRoot "Scripts\\pyinstaller.exe"
$distRoot = Join-Path $hostRoot "dist"
$buildRoot = Join-Path $hostRoot "build"
$specRoot = Join-Path $hostRoot "spec"
$sourcePath = Join-Path $hostRoot "idm_watcher_host.py"
$exePath = Join-Path $distRoot "kiri_idm_host.exe"
$manifestPath = Join-Path $hostRoot "com.kiri.idm_watcher.json"
$registryPath = "HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.kiri.idm_watcher"

if (-not (Test-Path $venvRoot)) {
  py -3 -m venv $venvRoot
}

& $pythonExe -m pip install --upgrade pip pyinstaller | Out-Host

if (Test-Path $distRoot) {
  Remove-Item -LiteralPath $distRoot -Recurse -Force
}

if (Test-Path $buildRoot) {
  Remove-Item -LiteralPath $buildRoot -Recurse -Force
}

if (Test-Path $specRoot) {
  Remove-Item -LiteralPath $specRoot -Recurse -Force
}

& $pyInstallerExe --onefile --name kiri_idm_host --distpath $distRoot --workpath $buildRoot --specpath $specRoot $sourcePath | Out-Host

$hostManifest = @{
  name = "com.kiri.idm_watcher"
  description = "Kiri IDM watcher"
  path = $exePath
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 5

Set-Content -LiteralPath $manifestPath -Value $hostManifest -Encoding ASCII
New-Item -Path $registryPath -Force | Out-Null
Set-Item -Path $registryPath -Value $manifestPath

Write-Host ""
Write-Host "Native host installed."
Write-Host "Extension ID: $ExtensionId"
Write-Host "Host manifest: $manifestPath"
Write-Host "Executable: $exePath"
