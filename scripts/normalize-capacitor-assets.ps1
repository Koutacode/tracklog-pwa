param(
  [string]$AssetRoot = "android\app\src\main\assets\public"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$assetRootPath = Resolve-Path (Join-Path $projectRoot $AssetRoot)

if (-not $assetRootPath.Path.StartsWith($projectRoot.Path, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to normalize outside project: $($assetRootPath.Path)"
}

$tempRoot = Join-Path $projectRoot ".codex-temp\asset-normalize"
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

$count = 0
Get-ChildItem -LiteralPath $assetRootPath.Path -File -Recurse | ForEach-Object {
  if (($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
    return
  }

  $fullPath = $_.FullName
  if (-not $fullPath.StartsWith($assetRootPath.Path, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to rewrite outside asset root: $fullPath"
  }

  $tmp = Join-Path $tempRoot ([System.Guid]::NewGuid().ToString("N"))
  [System.IO.File]::WriteAllBytes($tmp, [System.IO.File]::ReadAllBytes($fullPath))
  Remove-Item -LiteralPath $fullPath -Force
  Move-Item -LiteralPath $tmp -Destination $fullPath -Force
  $count++
}

Write-Host "Normalized $count Capacitor asset file(s)."
