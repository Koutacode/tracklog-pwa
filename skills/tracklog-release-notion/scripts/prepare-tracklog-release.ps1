param(
  [switch]$Build,
  [switch]$SyncAndroid,
  [switch]$AssembleDebug
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

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
$debugApk = Join-Path $androidDir "app\build\outputs\apk\debug\app-debug.apk"
$outputApk = Join-Path $projectRoot $localApkPath
$outputDir = Split-Path -Parent $outputApk

function Invoke-Step {
  param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][scriptblock]$Action
  )
  Write-Host ""
  Write-Host "== $Title =="
  & $Action
}

if ($Build) {
  Invoke-Step -Title "npm run build" -Action {
    Push-Location $projectRoot
    try {
      npm run build
    } finally {
      Pop-Location
    }
  }
}

if ($SyncAndroid) {
  Invoke-Step -Title "npx cap sync android" -Action {
    Push-Location $projectRoot
    try {
      npx cap sync android
    } finally {
      Pop-Location
    }
  }
}

if ($AssembleDebug) {
  Invoke-Step -Title "gradlew assembleDebug" -Action {
    Push-Location $androidDir
    try {
      .\gradlew.bat assembleDebug
    } finally {
      Pop-Location
    }
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
  $hash = Get-FileHash -Algorithm SHA256 $outputApk
  $apkInfoText = "{0:N0} bytes ({1})" -f $apk.Length, $apk.Name
  $shaText = $hash.Hash.ToUpperInvariant()
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
