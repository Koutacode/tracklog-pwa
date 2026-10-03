param(
  [string]$Tag = "",
  [string]$OutputPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-ProjectPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot
  )

  if ([System.IO.Path]::IsPathRooted($Path)) {
    return [System.IO.Path]::GetFullPath($Path)
  }

  return [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $Path))
}

function Invoke-NativeCommandForOutput {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter(Mandatory = $true)]
    [string[]]$ArgumentList,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  $commandOutput = @(& $FilePath @ArgumentList 2>&1 | ForEach-Object { $_.ToString() })
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    $detail = if ($commandOutput.Count -gt 0) {
      [Environment]::NewLine + ($commandOutput -join [Environment]::NewLine)
    } else {
      ""
    }
    throw "$Label failed with exit code $exitCode$detail"
  }

  return $commandOutput
}

function Find-ExecutablePath {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$CommandNames,
    [Parameter(Mandatory = $true)]
    [AllowEmptyCollection()]
    [string[]]$CandidatePaths
  )

  foreach ($commandName in $CommandNames) {
    $command = Get-Command $commandName -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) {
      return [string]$command.Source
    }
  }

  foreach ($candidatePath in $CandidatePaths) {
    if ($candidatePath -and (Test-Path -LiteralPath $candidatePath -PathType Leaf)) {
      return [System.IO.Path]::GetFullPath($candidatePath)
    }
  }

  return $null
}

function Find-ExistingFile {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$CandidatePaths
  )

  foreach ($candidatePath in $CandidatePaths) {
    if ($candidatePath -and (Test-Path -LiteralPath $candidatePath -PathType Leaf)) {
      return [System.IO.Path]::GetFullPath($candidatePath)
    }
  }

  return $null
}

function Get-VersionSortKey {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Value
  )

  $versionMatch = [regex]::Match($Value, '^\d+(?:\.\d+){0,3}')
  if ($versionMatch.Success) {
    try {
      return [version]$versionMatch.Value
    } catch {
      return [version]"0.0"
    }
  }

  return [version]"0.0"
}

function Get-AndroidSdkRoots {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot
  )

  $sdkCandidates = [System.Collections.Generic.List[string]]::new()
  foreach ($environmentName in @("ANDROID_HOME", "ANDROID_SDK_ROOT")) {
    $environmentPath = [Environment]::GetEnvironmentVariable($environmentName)
    if (![string]::IsNullOrWhiteSpace($environmentPath)) {
      $sdkCandidates.Add($environmentPath)
    }
  }

  $localPropertiesPath = Join-Path $ProjectRoot "android\local.properties"
  if (Test-Path -LiteralPath $localPropertiesPath -PathType Leaf) {
    $localProperties = Get-Content -LiteralPath $localPropertiesPath -Raw
    $sdkMatch = [regex]::Match($localProperties, "(?m)^sdk\.dir=(.+)$")
    if ($sdkMatch.Success) {
      $sdkPath = $sdkMatch.Groups[1].Value.Trim()
      $sdkPath = $sdkPath -replace '\\:', ':'
      $sdkPath = $sdkPath -replace '\\\\', '\'
      $sdkCandidates.Add($sdkPath)
    }
  }

  $localAppData = [Environment]::GetEnvironmentVariable("LOCALAPPDATA")
  if (![string]::IsNullOrWhiteSpace($localAppData)) {
    $sdkCandidates.Add((Join-Path $localAppData "Android\Sdk"))
  }

  $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($sdkCandidate in $sdkCandidates) {
    try {
      $fullPath = [System.IO.Path]::GetFullPath($sdkCandidate)
    } catch {
      continue
    }

    if ((Test-Path -LiteralPath $fullPath -PathType Container) -and $seen.Add($fullPath)) {
      $fullPath
    }
  }
}

function Get-ApkManifestInfo {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ApkPath,
    [AllowNull()]
    [string]$AaptPath,
    [AllowNull()]
    [string]$ApkAnalyzerPath
  )

  if (![string]::IsNullOrWhiteSpace($AaptPath)) {
    try {
      $badgingOutput = Invoke-NativeCommandForOutput -FilePath $AaptPath -ArgumentList @("dump", "badging", $ApkPath) -Label "aapt dump badging"
      $packageLine = $badgingOutput | Where-Object { $_ -match '^package:' } | Select-Object -First 1
      if (!$packageLine) {
        throw "aapt did not return an APK package line."
      }

      $packageMatch = [regex]::Match($packageLine, "(?:^|\s)name='(?<value>[^']+)'" )
      $versionCodeMatch = [regex]::Match($packageLine, "(?:^|\s)versionCode='(?<value>[^']+)'" )
      $versionNameMatch = [regex]::Match($packageLine, "(?:^|\s)versionName='(?<value>[^']*)'" )
      if (!$packageMatch.Success -or !$versionCodeMatch.Success -or !$versionNameMatch.Success) {
        throw "Unable to parse package, versionCode, or versionName from aapt output: $packageLine"
      }

      return [pscustomobject]@{
        PackageName = $packageMatch.Groups["value"].Value
        VersionCode = $versionCodeMatch.Groups["value"].Value
        VersionName = $versionNameMatch.Groups["value"].Value
        Inspector = $AaptPath
      }
    } catch {
      if ([string]::IsNullOrWhiteSpace($ApkAnalyzerPath)) {
        throw
      }
      Write-Verbose "aapt inspection failed; falling back to apkanalyzer: $($_.Exception.Message)"
    }
  }

  if (![string]::IsNullOrWhiteSpace($ApkAnalyzerPath)) {
    $packageName = (Invoke-NativeCommandForOutput -FilePath $ApkAnalyzerPath -ArgumentList @("manifest", "application-id", $ApkPath) -Label "apkanalyzer manifest application-id") -join [Environment]::NewLine
    $versionName = (Invoke-NativeCommandForOutput -FilePath $ApkAnalyzerPath -ArgumentList @("manifest", "version-name", $ApkPath) -Label "apkanalyzer manifest version-name") -join [Environment]::NewLine
    $versionCode = (Invoke-NativeCommandForOutput -FilePath $ApkAnalyzerPath -ArgumentList @("manifest", "version-code", $ApkPath) -Label "apkanalyzer manifest version-code") -join [Environment]::NewLine
    return [pscustomobject]@{
      PackageName = $packageName.Trim()
      VersionCode = $versionCode.Trim()
      VersionName = $versionName.Trim()
      Inspector = $ApkAnalyzerPath
    }
  }

  throw "Neither aapt nor apkanalyzer is available. Install Android SDK Build-Tools or Command-line Tools and retry."
}

function Normalize-CertificateDigest {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Digest
  )

  $normalized = ($Digest -replace '[^0-9a-fA-F]', '').ToLowerInvariant()
  if ($normalized.Length -ne 64) {
    throw "Invalid SHA-256 certificate digest: $Digest"
  }
  return $normalized
}

function Get-ApkSignerDigests {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ApkPath,
    [Parameter(Mandatory = $true)]
    [string]$ApkSignerPath
  )

  $signerOutput = Invoke-NativeCommandForOutput -FilePath $ApkSignerPath -ArgumentList @("verify", "--print-certs", $ApkPath) -Label "apksigner verify"
  $signerText = $signerOutput -join [Environment]::NewLine
  $digestMatches = [regex]::Matches($signerText, "(?im)Signer #\d+ certificate SHA-256 digest:\s*([0-9a-fA-F:]+)")
  $digests = @($digestMatches | ForEach-Object { Normalize-CertificateDigest -Digest $_.Groups[1].Value } | Sort-Object -Unique)
  if ($digests.Count -eq 0) {
    throw "apksigner verified the APK but did not report a SHA-256 signer certificate digest: $ApkPath"
  }
  return $digests
}

function Get-KeystoreSignerDigests {
  param(
    [Parameter(Mandatory = $true)]
    [string]$KeystorePath,
    [Parameter(Mandatory = $true)]
    [string]$KeytoolPath
  )

  $keytoolOutput = Invoke-NativeCommandForOutput -FilePath $KeytoolPath -ArgumentList @(
    "-list",
    "-v",
    "-keystore", $KeystorePath,
    "-storepass", "android",
    "-alias", "androiddebugkey"
  ) -Label "keytool signer inspection"
  $keytoolText = $keytoolOutput -join [Environment]::NewLine
  $digestMatches = [regex]::Matches($keytoolText, "(?im)SHA256:\s*([0-9a-fA-F:]+)")
  $digests = @($digestMatches | ForEach-Object { Normalize-CertificateDigest -Digest $_.Groups[1].Value } | Sort-Object -Unique)
  if ($digests.Count -eq 0) {
    throw "keytool did not report a SHA-256 certificate digest for $KeystorePath"
  }
  return $digests
}

function Get-FileSha256 {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::OpenRead($Path)
    try {
      $hashBytes = $sha256.ComputeHash($stream)
    } finally {
      $stream.Dispose()
    }
  } finally {
    $sha256.Dispose()
  }

  return ([System.BitConverter]::ToString($hashBytes)).Replace("-", "")
}

function Install-VerifiedReleaseArtifactAtomically {
  param(
    [Parameter(Mandatory = $true)]
    [string]$SourcePath,
    [Parameter(Mandatory = $true)]
    [string]$DestinationPath,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedSha256,
    [Parameter(Mandatory = $true)]
    [string]$SidecarPath,
    [Parameter(Mandatory = $true)]
    [string]$SidecarText
  )

  $destinationFullPath = [System.IO.Path]::GetFullPath($DestinationPath)
  $destinationDirectory = [System.IO.Path]::GetFullPath((Split-Path -Parent $destinationFullPath))
  if (!(Test-Path -LiteralPath $destinationDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $destinationDirectory | Out-Null
  }

  $sidecarFullPath = [System.IO.Path]::GetFullPath($SidecarPath)
  $sidecarDirectory = [System.IO.Path]::GetFullPath((Split-Path -Parent $sidecarFullPath))
  if ($sidecarDirectory -cne $destinationDirectory) {
    throw "APK and SHA-256 sidecar must use the same output directory."
  }

  $destinationLeafName = [System.IO.Path]::GetFileName($destinationFullPath)
  $sidecarLeafName = [System.IO.Path]::GetFileName($sidecarFullPath)
  $transactionId = [guid]::NewGuid().ToString("N")
  $stagedPath = [System.IO.Path]::GetFullPath((Join-Path $destinationDirectory ".$destinationLeafName.$transactionId.staged"))
  $backupPath = [System.IO.Path]::GetFullPath((Join-Path $destinationDirectory ".$destinationLeafName.$transactionId.backup"))
  $stagedSidecarPath = [System.IO.Path]::GetFullPath((Join-Path $destinationDirectory ".$sidecarLeafName.$transactionId.staged"))
  $backupSidecarPath = [System.IO.Path]::GetFullPath((Join-Path $destinationDirectory ".$sidecarLeafName.$transactionId.backup"))
  $destinationDirectoryPrefix = $destinationDirectory.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  foreach ($transactionPath in @($stagedPath, $backupPath, $stagedSidecarPath, $backupSidecarPath)) {
    if (!$transactionPath.StartsWith($destinationDirectoryPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Unsafe atomic replacement path: $transactionPath"
    }
  }

  $originalExisted = Test-Path -LiteralPath $destinationFullPath -PathType Leaf
  $sidecarOriginallyExisted = Test-Path -LiteralPath $sidecarFullPath -PathType Leaf
  $destinationUpdated = $false
  $sidecarUpdated = $false
  $verificationSucceeded = $false
  try {
    Copy-Item -LiteralPath $SourcePath -Destination $stagedPath
    $stagedSha = Get-FileSha256 -Path $stagedPath
    if ($stagedSha -cne $ExpectedSha256) {
      throw "Staged APK SHA-256 mismatch. Expected $ExpectedSha256, received $stagedSha"
    }
    [System.IO.File]::WriteAllText(
      $stagedSidecarPath,
      $SidecarText,
      (New-Object System.Text.UTF8Encoding($false))
    )
    if ([System.IO.File]::ReadAllText($stagedSidecarPath) -cne $SidecarText) {
      throw "Staged APK SHA-256 sidecar verification failed."
    }

    if ($originalExisted) {
      [System.IO.File]::Replace($stagedPath, $destinationFullPath, $backupPath, $true)
    } else {
      [System.IO.File]::Move($stagedPath, $destinationFullPath)
    }
    $destinationUpdated = $true

    if ($sidecarOriginallyExisted) {
      [System.IO.File]::Replace($stagedSidecarPath, $sidecarFullPath, $backupSidecarPath, $true)
    } else {
      [System.IO.File]::Move($stagedSidecarPath, $sidecarFullPath)
    }
    $sidecarUpdated = $true

    $outputSha = Get-FileSha256 -Path $destinationFullPath
    if ($outputSha -cne $ExpectedSha256) {
      throw "Installed APK SHA-256 mismatch. Expected $ExpectedSha256, received $outputSha"
    }
    if ([System.IO.File]::ReadAllText($sidecarFullPath) -cne $SidecarText) {
      throw "Installed APK SHA-256 sidecar verification failed."
    }
    $verificationSucceeded = $true
    return $outputSha
  } catch {
    $installationFailure = $_
    $rollbackErrors = New-Object System.Collections.Generic.List[string]
    if ($sidecarUpdated) {
      try {
        if ($sidecarOriginallyExisted -and (Test-Path -LiteralPath $backupSidecarPath -PathType Leaf)) {
          [System.IO.File]::Replace($backupSidecarPath, $sidecarFullPath, $null, $true)
        } elseif (!$sidecarOriginallyExisted -and (Test-Path -LiteralPath $sidecarFullPath -PathType Leaf)) {
          Remove-Item -LiteralPath $sidecarFullPath -Force
        }
      } catch {
        $rollbackErrors.Add("sidecar: $($_.Exception.Message)")
      }
    }
    if ($destinationUpdated) {
      try {
        if ($originalExisted -and (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
          [System.IO.File]::Replace($backupPath, $destinationFullPath, $null, $true)
        } elseif (!$originalExisted -and (Test-Path -LiteralPath $destinationFullPath -PathType Leaf)) {
          Remove-Item -LiteralPath $destinationFullPath -Force
        }
      } catch {
        $rollbackErrors.Add("APK: $($_.Exception.Message)")
      }
    }
    if ($rollbackErrors.Count -gt 0) {
      throw "Release APK installation failed and rollback also failed. Original error: $($installationFailure.Exception.Message). Rollback error(s): $($rollbackErrors -join '; '). Backups retained in $destinationDirectory"
    }
    throw $installationFailure
  } finally {
    foreach ($stagedFile in @($stagedPath, $stagedSidecarPath)) {
      if (Test-Path -LiteralPath $stagedFile -PathType Leaf) {
        Remove-Item -LiteralPath $stagedFile -Force
      }
    }
    if ($verificationSucceeded) {
      foreach ($backupFile in @($backupPath, $backupSidecarPath)) {
        if (Test-Path -LiteralPath $backupFile -PathType Leaf) {
          Remove-Item -LiteralPath $backupFile -Force
        }
      }
    }
  }
}

$projectRoot = [System.IO.Path]::GetFullPath((Resolve-Path (Join-Path $PSScriptRoot "..")).Path)
$packageJsonPath = Join-Path $projectRoot "package.json"
$gradlePropertiesPath = Join-Path $projectRoot "android\gradle.properties"
$packageJson = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
$version = [string]$packageJson.version
$releaseConfig = $packageJson.tracklogRelease
$owner = if ($releaseConfig -and $releaseConfig.githubOwner) { [string]$releaseConfig.githubOwner } else { "Koutacode" }
$repo = if ($releaseConfig -and $releaseConfig.githubRepo) { [string]$releaseConfig.githubRepo } else { "tracklog-pwa" }
$assetName = if ($releaseConfig -and $releaseConfig.apkAssetName) { [string]$releaseConfig.apkAssetName } else { "tracklog-assist-debug.apk" }
$configuredLocalApkPath = if ($releaseConfig -and $releaseConfig.localApkPath) { [string]$releaseConfig.localApkPath } else { "output/tracklog-assist-debug.apk" }
$localApkPath = if ($OutputPath) { $OutputPath } else { $configuredLocalApkPath }
$outputApk = Resolve-ProjectPath -Path $localApkPath -ProjectRoot $projectRoot
$configuredOutputApk = Resolve-ProjectPath -Path $configuredLocalApkPath -ProjectRoot $projectRoot
$expectedPackageName = "com.tracklog.assist"

$gradleProperties = Get-Content -LiteralPath $gradlePropertiesPath -Raw
$gradleVersionNameMatch = [regex]::Match($gradleProperties, "(?m)^tracklogVersionName=(.+)$")
$gradleVersionCodeMatch = [regex]::Match($gradleProperties, "(?m)^tracklogVersionCode=(.+)$")
if (!$gradleVersionNameMatch.Success -or !$gradleVersionCodeMatch.Success) {
  throw "tracklogVersionName or tracklogVersionCode is missing from android/gradle.properties"
}
$expectedVersionName = $gradleVersionNameMatch.Groups[1].Value.Trim()
$expectedVersionCode = $gradleVersionCodeMatch.Groups[1].Value.Trim()
$parsedVersionCode = 0
if ($expectedVersionName -ne $version) {
  throw "Android versionName $expectedVersionName does not match package.json version $version"
}
if (![int]::TryParse($expectedVersionCode, [ref]$parsedVersionCode) -or $parsedVersionCode -le 0) {
  throw "Android versionCode is invalid: $expectedVersionCode"
}

if (!$Tag) {
  $Tag = "v$version"
}
if ($Tag -ne "v$version") {
  throw "Tag $Tag does not match package.json version $version"
}

$sdkRoots = @(Get-AndroidSdkRoots -ProjectRoot $projectRoot)
$buildToolsDirectories = @(
  foreach ($sdkRoot in $sdkRoots) {
    $buildToolsRoot = Join-Path $sdkRoot "build-tools"
    if (Test-Path -LiteralPath $buildToolsRoot -PathType Container) {
      Get-ChildItem -LiteralPath $buildToolsRoot -Directory
    }
  }
) | Sort-Object @{ Expression = { Get-VersionSortKey -Value $_.Name } }, @{ Expression = { $_.Name } } -Descending
$apkAnalyzerCandidates = @(
  foreach ($sdkRoot in $sdkRoots) {
    $commandLineToolsRoot = Join-Path $sdkRoot "cmdline-tools"
    if (Test-Path -LiteralPath $commandLineToolsRoot -PathType Container) {
      foreach ($commandLineToolsDirectory in (Get-ChildItem -LiteralPath $commandLineToolsRoot -Directory | Sort-Object Name -Descending)) {
        Join-Path $commandLineToolsDirectory.FullName "bin\apkanalyzer.bat"
        Join-Path $commandLineToolsDirectory.FullName "bin\apkanalyzer"
      }
    }
    Join-Path $sdkRoot "tools\bin\apkanalyzer.bat"
    Join-Path $sdkRoot "tools\bin\apkanalyzer"
  }
)

$apkAnalyzerPath = Find-ExecutablePath -CommandNames @("apkanalyzer.bat", "apkanalyzer") -CandidatePaths $apkAnalyzerCandidates
$aaptPath = $null
$apkSignerPath = $null
foreach ($buildToolsDirectory in $buildToolsDirectories) {
  $directoryApkSigner = Find-ExistingFile -CandidatePaths @(
    (Join-Path $buildToolsDirectory.FullName "apksigner.bat"),
    (Join-Path $buildToolsDirectory.FullName "apksigner")
  )
  if ($directoryApkSigner) {
    $apkSignerPath = $directoryApkSigner
    $aaptPath = Find-ExistingFile -CandidatePaths @(
      (Join-Path $buildToolsDirectory.FullName "aapt.exe"),
      (Join-Path $buildToolsDirectory.FullName "aapt")
    )
    break
  }
}

if (!$apkSignerPath) {
  $apkSignerPath = Find-ExecutablePath -CommandNames @("apksigner.bat", "apksigner") -CandidatePaths @()
}
if (!$aaptPath -and !$apkAnalyzerPath) {
  $aaptPath = Find-ExecutablePath -CommandNames @("aapt.exe", "aapt") -CandidatePaths @()
}
if (!$aaptPath -and !$apkAnalyzerPath) {
  throw "Neither aapt nor apkanalyzer was found. Install Android SDK Build-Tools or Command-line Tools, or set ANDROID_HOME/ANDROID_SDK_ROOT."
}
if (!$apkSignerPath) {
  throw "apksigner was not found. Install Android SDK Build-Tools, or set ANDROID_HOME/ANDROID_SDK_ROOT."
}

$trustedSignerDigests = @()
$trustedSignerSource = ""
$existingSignerReferenceApk = if (Test-Path -LiteralPath $configuredOutputApk -PathType Leaf) {
  $configuredOutputApk
} elseif (($outputApk -ne $configuredOutputApk) -and (Test-Path -LiteralPath $outputApk -PathType Leaf)) {
  $outputApk
} else {
  ""
}
$configuredKeystorePath = [Environment]::GetEnvironmentVariable("TRACKLOG_ANDROID_KEYSTORE_PATH")
if (![string]::IsNullOrWhiteSpace($configuredKeystorePath)) {
  $configuredKeystorePath = [System.IO.Path]::GetFullPath($configuredKeystorePath)
  if (!(Test-Path -LiteralPath $configuredKeystorePath -PathType Leaf)) {
    throw "TRACKLOG_ANDROID_KEYSTORE_PATH does not point to a file: $configuredKeystorePath"
  }
  $keytoolPath = Find-ExecutablePath -CommandNames @("keytool.exe", "keytool") -CandidatePaths @()
  if (!$keytoolPath) {
    throw "keytool was not found, so TRACKLOG_ANDROID_KEYSTORE_PATH cannot be used as the trusted signer. Install a JDK and retry."
  }
  $trustedSignerDigests = @(Get-KeystoreSignerDigests -KeystorePath $configuredKeystorePath -KeytoolPath $keytoolPath)
  $trustedSignerSource = "TRACKLOG_ANDROID_KEYSTORE_PATH ($configuredKeystorePath)"
  if ($existingSignerReferenceApk) {
    $existingSignerDigests = @(Get-ApkSignerDigests -ApkPath $existingSignerReferenceApk -ApkSignerPath $apkSignerPath)
    if (($existingSignerDigests -join ',') -cne ($trustedSignerDigests -join ',')) {
      throw "TRACKLOG_ANDROID_KEYSTORE_PATH does not match the existing official APK signer at $existingSignerReferenceApk"
    }
    $trustedSignerSource += " and existing official APK ($existingSignerReferenceApk)"
  }
} elseif ($existingSignerReferenceApk) {
  $trustedSignerDigests = @(Get-ApkSignerDigests -ApkPath $existingSignerReferenceApk -ApkSignerPath $apkSignerPath)
  $trustedSignerSource = "existing official APK ($existingSignerReferenceApk)"
} else {
  $userProfilePath = [Environment]::GetEnvironmentVariable("USERPROFILE")
  $defaultDebugKeystore = if (![string]::IsNullOrWhiteSpace($userProfilePath)) {
    Join-Path $userProfilePath ".android\debug.keystore"
  } else {
    ""
  }
  if (!$defaultDebugKeystore -or !(Test-Path -LiteralPath $defaultDebugKeystore -PathType Leaf)) {
    throw "No trusted TrackLog signer is available. Set TRACKLOG_ANDROID_KEYSTORE_PATH, retain the existing official APK, or restore the official debug keystore before verifying a release."
  }
  $keytoolPath = Find-ExecutablePath -CommandNames @("keytool.exe", "keytool") -CandidatePaths @()
  if (!$keytoolPath) {
    throw "keytool was not found, so the default debug keystore cannot be used as the trusted signer. Install a JDK and retry."
  }
  $trustedSignerDigests = @(Get-KeystoreSignerDigests -KeystorePath $defaultDebugKeystore -KeytoolPath $keytoolPath)
  $trustedSignerSource = "default TrackLog debug keystore ($defaultDebugKeystore)"
}

$systemTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempRoot = [System.IO.Path]::GetFullPath((Join-Path $systemTempRoot "TrackLog"))
$safeTag = $Tag -replace '[^a-zA-Z0-9_.-]', '-'
$tempDirName = "release-apk-$safeTag-$([guid]::NewGuid().ToString('N'))"
$tempDir = [System.IO.Path]::GetFullPath((Join-Path $tempRoot $tempDirName))
$tempRootPrefix = $tempRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (!$tempDir.StartsWith($tempRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Unsafe temporary directory path: $tempDir"
}
if (Test-Path -LiteralPath $tempDir) {
  throw "Refusing to reuse an existing temporary directory: $tempDir"
}
New-Item -ItemType Directory -Path $tempDir | Out-Null

try {
  $ghPath = Find-ExecutablePath -CommandNames @("gh.exe", "gh") -CandidatePaths @()
  if (!$ghPath) {
    throw "GitHub CLI (gh) was not found. Install it and authenticate before verifying a release APK."
  }

  Push-Location $projectRoot
  try {
    $latestReleaseJsonText = Invoke-NativeCommandForOutput -FilePath $ghPath -ArgumentList @(
      "release", "view",
      "--repo", "$owner/$repo",
      "--json", "tagName"
    ) -Label "gh latest release view"
    $latestReleaseJson = ($latestReleaseJsonText -join [Environment]::NewLine) | ConvertFrom-Json
    if ($latestReleaseJson.tagName -ne $Tag) {
      throw "GitHub latest release $($latestReleaseJson.tagName) does not match required release $Tag. Refusing to install or distribute an older APK."
    }

    $releaseJsonText = Invoke-NativeCommandForOutput -FilePath $ghPath -ArgumentList @(
      "release", "view", $Tag,
      "--repo", "$owner/$repo",
      "--json", "tagName,assets"
    ) -Label "gh release view"
    $releaseJson = ($releaseJsonText -join [Environment]::NewLine) | ConvertFrom-Json
    if ($releaseJson.tagName -ne $Tag) {
      throw "GitHub release tag mismatch: $($releaseJson.tagName)"
    }
    $asset = @($releaseJson.assets | Where-Object { $_.name -eq $assetName }) | Select-Object -First 1
    if (!$asset) {
      throw "Release asset $assetName was not found on $owner/$repo $Tag"
    }

    Invoke-NativeCommandForOutput -FilePath $ghPath -ArgumentList @(
      "release", "download", $Tag,
      "--repo", "$owner/$repo",
      "--pattern", $assetName,
      "--dir", $tempDir,
      "--clobber"
    ) -Label "gh release download" | Out-Null
  } finally {
    Pop-Location
  }

  $downloadedApk = Join-Path $tempDir $assetName
  if (!(Test-Path -LiteralPath $downloadedApk -PathType Leaf)) {
    throw "Downloaded APK not found: $downloadedApk"
  }

  $downloadedSignerDigests = @(Get-ApkSignerDigests -ApkPath $downloadedApk -ApkSignerPath $apkSignerPath)
  if (($downloadedSignerDigests -join ',') -cne ($trustedSignerDigests -join ',')) {
    throw "APK signer does not match $trustedSignerSource. Expected $($trustedSignerDigests -join ','), received $($downloadedSignerDigests -join ',')."
  }

  $manifestInfo = Get-ApkManifestInfo -ApkPath $downloadedApk -AaptPath $aaptPath -ApkAnalyzerPath $apkAnalyzerPath
  if ($manifestInfo.PackageName -cne $expectedPackageName) {
    throw "APK package $($manifestInfo.PackageName) does not match expected package $expectedPackageName"
  }
  if ($manifestInfo.VersionName -cne $expectedVersionName) {
    throw "APK versionName $($manifestInfo.VersionName) does not match expected versionName $expectedVersionName"
  }
  if ($manifestInfo.VersionCode -cne $expectedVersionCode) {
    throw "APK versionCode $($manifestInfo.VersionCode) does not match expected versionCode $expectedVersionCode"
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
  if ([string]$versionJson.version -cne $version) {
    throw "Embedded APK version $($versionJson.version) does not match package.json version $version"
  }

  $downloadedSha = Get-FileSha256 -Path $downloadedApk
  $outputSidecar = "$outputApk.sha256"
  $sidecarText = "{0}  {1}{2}" -f $downloadedSha.ToLowerInvariant(), [System.IO.Path]::GetFileName($outputApk), [Environment]::NewLine
  $outputSha = Install-VerifiedReleaseArtifactAtomically `
    -SourcePath $downloadedApk `
    -DestinationPath $outputApk `
    -ExpectedSha256 $downloadedSha `
    -SidecarPath $outputSidecar `
    -SidecarText $sidecarText

  $buildDate = if ($versionJson.PSObject.Properties.Name -contains "buildDate") { [string]$versionJson.buildDate } else { "N/A" }
  Write-Host "Release APK verified"
  Write-Host "Tag: $Tag"
  Write-Host "Asset: $assetName"
  Write-Host "Output: $outputApk"
  Write-Host "Package: $($manifestInfo.PackageName)"
  Write-Host "Version: $($manifestInfo.VersionName) ($($manifestInfo.VersionCode))"
  Write-Host "Build date: $buildDate"
  Write-Host "Manifest inspector: $($manifestInfo.Inspector)"
  Write-Host "Signer source: $trustedSignerSource"
  Write-Host "Signer SHA-256: $($downloadedSignerDigests -join ',')"
  Write-Host "SHA-256: $outputSha"
} finally {
  if ($tempDir.StartsWith($tempRootPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $tempDir)) {
    Remove-Item -LiteralPath $tempDir -Recurse -Force
  }
}
