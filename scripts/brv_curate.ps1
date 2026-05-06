param(
    [string]$ConfigPath = $(Join-Path (Split-Path -Parent $PSScriptRoot) ".llm-wiki\config.json"),
    [Parameter(Mandatory = $true)]
    [string]$Content,
    [string]$BrvCommand = $env:LLM_WIKI_BRV_COMMAND,
    [string]$Provider,
    [string]$Model
)

$ErrorActionPreference = "Stop"

if (Test-Path $ConfigPath) {
    $config = Get-Content -Path $ConfigPath -Raw | ConvertFrom-Json
    if (-not $BrvCommand) { $BrvCommand = $config.byterover.command }
    if (-not $Provider) { $Provider = $config.byterover.curate_preferred_provider ?? $config.byterover.default_provider }
    if (-not $Model) { $Model = $config.byterover.curate_preferred_model ?? $config.byterover.default_model }
}

if (-not $BrvCommand) {
    throw "BRV command is not configured."
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
    & $BrvCommand curate $Content --format json
} finally {
    Pop-Location
}
