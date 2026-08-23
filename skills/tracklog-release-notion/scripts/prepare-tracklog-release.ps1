param(
  [switch]$Build,
  [switch]$SyncAndroid,
  [switch]$AssembleDebug,
  [string]$AppBuildDir = "build-release",
  [string]$GradleBuildRoot = (Join-Path $env:LOCALAPPDATA "TrackLog\android-gradle-release")
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

function Get-NormalizedPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$BasePath
  )

  if ([System.IO.Path]::IsPathRooted($Path)) {
    return [System.IO.Path]::GetFullPath($Path)
  }

  return [System.IO.Path]::GetFullPath((Join-Path $BasePath $Path))
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
$resolvedGradleBuildRoot = Get-NormalizedPath -Path $GradleBuildRoot -BasePath $projectRoot
$resolvedAppBuildDir = if ([System.IO.Path]::IsPathRooted($AppBuildDir)) {
  [System.IO.Path]::GetFullPath($AppBuildDir)
} else {
  Get-NormalizedPath -Path $AppBuildDir -BasePath $resolvedGradleBuildRoot
}
$debugApk = Join-Path $resolvedAppBuildDir "outputs\apk\debug\app-debug.apk"
$outputApk = Get-NormalizedPath -Path $localApkPath -BasePath $projectRoot
$outputDir = Split-Path -Parent $outputApk
$outputSha256 = "$outputApk.sha256"

$runBuildPipeline = $Build -or $SyncAndroid -or $AssembleDebug
$runAndroidSync = $SyncAndroid -or $AssembleDebug

if ($runBuildPipeline) {
  Push-Location $projectRoot
  try {
    foreach ($scriptName in @("typecheck", "test:logic", "test:sync", "check:csp", "build", "check:offline")) {
      Write-Host ""
      Write-Host "== npm run $scriptName =="
      Invoke-CheckedCommand { & npm.cmd run $scriptName } "npm run $scriptName"
    }
  } finally {
    Pop-Location
  }
}

if ($runAndroidSync) {
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
  Write-Host "== gradlew :app:testDebugUnitTest :app:assembleDebugAndroidTest :app:assembleDebug =="
  Push-Location $androidDir
  try {
    Invoke-CheckedCommand {
      .\gradlew.bat `
        "-PtracklogExternalBuildRoot=$resolvedGradleBuildRoot" `
        "-PtracklogAppBuildDir=$resolvedAppBuildDir" `
        --no-daemon `
        :app:testDebugUnitTest `
        :app:assembleDebugAndroidTest `
        :app:assembleDebug
    } "gradlew :app:testDebugUnitTest :app:assembleDebugAndroidTest :app:assembleDebug"
  } finally {
    Pop-Location
  }
}

if ($AssembleDebug -and (Test-Path $debugApk)) {
  if (!(Test-Path $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir | Out-Null
  }
  Copy-Item -Force $debugApk $outputApk
} elseif ($AssembleDebug) {
  throw "Assembled APK was not found at $debugApk"
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

if ($AssembleDebug -and $apkExists) {
  $shaLine = "{0}  {1}{2}" -f $shaText.ToLowerInvariant(), [System.IO.Path]::GetFileName($outputApk), [Environment]::NewLine
  [System.IO.File]::WriteAllText(
    $outputSha256,
    $shaLine,
    (New-Object System.Text.UTF8Encoding($false))
  )
}

$reportLines = @(
  "## TrackLog Update ($today)",
  "- Branch: ``$branch``",
  "- Commit: ``$shortCommit`` (``$commit``)",
  "- Subject: $subject",
  "- APK: $apkInfoText",
  "- Android build directory: ``$resolvedAppBuildDir``",
  "- Release asset name: $releaseAssetName",
  "- SHA-256: $shaText",
  "- Release URL: $releaseUrl",
  "- Release page: $releasePageUrl"
)
$report = $reportLines -join [Environment]::NewLine

Write-Host ""
Write-Host "== Release Summary =="
Write-Host $report
