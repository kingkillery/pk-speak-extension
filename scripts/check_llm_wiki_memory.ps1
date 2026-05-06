param(
    [string]$WorkspaceRoot = "",
    [string]$ConfigPath = "",
    [string]$QmdSource = "",
    [string]$QmdRepoUrl = "",
    [string]$QmdCommand = "",
    [string]$QmdCollection = "",
    [string]$QmdContext = "",
    [string]$BrvCommand = "",
    [string]$GitvizzFrontendUrl = "",
    [string]$GitvizzBackendUrl = "",
    [string]$GitvizzRepoUrl = "",
    [string]$GitvizzCheckoutPath = "",
    [string]$GitvizzRepoPath = "",
    [switch]$SkipQmd,
    [switch]$SkipMcp,
    [switch]$SkipQmdBootstrap,
    [switch]$SkipQmdEmbed,
    [switch]$SkipBrv,
    [switch]$SkipBrvInit,
    [switch]$SkipGitvizz,
    [switch]$SkipGitvizzStart,
    [switch]$AllowGlobalToolInstall,
    [switch]$VerifyOnly,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
)

$ErrorActionPreference = "Stop"

function Add-OptionalArgument {
    param(
        [System.Collections.Generic.List[string]]$Target,
        [string]$Flag,
        [string]$Value
    )

    if (-not [string]::IsNullOrWhiteSpace($Value)) {
        $Target.Add($Flag)
        $Target.Add($Value)
    }
}

function Add-SwitchArgument {
    param(
        [System.Collections.Generic.List[string]]$Target,
        [string]$Flag,
        [bool]$Enabled
    )

    if ($Enabled) {
        $Target.Add($Flag)
    }
}

$runtimeScript = Join-Path $PSScriptRoot "llm_wiki_memory_runtime.py"
if (-not (Test-Path $runtimeScript)) {
    throw "Missing shared runtime: $runtimeScript"
}

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    $python = Get-Command py -ErrorAction SilentlyContinue
}
if (-not $python) {
    throw "Python is required to run check_llm_wiki_memory.ps1"
}

$runtimeArgs = New-Object 'System.Collections.Generic.List[string]'
Add-OptionalArgument $runtimeArgs "--workspace" $WorkspaceRoot
Add-OptionalArgument $runtimeArgs "--config-path" $ConfigPath
Add-OptionalArgument $runtimeArgs "--qmd-source" $QmdSource
Add-OptionalArgument $runtimeArgs "--qmd-repo-url" $QmdRepoUrl
Add-OptionalArgument $runtimeArgs "--qmd-command" $QmdCommand
Add-OptionalArgument $runtimeArgs "--qmd-collection" $QmdCollection
Add-OptionalArgument $runtimeArgs "--qmd-context" $QmdContext
Add-OptionalArgument $runtimeArgs "--brv-command" $BrvCommand
Add-OptionalArgument $runtimeArgs "--gitvizz-frontend-url" $GitvizzFrontendUrl
Add-OptionalArgument $runtimeArgs "--gitvizz-backend-url" $GitvizzBackendUrl
Add-OptionalArgument $runtimeArgs "--gitvizz-repo-url" $GitvizzRepoUrl
Add-OptionalArgument $runtimeArgs "--gitvizz-checkout-path" $GitvizzCheckoutPath
Add-OptionalArgument $runtimeArgs "--gitvizz-repo-path" $GitvizzRepoPath
Add-SwitchArgument $runtimeArgs "--skip-qmd" $SkipQmd.IsPresent
Add-SwitchArgument $runtimeArgs "--skip-mcp" $SkipMcp.IsPresent
Add-SwitchArgument $runtimeArgs "--skip-qmd-bootstrap" $SkipQmdBootstrap.IsPresent
Add-SwitchArgument $runtimeArgs "--skip-qmd-embed" $SkipQmdEmbed.IsPresent
Add-SwitchArgument $runtimeArgs "--skip-brv" $SkipBrv.IsPresent
Add-SwitchArgument $runtimeArgs "--skip-brv-init" $SkipBrvInit.IsPresent
Add-SwitchArgument $runtimeArgs "--skip-gitvizz" $SkipGitvizz.IsPresent
Add-SwitchArgument $runtimeArgs "--skip-gitvizz-start" $SkipGitvizzStart.IsPresent
Add-SwitchArgument $runtimeArgs "--allow-global-tool-install" $AllowGlobalToolInstall.IsPresent
Add-SwitchArgument $runtimeArgs "--verify-only" $VerifyOnly.IsPresent
if ($Arguments) {
    $runtimeArgs.AddRange([string[]]$Arguments)
}

if ($python.Name -eq "py") {
    & py -3 $runtimeScript check @runtimeArgs
} else {
    & $python.Name $runtimeScript check @runtimeArgs
}

exit $LASTEXITCODE
