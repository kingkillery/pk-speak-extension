param(
    [string]$ConfigPath = $(Join-Path (Split-Path -Parent $PSScriptRoot) ".llm-wiki\config.json"),
    [string[]]$Target,
    [string]$Query,
    [string]$CurateNote,
    [string]$BrvCommand = $env:LLM_WIKI_BRV_COMMAND
)

$ErrorActionPreference = "Stop"
$scriptPath = Join-Path $PSScriptRoot "brv_benchmark.py"
$args = @($scriptPath, "--config-path", $ConfigPath)

if ($BrvCommand) {
    $args += "--brv-command"
    $args += $BrvCommand
}

foreach ($item in $Target) {
    $args += "--target"
    $args += $item
}

if ($Query) {
    $args += "--query"
    $args += $Query
}

if ($CurateNote) {
    $args += "--curate-note"
    $args += $CurateNote
}

python @args
