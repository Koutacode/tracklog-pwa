[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$modulePath = Join-Path $PSScriptRoot 'TrackLogTemporaryWorkspace.psm1'
$cliPath = Join-Path $PSScriptRoot 'use-tracklog-temporary-workspace.ps1'
$module = Import-Module $modulePath -Force -PassThru
$shellPath = (Get-Process -Id $PID).Path
$ownedIds = New-Object 'System.Collections.Generic.List[string]'
$failures = New-Object 'System.Collections.Generic.List[string]'
$testCount = 0
$markerName = '.tracklog-temporary-workspace.json'
$testPrefix = 'selftest-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-Rejected {
    param([scriptblock]$Action, [string]$Message)
    $rejected = $false
    try { $null = & $Action } catch { $rejected = $true }
    Assert-True $rejected $Message
}

function New-TestWorkspace {
    param([string]$Suffix)
    $workspace = New-TrackLogTemporaryWorkspace -Name ($testPrefix + '-' + $Suffix)
    $ownedIds.Add($workspace.WorkspaceId)
    return $workspace
}

function Invoke-Test {
    param([string]$Name, [scriptblock]$Action)
    $script:testCount++
    try {
        & $Action
        Write-Host ('PASS ' + $Name)
    } catch {
        $failures.Add($Name + ': ' + $_.Exception.Message)
        Write-Host ('FAIL ' + $Name + ': ' + $_.Exception.Message)
    }
}

function Invoke-Cli {
    param([string[]]$Arguments)
    # This invokes a process directly with an argument array, never a generated shell command.
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $result = & $shellPath -NoProfile -NonInteractive -File $cliPath @Arguments 2>&1
        $code = $LASTEXITCODE
        return [pscustomobject]@{ ExitCode = $code; Text = ($result | Out-String) }
    } finally { $ErrorActionPreference = $previousPreference }
}

function Write-TestText {
    param([string]$Path, [string]$Text)
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}

function Remove-TestJunction {
    param([string]$Path, [string]$OwnedParent)
    $fullPath = [IO.Path]::GetFullPath($Path)
    Assert-True ([string]::Equals([IO.Path]::GetDirectoryName($fullPath), $OwnedParent, [StringComparison]::OrdinalIgnoreCase)) 'Junction cleanup target escaped its generated workspace.'
    if (Test-Path -LiteralPath $fullPath) {
        $item = Get-Item -LiteralPath $fullPath -Force
        Assert-True (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) 'Only the generated junction itself may be removed here.'
        # Nonrecursive deletion removes the junction entry and never traverses its target.
        [IO.Directory]::Delete($fullPath, $false)
    }
}

$control = $null
try {
    $control = New-TestWorkspace 'control'
    $successScript = Join-Path $control.Path 'success.ps1'
    $failureScript = Join-Path $control.Path 'failure.ps1'
    $exitScript = Join-Path $control.Path 'exit.ps1'
    $nativeFailureScript = Join-Path $control.Path 'native-failure.ps1'
    $cleanupFailureScript = Join-Path $control.Path 'cleanup-failure.ps1'
    $receiptPath = Join-Path $control.Path 'receipt.json'
    Write-TestText $successScript @'
[CmdletBinding(PositionalBinding = $false)]
param([string]$TemporaryWorkspacePath, [Parameter(Position = 0)][string]$ReceiptPath, [Parameter(Position = 1)][string]$Second, [Parameter(Position = 2)][string]$Third)
$ErrorActionPreference = 'Stop'
$probe = $null
$lockHeld = $false
try { $probe = [IO.File]::Open((Join-Path $TemporaryWorkspacePath '.active.lock'), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
catch { $lockHeld = $true }
finally { if ($null -ne $probe) { $probe.Dispose() } }
$nested = New-Item -ItemType Directory -Path (Join-Path $TemporaryWorkspacePath 'generated')
$file = Join-Path $nested.FullName 'readonly.txt'
[IO.File]::WriteAllText($file, 'synthetic test data')
[IO.File]::SetAttributes($file, [IO.FileAttributes]::ReadOnly)
@{ path = $TemporaryWorkspacePath; lockHeld = $lockHeld; second = $Second; third = $Third } | ConvertTo-Json | Set-Content -LiteralPath $ReceiptPath -Encoding UTF8
'@
    Write-TestText $failureScript @'
[CmdletBinding(PositionalBinding = $false)]
param([string]$TemporaryWorkspacePath, [Parameter(Position = 0)][string]$ReceiptPath)
@{ path = $TemporaryWorkspacePath } | ConvertTo-Json | Set-Content -LiteralPath $ReceiptPath -Encoding UTF8
throw 'Expected synthetic work failure.'
'@
    Write-TestText $exitScript @'
[CmdletBinding(PositionalBinding = $false)]
param([string]$TemporaryWorkspacePath, [Parameter(Position = 0)][string]$ReceiptPath)
@{ path = $TemporaryWorkspacePath } | ConvertTo-Json | Set-Content -LiteralPath $ReceiptPath -Encoding UTF8
exit 7
'@
    Write-TestText $nativeFailureScript @'
[CmdletBinding(PositionalBinding = $false)]
param([string]$TemporaryWorkspacePath, [Parameter(Position = 0)][string]$ReceiptPath)
@{ path = $TemporaryWorkspacePath } | ConvertTo-Json | Set-Content -LiteralPath $ReceiptPath -Encoding UTF8
& (Get-Process -Id $PID).Path -NoProfile -NonInteractive -Command 'exit 23'
Write-Output 'A later successful command must not hide the native failure.'
'@
    Write-TestText $cleanupFailureScript @'
[CmdletBinding(PositionalBinding = $false)]
param([string]$TemporaryWorkspacePath, [Parameter(Position = 0)][string]$ReceiptPath)
$markerPath = Join-Path $TemporaryWorkspacePath '.tracklog-temporary-workspace.json'
$originalMarker = [IO.File]::ReadAllText($markerPath)
@{ path = $TemporaryWorkspacePath; marker = $originalMarker } | ConvertTo-Json | Set-Content -LiteralPath $ReceiptPath -Encoding UTF8
$marker = $originalMarker | ConvertFrom-Json
$marker.schemaVersion = 99
$marker | ConvertTo-Json | Set-Content -LiteralPath $markerPath -Encoding UTF8
throw 'Expected synthetic work and cleanup failure.'
'@

    Invoke-Test 'Create/List/Remove use the fixed root and preserve an unrelated workspace' {
        $workspace = New-TestWorkspace 'normal'
        $expectedRoot = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) 'TrackLog\temporary-work')).TrimEnd('\')
        Assert-True ([string]::Equals([IO.Path]::GetDirectoryName($workspace.Path), $expectedRoot, [StringComparison]::OrdinalIgnoreCase)) 'Workspace is outside the fixed root.'
        Assert-True ($workspace.WorkspaceId -cmatch '^[a-z0-9][a-z0-9-]{0,39}-[a-f0-9]{32}$') 'Workspace ID is not a bounded slug and random GUID.'
        $listed = @(Get-TrackLogTemporaryWorkspace | Where-Object { $_.WorkspaceId -eq $workspace.WorkspaceId })
        Assert-True ($listed.Count -eq 1 -and -not $listed[0].Active) 'Created idle workspace was not listed correctly.'
        $null = Remove-TrackLogTemporaryWorkspace -WorkspaceId $workspace.WorkspaceId
        Assert-True (-not (Test-Path -LiteralPath $workspace.Path)) 'Created workspace was not removed.'
        Assert-True (Test-Path -LiteralPath $control.Path) 'Removing one workspace affected another.'
        foreach ($commandName in @('New-TrackLogTemporaryWorkspace', 'Remove-TrackLogTemporaryWorkspace')) {
            $parameters = (Get-Command $commandName).Parameters
            Assert-True (-not $parameters.ContainsKey('Path') -and -not $parameters.ContainsKey('Root')) 'Public API exposes an arbitrary cleanup path.'
        }
    }

    Invoke-Test 'Read-only generated files are removed' {
        $workspace = New-TestWorkspace 'readonly'
        $filePath = Join-Path $workspace.Path 'readonly.txt'
        Write-TestText $filePath 'synthetic readonly fixture'
        [IO.File]::SetAttributes($filePath, [IO.FileAttributes]::ReadOnly)
        [IO.File]::SetAttributes((Join-Path $workspace.Path '.active.lock'), [IO.FileAttributes]::ReadOnly)
        $null = Remove-TrackLogTemporaryWorkspace -WorkspaceId $workspace.WorkspaceId
        Assert-True (-not (Test-Path -LiteralPath $workspace.Path)) 'Read-only fixture prevented cleanup.'
    }

    Invoke-Test 'Invalid, traversal, wildcard, and unknown IDs are rejected' {
        foreach ($id in @('..', '..\outside', 'C:\Windows', '*', ($testPrefix + '-unknown-' + [Guid]::NewGuid().ToString('N')), ($control.WorkspaceId + "`n"))) {
            Assert-Rejected { Remove-TrackLogTemporaryWorkspace -WorkspaceId $id } ('Unsafe or nonexistent ID was accepted: ' + $id)
        }
        Assert-True (Test-Path -LiteralPath $control.Path) 'Rejected removal changed the control workspace.'
    }

    Invoke-Test 'Create rejects names containing path separators, uppercase, wildcards, or trailing newlines' {
        foreach ($name in @('..\outside', 'Uppercase', '*', "valid-name`n")) {
            Assert-Rejected { New-TrackLogTemporaryWorkspace -Name $name } ('Unsafe workspace name was accepted: ' + $name)
        }
    }

    Invoke-Test 'Ownership schema, ID, project, and missing marker mismatches are rejected' {
        $workspace = New-TestWorkspace 'marker'
        $markerPath = Join-Path $workspace.Path $markerName
        $original = [IO.File]::ReadAllText($markerPath)
        try {
            foreach ($field in @('schemaVersion', 'workspaceId', 'projectRoot')) {
                $marker = $original | ConvertFrom-Json
                switch ($field) {
                    'schemaVersion' { $marker.schemaVersion = 99 }
                    'workspaceId' { $marker.workspaceId = 'other-' + [Guid]::NewGuid().ToString('N') }
                    'projectRoot' { $marker.projectRoot = $marker.projectRoot + '-other-project' }
                }
                Write-TestText $markerPath ($marker | ConvertTo-Json)
                Assert-Rejected { Remove-TrackLogTemporaryWorkspace -WorkspaceId $workspace.WorkspaceId } ('Tampered marker was accepted: ' + $field)
                Assert-True (Test-Path -LiteralPath $workspace.Path) 'Rejected marker caused deletion.'
            }
            Remove-Item -LiteralPath $markerPath -Force
            Assert-Rejected { Remove-TrackLogTemporaryWorkspace -WorkspaceId $workspace.WorkspaceId } 'Workspace with a missing marker was removed.'
        } finally { Write-TestText $markerPath $original }
    }

    Invoke-Test 'An active exclusive lock prevents removal and is reported in List' {
        $workspace = New-TestWorkspace 'locked'
        $lock = [IO.File]::Open((Join-Path $workspace.Path '.active.lock'), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        try {
            Assert-Rejected { Remove-TrackLogTemporaryWorkspace -WorkspaceId $workspace.WorkspaceId } 'Active workspace was removed.'
            $listed = @(Get-TrackLogTemporaryWorkspace | Where-Object { $_.WorkspaceId -eq $workspace.WorkspaceId })
            Assert-True ($listed.Count -eq 1 -and $listed[0].Active) 'List did not report the active lock.'
            $cli = Invoke-Cli @('-Remove', '-WorkspaceId', $workspace.WorkspaceId)
            Assert-True ($cli.ExitCode -ne 0) 'CLI returned success for an active workspace.'
            Assert-True (Test-Path -LiteralPath $workspace.Path) 'Active workspace disappeared.'
        } finally { $lock.Dispose() }
    }

    Invoke-Test 'Child and ancestor junctions are rejected without touching their target' {
        $workspace = New-TestWorkspace 'junction'
        $external = New-TestWorkspace 'sentinel'
        $sentinelPath = Join-Path $external.Path 'must-survive.txt'
        Write-TestText $sentinelPath 'external synthetic sentinel'
        $null = New-Item -ItemType Directory -Path (Join-Path $external.Path 'nested')
        $junctionPath = Join-Path $workspace.Path 'linked-target'
        $null = New-Item -ItemType Junction -Path $junctionPath -Target $external.Path
        try {
            Assert-Rejected { Remove-TrackLogTemporaryWorkspace -WorkspaceId $workspace.WorkspaceId } 'Child junction was followed or accepted for removal.'
            $pathWithJunctionAncestor = Join-Path $junctionPath 'nested'
            Assert-Rejected { & $module { param($target) Assert-OrdinaryPath -Path $target } $pathWithJunctionAncestor } 'Ancestor reparse point was not rejected.'
            Assert-True ([IO.File]::ReadAllText($sentinelPath) -ceq 'external synthetic sentinel') 'Junction target sentinel was changed.'
            Assert-True (Test-Path -LiteralPath $workspace.Path) 'Rejected junction workspace was deleted.'
        } finally { Remove-TestJunction -Path $junctionPath -OwnedParent $workspace.Path }
        Assert-True ([IO.File]::ReadAllText($sentinelPath) -ceq 'external synthetic sentinel') 'Removing the junction entry affected its target.'
    }

    Invoke-Test 'Run success holds its lock and cleans generated read-only files' {
        $result = Invoke-TrackLogTemporaryWorkspace -Name ($testPrefix + '-run-ok') -ScriptPath $successScript -ScriptArguments @($receiptPath)
        $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
        Assert-True $receipt.lockHeld 'Run did not hold an exclusive active lock.'
        Assert-True ($result.Completed -and $result.Removed) 'Run did not report successful cleanup.'
        Assert-True (-not (Test-Path -LiteralPath $receipt.path)) 'Successful Run left its workspace behind.'
    }

    Invoke-Test 'Run exception propagates and still cleans its workspace' {
        Assert-Rejected { Invoke-TrackLogTemporaryWorkspace -Name ($testPrefix + '-run-fail') -ScriptPath $failureScript -ScriptArguments @($receiptPath) } 'Run swallowed the work failure.'
        $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
        Assert-True (-not (Test-Path -LiteralPath $receipt.path)) 'Failed Run left its workspace behind.'
    }

    Invoke-Test 'Run reports both work and cleanup errors and leaves the rejected workspace intact' {
        $message = ''
        try { $null = Invoke-TrackLogTemporaryWorkspace -Name ($testPrefix + '-both-fail') -ScriptPath $cleanupFailureScript -ScriptArguments @($receiptPath) }
        catch { $message = $_.Exception.Message }
        $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
        $id = [IO.Path]::GetFileName($receipt.path)
        $ownedIds.Add($id)
        try {
            Assert-True ($message.Contains('Expected synthetic work and cleanup failure.') -and $message.Contains('Cleanup failed')) 'Run did not retain both failure reasons.'
            Assert-True (Test-Path -LiteralPath $receipt.path) 'A rejected cleanup unexpectedly deleted its workspace.'
        } finally { Write-TestText (Join-Path $receipt.path $markerName) $receipt.marker }
    }

    Invoke-Test 'CLI Create/List/Remove return success and JSON' {
        $cli = Invoke-Cli @('-Create', '-Name', ($testPrefix + '-cli'))
        Assert-True ($cli.ExitCode -eq 0) ('CLI Create failed: ' + $cli.Text)
        $workspace = $cli.Text | ConvertFrom-Json
        $ownedIds.Add($workspace.WorkspaceId)
        $cli = Invoke-Cli @('-List')
        Assert-True ($cli.ExitCode -eq 0) 'CLI List failed.'
        $listed = @($cli.Text | ConvertFrom-Json | Where-Object { $_.WorkspaceId -eq $workspace.WorkspaceId })
        Assert-True ($listed.Count -eq 1) 'CLI List did not contain the generated workspace.'
        $cli = Invoke-Cli @('-Remove', '-WorkspaceId', $workspace.WorkspaceId)
        Assert-True ($cli.ExitCode -eq 0) ('CLI Remove failed: ' + $cli.Text)
        Assert-True (($cli.Text | ConvertFrom-Json).Removed) 'CLI Remove JSON did not report removal.'
        Assert-True (-not (Test-Path -LiteralPath $workspace.Path)) 'CLI Remove left its workspace behind.'
        $cli = Invoke-Cli @('-Remove', '-WorkspaceId', '..\outside')
        Assert-True ($cli.ExitCode -ne 0) 'CLI accepted a traversal ID.'
    }

    Invoke-Test 'CLI Run success and failure exit codes preserve automatic cleanup' {
        foreach ($entry in @(@{ Script = $successScript; Success = $true }, @{ Script = $failureScript; Success = $false }, @{ Script = $exitScript; Success = $false }, @{ Script = $nativeFailureScript; Success = $false })) {
            $cli = Invoke-Cli @('-Run', '-Name', ($testPrefix + '-cli-run'), '-ScriptPath', $entry.Script, '-ScriptArguments', $receiptPath)
            Assert-True (($cli.ExitCode -eq 0) -eq $entry.Success) ('Unexpected CLI Run exit code: ' + $cli.ExitCode + '. ' + $cli.Text)
            $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
            Assert-True (-not (Test-Path -LiteralPath $receipt.path)) 'CLI Run left its workspace behind.'
        }
    }

    Invoke-Test 'CLI Run forwards multiple literal script arguments' {
        $cli = Invoke-Cli @('-Run', '-Name', ($testPrefix + '-cli-args'), '-ScriptPath', $successScript, '-ScriptArguments', $receiptPath, 'two words', 'literal&value')
        Assert-True ($cli.ExitCode -eq 0) ('CLI rejected multiple script arguments: ' + $cli.Text)
        $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
        Assert-True ($receipt.second -ceq 'two words' -and $receipt.third -ceq 'literal&value') 'CLI changed the literal script arguments.'
        Assert-True (-not (Test-Path -LiteralPath $receipt.path)) 'CLI argument test left its workspace behind.'
    }
} catch {
    $failures.Add('Test setup: ' + $_.Exception.Message)
} finally {
    # Cleanup is restricted to IDs created by this test. No existing workspaces or project files are removed.
    foreach ($id in $ownedIds) {
        try {
            $remaining = @(Get-TrackLogTemporaryWorkspace | Where-Object { $_.WorkspaceId -ceq $id })
            if ($remaining.Count -gt 0) { $null = Remove-TrackLogTemporaryWorkspace -WorkspaceId $id }
        } catch { $failures.Add('Generated fixture cleanup failed for ' + $id + ': ' + $_.Exception.Message) }
    }
    $remainingTests = @(Get-TrackLogTemporaryWorkspace | Where-Object { $_.Name.StartsWith($testPrefix, [StringComparison]::Ordinal) })
    foreach ($remaining in $remainingTests) {
        $failures.Add('Generated test workspace remains: ' + $remaining.WorkspaceId)
    }
}

Write-Host ('Temporary workspace tests: ' + $testCount + ' cases, ' + $failures.Count + ' failures. PowerShell ' + $PSVersionTable.PSVersion)
if ($failures.Count -gt 0) {
    foreach ($failure in $failures) { Write-Error $failure -ErrorAction Continue }
    exit 1
}
