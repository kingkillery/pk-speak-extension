param(
    [string]$ConfigPath = $(Join-Path (Split-Path -Parent $PSScriptRoot) ".llm-wiki\config.json"),
    [string]$RepoPath = $env:LLM_WIKI_GITVIZZ_REPO_PATH,
    [switch]$Rebuild
)

$ErrorActionPreference = "Stop"

if (-not $RepoPath -and (Test-Path $ConfigPath)) {
    $config = Get-Content -Path $ConfigPath -Raw | ConvertFrom-Json
    $RepoPath = $config.gitvizz.repo_path
}

if (-not $RepoPath) {
    throw "GitVizz repo path is not configured."
}

if (-not (Test-Path (Join-Path $RepoPath "docker-compose.yaml"))) {
    throw "docker-compose.yaml not found under $RepoPath"
}

Push-Location $RepoPath
try {
    if ($Rebuild) {
        & docker-compose up -d --build
    } else {
        & docker-compose up -d
    }
} finally {
    Pop-Location
}
