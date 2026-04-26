param(
  [switch]$Build,
  [switch]$SyncAndroid,
  [switch]$AssembleDebug,
  [string]$AppBuildDir = "build-release"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory = $true)]
    [scriptblock]$Command,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE"
  }
}

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$packageJsonPath = Join-Path $projectRoot "package.json"
$defaultReleaseOwner = "Koutacode"
$defaultReleaseRepo = "tracklog-pwa"
$defaultAssetName = "tracklog-assist-debug.apk"
$defaultLocalApkPath = "output/tracklog-assist-debug.apk"

$releaseConfig = $null
if (Test-Path $packageJsonPath) {
  try {
    $packageJson = Get-Content -Path $packageJsonPath -Raw | ConvertFrom-Json
    $releaseConfig = $packageJson.tracklogRelease
  } catch {
    $releaseConfig = $null
  }
}

$releaseOwner = if ($releaseConfig -and $releaseConfig.githubOwner) { [string]$releaseConfig.githubOwner } else { $defaultReleaseOwner }
$releaseRepo = if ($releaseConfig -and $releaseConfig.githubRepo) { [string]$releaseConfig.githubRepo } else { $defaultReleaseRepo }
$releaseAssetName = if ($releaseConfig -and $releaseConfig.apkAssetName) { [string]$releaseConfig.apkAssetName } else { $defaultAssetName }
$localApkPath = if ($releaseConfig -and $releaseConfig.localApkPath) { [string]$releaseConfig.localApkPath } else { $defaultLocalApkPath }

$androidDir = Join-Path $projectRoot "android"
$debugApk = Join-Path $androidDir "app\$AppBuildDir\outputs\apk\debug\app-debug.apk"
$outputApk = Join-Path $projectRoot $localApkPath
$outputDir = Split-Path -Parent $outputApk

if ($Build) {
  Write-Host ""
  Write-Host "== npm run build =="
  Push-Location $projectRoot
  try {
    Invoke-CheckedCommand { & npm.cmd run build } "npm run build"
  } finally {
    Pop-Location
  }
}

if ($SyncAndroid) {
  Write-Host ""
  Write-Host "== npx cap sync android =="
  Push-Location $projectRoot
  try {
    Invoke-CheckedCommand { & npx.cmd cap sync android } "npx cap sync android"
    Invoke-CheckedCommand { & powershell.exe -ExecutionPolicy Bypass -File (Join-Path $projectRoot "scripts\normalize-capacitor-assets.ps1") } "normalize-capacitor-assets"
  } finally {
    Pop-Location
  }
}

if ($AssembleDebug) {
  Write-Host ""
  Write-Host "== gradlew assembleDebug =="
  Push-Location $androidDir
  try {
    Invoke-CheckedCommand { .\gradlew.bat "-PtracklogAppBuildDir=$AppBuildDir" --no-daemon assembleDebug } "gradlew assembleDebug"
  } finally {
    Pop-Location
  }
}

if (Test-Path $debugApk) {
  if (!(Test-Path $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir | Out-Null
  }
  Copy-Item -Force $debugApk $outputApk
}

Push-Location $projectRoot
try {
  $branch = (git rev-parse --abbrev-ref HEAD).Trim()
  $commit = (git rev-parse HEAD).Trim()
  $shortCommit = (git rev-parse --short HEAD).Trim()
  $subject = (git log -1 --pretty=%s).Trim()
} finally {
  Pop-Location
}

$today = Get-Date -Format "yyyy-MM-dd"
$releaseUrl = "https://github.com/$releaseOwner/$releaseRepo/releases/latest/download/$releaseAssetName"
$releasePageUrl = "https://github.com/$releaseOwner/$releaseRepo/releases/latest"

$apkExists = Test-Path $outputApk
$apkInfoText = "未生成"
$shaText = "N/A"

if ($apkExists) {
  $apk = Get-Item $outputApk
  $apkInfoText = "{0:N0} bytes ({1})" -f $apk.Length, $apk.Name
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::OpenRead($outputApk)
    try {
      $hashBytes = $sha256.ComputeHash($stream)
    } finally {
      $stream.Dispose()
    }
    $shaText = ([System.BitConverter]::ToString($hashBytes)).Replace("-", "")
  } finally {
    $sha256.Dispose()
  }
}

$reportLines = @(
  "## TrackLog Update ($today)",
  "- Branch: ``$branch``",
  "- Commit: ``$shortCommit`` (``$commit``)",
  "- Subject: $subject",
  "- APK: $apkInfoText",
  "- Release asset name: $releaseAssetName",
  "- SHA-256: $shaText",
  "- Release URL: $releaseUrl",
  "- Release page: $releasePageUrl"
)
$report = $reportLines -join [Environment]::NewLine

Write-Host ""
Write-Host "== Release Summary =="
Write-Host $report
