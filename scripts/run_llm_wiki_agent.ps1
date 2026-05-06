param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("claude", "codex", "droid", "pi")]
    [string]$Agent,

    [ValidateSet("auto", "interactive", "noninteractive")]
    [string]$Mode = "auto",

    [string]$Workspace = "",

    [string]$ArgumentJson = "",

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
)

$ErrorActionPreference = "Stop"

# Resolve the default workspace after binding because $PSScriptRoot is not reliable
# inside parameter default expressions when the script is launched via -File.
if (-not $Workspace) {
    $Workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

$wrapperScript = Join-Path $PSScriptRoot "llm_wiki_agent_failure_capture.py"
if (-not (Test-Path $wrapperScript)) {
    throw "Missing agent failure wrapper: $wrapperScript"
}

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    $python = Get-Command py -ErrorAction SilentlyContinue
}
if (-not $python) {
    throw "Python is required to run run_llm_wiki_agent.ps1"
}

$invokeArgs = @($wrapperScript, "--workspace", $Workspace, "--agent", $Agent, "--mode", $Mode, "--")
if ($ArgumentJson) {
    $decodedArgs = ConvertFrom-Json -InputObject $ArgumentJson
    if ($decodedArgs -is [System.Collections.IEnumerable] -and -not ($decodedArgs -is [string])) {
        $invokeArgs += @($decodedArgs | ForEach-Object { [string]$_ })
    } elseif ($null -ne $decodedArgs) {
        $invokeArgs += [string]$decodedArgs
    }
} else {
    $invokeArgs += $Arguments
}

if ($python.Name -eq "py") {
    & py -3 @invokeArgs
} else {
    & $python.Name @invokeArgs
}

exit $LASTEXITCODE
