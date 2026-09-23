Set-StrictMode -Version Latest
$script:MarkerName = '.tracklog-temporary-workspace.json'
$script:LockName = '.active.lock'
$script:ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$script:IdPattern = '\A[a-z0-9][a-z0-9-]{0,39}-[a-f0-9]{32}\z'

function Assert-OrdinaryPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        $item = $null
        try { $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop }
        catch [System.Management.Automation.ItemNotFoundException] { }
        if ($null -ne $item) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'A reparse point was found. This workspace cannot be processed.'
            }
        }
        $current = [IO.Path]::GetDirectoryName($current)
    }
}

function Get-TemporaryRoot {
    $localData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    if (-not $localData -or -not [IO.Path]::IsPathRooted($localData)) {
        throw 'Windows LocalApplicationData is unavailable.'
    }
    $root = [IO.Path]::GetFullPath((Join-Path $localData 'TrackLog\temporary-work')).TrimEnd('\')
    Assert-OrdinaryPath $root
    return $root
}

function Assert-OrdinaryTree {
    param([Parameter(Mandatory = $true)][string]$Path)
    Assert-OrdinaryPath $Path
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($Path)
    while ($pending.Count -gt 0) {
        foreach ($item in @(Get-ChildItem -LiteralPath $pending.Pop() -Force -ErrorAction Stop)) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'A reparse point was found inside the workspace. Removal was refused.'
            }
            if ($item.PSIsContainer) { $pending.Push($item.FullName) }
        }
    }
}

function Get-OwnedWorkspace {
    param([Parameter(Mandatory = $true)][string]$WorkspaceId)
    if ($WorkspaceId -cnotmatch $script:IdPattern) { throw 'Invalid workspace ID.' }
    $root = Get-TemporaryRoot
    $path = [IO.Path]::GetFullPath((Join-Path $root $WorkspaceId))
    if (-not [string]::Equals([IO.Path]::GetDirectoryName($path), $root, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The workspace must be a direct child of the fixed temporary root.'
    }
    Assert-OrdinaryPath $path
    $directory = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if (-not $directory.PSIsContainer) { throw 'The workspace is not a directory.' }
    $markerPath = Join-Path $path $script:MarkerName
    Assert-OrdinaryPath $markerPath
    $markerFile = Get-Item -LiteralPath $markerPath -Force -ErrorAction Stop
    if ($markerFile.PSIsContainer -or $markerFile.Length -gt 4096) { throw 'Invalid workspace ownership marker.' }
    $marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if ($marker.schemaVersion -ne 1 -or $marker.workspaceId -cne $WorkspaceId -or
        $marker.name -cnotmatch '\A[a-z0-9][a-z0-9-]{0,39}\z' -or
        $WorkspaceId.Substring(0, $WorkspaceId.Length - 33) -cne $marker.name -or
        -not [string]::Equals($marker.projectRoot, $script:ProjectRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The workspace ownership marker does not match this project.'
    }
    $null = [DateTimeOffset]::Parse($marker.createdUtc, [Globalization.CultureInfo]::InvariantCulture)
    return [pscustomobject]@{ WorkspaceId = $WorkspaceId; Name = $marker.name; Path = $path; CreatedUtc = $marker.createdUtc }
}

function Open-WorkspaceLock {
    param([Parameter(Mandatory = $true)][string]$Path)
    $lockPath = Join-Path $Path $script:LockName
    Assert-OrdinaryPath $lockPath
    try {
        return [IO.File]::Open($lockPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    } catch {
        throw 'The workspace is active, inaccessible, or its lock file is missing. Removal was refused.'
    }
}

function New-TrackLogTemporaryWorkspace {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][ValidatePattern('\A[a-z0-9][a-z0-9-]{0,39}\z')][string]$Name)
    $ErrorActionPreference = 'Stop'
    if ($Name -cnotmatch '\A[a-z0-9][a-z0-9-]{0,39}\z') { throw 'Use a lowercase ASCII workspace name.' }
    $root = Get-TemporaryRoot
    $null = New-Item -ItemType Directory -Path $root -Force
    Assert-OrdinaryPath $root
    $id = $Name + '-' + [Guid]::NewGuid().ToString('N')
    $path = Join-Path $root $id
    $null = New-Item -ItemType Directory -Path $path
    Assert-OrdinaryPath $path
    $marker = [ordered]@{
        schemaVersion = 1; workspaceId = $id; name = $Name
        createdUtc = [DateTimeOffset]::UtcNow.ToString('o'); projectRoot = $script:ProjectRoot
    }
    $marker | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $path $script:MarkerName) -Encoding UTF8
    $null = New-Item -ItemType File -Path (Join-Path $path $script:LockName)
    return Get-OwnedWorkspace $id
}

function Get-TrackLogTemporaryWorkspace {
    [CmdletBinding()]
    param()
    $root = Get-TemporaryRoot
    if (-not (Test-Path -LiteralPath $root)) { return }
    foreach ($item in @(Get-ChildItem -LiteralPath $root -Force -ErrorAction Stop)) {
        if (-not $item.PSIsContainer -or $item.Name -cnotmatch $script:IdPattern) { continue }
        try {
            $workspace = Get-OwnedWorkspace $item.Name
            $active = $true
            $lock = $null
            try { $lock = Open-WorkspaceLock $workspace.Path; $active = $false }
            catch { $active = $true }
            finally { if ($null -ne $lock) { $lock.Dispose() } }
            $workspace | Add-Member -NotePropertyName Active -NotePropertyValue $active -PassThru
        } catch {
            Write-Warning ('Ignored an unverified workspace: ' + $item.Name)
        }
    }
}

function Remove-TrackLogTemporaryWorkspace {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$WorkspaceId)
    $ErrorActionPreference = 'Stop'
    $workspace = Get-OwnedWorkspace $WorkspaceId
    $lock = Open-WorkspaceLock $workspace.Path
    try {
        $workspace = Get-OwnedWorkspace $WorkspaceId
        Assert-OrdinaryTree $workspace.Path
    } finally { $lock.Dispose() }
    # Validate the final absolute target again immediately before the sole deletion operation.
    $workspace = Get-OwnedWorkspace $WorkspaceId
    Assert-OrdinaryTree $workspace.Path
    Remove-Item -LiteralPath $workspace.Path -Recurse -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $workspace.Path) { throw 'Workspace cleanup did not complete.' }
    return [pscustomobject]@{ WorkspaceId = $WorkspaceId; Removed = $true }
}

function Invoke-TrackLogTemporaryWorkspace {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$ScriptArguments = @()
    )
    $ErrorActionPreference = 'Stop'
    $scriptFile = Get-Item -LiteralPath $ScriptPath -Force -ErrorAction Stop
    if ($scriptFile.PSIsContainer -or $scriptFile.Extension -ine '.ps1') { throw 'ScriptPath must be an existing PowerShell .ps1 file.' }
    $workspace = New-TrackLogTemporaryWorkspace -Name $Name
    $lock = $null
    $workFailure = $null
    $cleanupFailure = $null
    $previousExitCode = Get-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
    $previousExitCodeValue = if ($null -ne $previousExitCode) { $previousExitCode.Value } else { $null }
    try {
        $lock = Open-WorkspaceLock $workspace.Path
        Write-Information ('Temporary workspace: ' + $workspace.WorkspaceId) -InformationAction Continue
        $global:LASTEXITCODE = 0
        & $scriptFile.FullName -TemporaryWorkspacePath $workspace.Path @ScriptArguments
        if (-not $? -or $global:LASTEXITCODE -ne 0) { throw ('The work script failed (exit code ' + $global:LASTEXITCODE + ').') }
    } catch { $workFailure = $_ }
    finally {
        if ($null -ne $previousExitCode) { $global:LASTEXITCODE = $previousExitCodeValue }
        else { Remove-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue }
        if ($null -ne $lock) { $lock.Dispose() }
        try { $null = Remove-TrackLogTemporaryWorkspace -WorkspaceId $workspace.WorkspaceId }
        catch { $cleanupFailure = $_ }
    }
    if ($null -ne $cleanupFailure) {
        $message = 'Cleanup failed for workspace ' + $workspace.WorkspaceId + ': ' + $cleanupFailure.Exception.Message
        if ($null -ne $workFailure) { $message = 'Work failed: ' + $workFailure.Exception.Message + '. ' + $message }
        throw $message
    }
    if ($null -ne $workFailure) { throw $workFailure }
    return [pscustomobject]@{ WorkspaceId = $workspace.WorkspaceId; Removed = $true; Completed = $true }
}

Export-ModuleMember -Function New-TrackLogTemporaryWorkspace, Get-TrackLogTemporaryWorkspace, Remove-TrackLogTemporaryWorkspace, Invoke-TrackLogTemporaryWorkspace
