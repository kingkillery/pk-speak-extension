param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ArgsToPass
)

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "llm_wiki_skills.py"
if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Missing llm-wiki skills CLI script: $scriptPath"
}

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    $python = Get-Command py -ErrorAction SilentlyContinue
}
if (-not $python) {
    throw "Python is required to run llm_wiki_skills.ps1"
}

if ($python.Name -eq "py") {
    & py -3 $scriptPath @ArgsToPass
} else {
    & $python.Source $scriptPath @ArgsToPass
}

exit $LASTEXITCODE
