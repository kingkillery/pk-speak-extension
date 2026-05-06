param(
    [string]$ConfigPath = $(Join-Path (Split-Path -Parent $PSScriptRoot) ".llm-wiki\config.json"),
    [Parameter(Mandatory = $true)]
    [string]$Query,
    [string]$BrvCommand = $env:LLM_WIKI_BRV_COMMAND,
    [string]$Provider,
    [string]$Model,
    [switch]$UseQueryExperiment,
    [switch]$Json
)

$ErrorActionPreference = "Stop"

if (Test-Path $ConfigPath) {
    $config = Get-Content -Path $ConfigPath -Raw | ConvertFrom-Json
    if (-not $BrvCommand) { $BrvCommand = $config.byterover.command }
    if ($UseQueryExperiment) {
        if (-not $Provider) { $Provider = $config.byterover.query_experiment_provider }
        if (-not $Model) { $Model = $config.byterover.query_experiment_model }
    } else {
        if (-not $Provider) { $Provider = $config.byterover.default_provider }
        if (-not $Model) { $Model = $config.byterover.default_model }
    }
}

if (-not $BrvCommand) {
    throw "BRV command is not configured."
}

$args = @("query", $Query)
if ($Json -or $true) {
    $args += "--format"
    $args += "json"
}

Push-Location (Split-Path -Parent $ConfigPath)
try {
    if ($Model) {
        $switchArgs = @("model", "switch", $Model, "--format", "json")
        if ($Provider) {
            $switchArgs += "--provider"
            $switchArgs += $Provider
        }
        & $BrvCommand @switchArgs | Out-Null
    }
    & $BrvCommand @args
} finally {
    Pop-Location
}
