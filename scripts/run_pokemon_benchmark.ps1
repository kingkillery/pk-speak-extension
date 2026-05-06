param(
    [ValidateSet("smoke", "framework")]
    [string]$Mode = "framework",

    [ValidateSet("claude", "codex", "droid", "pi")]
    [string]$Agent = "codex",

    [string]$GymRepo = "C:\dev\Desktop-Benchmarks\Gym-Anything\gym-anything",

    [string]$EnvDir = "C:\dev\Desktop-Benchmarks\Gym-Anything\gym-anything\benchmarks\cua_world\environments\pokemon_agent_env",

    [string]$TaskJson = "C:\dev\Desktop-Benchmarks\Gym-Anything\gym-anything\benchmarks\cua_world\environments\pokemon_agent_env\tasks\start_server_capture_state\task.json",

    [string]$OutputRoot = "",

    [int]$Seed = 42,

    [int]$TimeoutSec = 1800,

    [switch]$KeepSession
)

$ErrorActionPreference = "Stop"

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    $python = Get-Command py -ErrorAction SilentlyContinue
}
if (-not $python) {
    throw "Python is required to run run_pokemon_benchmark.ps1"
}

$scriptPath = Join-Path $PSScriptRoot "pokemon_benchmark_adapter.py"
if (-not (Test-Path $scriptPath)) {
    throw "Missing Pokemon benchmark adapter: $scriptPath"
}

$invokeArgs = @(
    $scriptPath,
    $Mode,
    "--gym-repo",
    $GymRepo,
    "--env-dir",
    $EnvDir,
    "--task-json",
    $TaskJson,
    "--seed",
    "$Seed"
)

if ($OutputRoot) {
    $invokeArgs += @("--output-root", $OutputRoot)
}
if ($KeepSession) {
    $invokeArgs += "--keep-session"
}
if ($Mode -eq "framework") {
    $invokeArgs += @("--agent", $Agent, "--timeout-sec", "$TimeoutSec")
}

if ($python.Name -eq "py") {
    & py -3 @invokeArgs
} else {
    & $python.Name @invokeArgs
}

exit $LASTEXITCODE
