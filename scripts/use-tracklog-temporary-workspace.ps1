[CmdletBinding(DefaultParameterSetName = 'List')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Create')][switch]$Create,
    [Parameter(ParameterSetName = 'List')][switch]$List,
    [Parameter(Mandatory = $true, ParameterSetName = 'Remove')][switch]$Remove,
    [Parameter(Mandatory = $true, ParameterSetName = 'Run')][switch]$Run,
    [Parameter(Mandatory = $true, ParameterSetName = 'Create')]
    [Parameter(Mandatory = $true, ParameterSetName = 'Run')][string]$Name,
    [Parameter(Mandatory = $true, ParameterSetName = 'Remove')][string]$WorkspaceId,
    [Parameter(Mandatory = $true, ParameterSetName = 'Run')][string]$ScriptPath,
    [Parameter(ParameterSetName = 'Run')][string[]]$ScriptArguments = @(),
    [Parameter(ParameterSetName = 'Run', ValueFromRemainingArguments = $true, DontShow = $true)]
    [string[]]$RemainingScriptArguments = @()
)

$ErrorActionPreference = 'Stop'
try {
    Import-Module (Join-Path $PSScriptRoot 'TrackLogTemporaryWorkspace.psm1') -Force
    switch ($PSCmdlet.ParameterSetName) {
        'Create' { New-TrackLogTemporaryWorkspace -Name $Name | ConvertTo-Json -Depth 4 }
        'List' { ConvertTo-Json -InputObject @(Get-TrackLogTemporaryWorkspace) -Depth 4 }
        'Remove' { Remove-TrackLogTemporaryWorkspace -WorkspaceId $WorkspaceId | ConvertTo-Json -Depth 4 }
        'Run' {
            $arguments = @($ScriptArguments) + @($RemainingScriptArguments)
            Invoke-TrackLogTemporaryWorkspace -Name $Name -ScriptPath $ScriptPath -ScriptArguments $arguments | ConvertTo-Json -Depth 4
        }
    }
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
