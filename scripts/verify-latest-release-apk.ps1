param(
  [string]$Tag = "",
  [string]$OutputPath = ""
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

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$packageJsonPath = Join-Path $projectRoot "package.json"
$packageJson = Get-Content -Path $packageJsonPath -Raw | ConvertFrom-Json
$version = [string]$packageJson.version
$releaseConfig = $packageJson.tracklogRelease
$owner = if ($releaseConfig.githubOwner) { [string]$releaseConfig.githubOwner } else { "Koutacode" }
$repo = if ($releaseConfig.githubRepo) { [string]$releaseConfig.githubRepo } else { "tracklog-pwa" }
$assetName = if ($releaseConfig.apkAssetName) { [string]$releaseConfig.apkAssetName } else { "tracklog-assist-debug.apk" }
$localApkPath = if ($OutputPath) {
  $OutputPath
} elseif ($releaseConfig.localApkPath) {
  [string]$releaseConfig.localApkPath
} else {
  "output/tracklog-assist-debug.apk"
}

if (!$Tag) {
  $Tag = "v$version"
}

if ($Tag -ne "v$version") {
  throw "Tag $Tag does not match package.json version $version"
}

$tempDir = Join-Path $projectRoot ".codex-temp\release-apk-$($Tag -replace '[^a-zA-Z0-9_.-]', '-')"
if (Test-Path $tempDir) {
  Remove-Item -LiteralPath $tempDir -Recurse -Force
}
New-Item -ItemType Directory -Path $tempDir | Out-Null

Push-Location $projectRoot
try {
  $releaseJson = gh release view $Tag --repo "$owner/$repo" --json tagName,assets | ConvertFrom-Json
  if ($releaseJson.tagName -ne $Tag) {
    throw "GitHub release tag mismatch: $($releaseJson.tagName)"
  }
  $asset = @($releaseJson.assets | Where-Object { $_.name -eq $assetName }) | Select-Object -First 1
  if (!$asset) {
    throw "Release asset $assetName was not found on $owner/$repo $Tag"
  }

  Invoke-CheckedCommand {
    gh release download $Tag --repo "$owner/$repo" --pattern $assetName --dir $tempDir --clobber
  } "gh release download"
} finally {
  Pop-Location
}

$downloadedApk = Join-Path $tempDir $assetName
if (!(Test-Path $downloadedApk)) {
  throw "Downloaded APK not found: $downloadedApk"
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($downloadedApk)
try {
  $versionEntry = $zip.Entries | Where-Object { $_.FullName -eq "assets/public/version.json" } | Select-Object -First 1
  if (!$versionEntry) {
    throw "assets/public/version.json was not found in the APK"
  }
  $reader = New-Object System.IO.StreamReader($versionEntry.Open())
  try {
    $versionJson = $reader.ReadToEnd() | ConvertFrom-Json
  } finally {
    $reader.Dispose()
  }
} finally {
  $zip.Dispose()
}

if ([string]$versionJson.version -ne $version) {
  throw "APK version $($versionJson.version) does not match package.json version $version"
}

$outputApk = Join-Path $projectRoot $localApkPath
$outputDir = Split-Path -Parent $outputApk
if (!(Test-Path $outputDir)) {
  New-Item -ItemType Directory -Path $outputDir | Out-Null
}
Copy-Item -Force $downloadedApk $outputApk

$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
  $stream = [System.IO.File]::OpenRead($outputApk)
  try {
    $hashBytes = $sha256.ComputeHash($stream)
  } finally {
    $stream.Dispose()
  }
  $sha = ([System.BitConverter]::ToString($hashBytes)).Replace("-", "")
} finally {
  $sha256.Dispose()
}
Write-Host "Release APK verified"
Write-Host "Tag: $Tag"
Write-Host "Asset: $assetName"
Write-Host "Output: $outputApk"
Write-Host "Version: $($versionJson.version)"
Write-Host "Build date: $($versionJson.buildDate)"
Write-Host "SHA-256: $sha"
