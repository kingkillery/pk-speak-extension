param(
    [Parameter(Mandatory = $true)]
    [string]$ScriptPath,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ScriptArgs
)

$ErrorActionPreference = "Stop"

function Get-GitBashPath {
    $candidates = @(
        "C:\Program Files\Git\bin\bash.exe",
        "C:\Program Files\Git\usr\bin\bash.exe"
    )

    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            return $candidate
        }
    }

    throw "Git Bash not found. Install Git for Windows or use the native .ps1 helper instead."
}

function Convert-ToGitBashPath {
    param([string]$Value)

    if (-not $Value) {
        return $Value
    }

    if ($Value -match '^[A-Za-z]:\\') {
        $drive = $Value.Substring(0, 1).ToLowerInvariant()
        $rest = $Value.Substring(2).Replace('\', '/')
        return "/$drive$rest"
    }

    return $Value
}

function Get-PythonForGitBash {
    $python = Get-Command python -ErrorAction SilentlyContinue
    if (-not $python) {
        return $null
    }
    return Convert-ToGitBashPath -Value $python.Source
}

$bash = Get-GitBashPath
$resolvedScript = (Resolve-Path $ScriptPath).Path
$translatedScript = Convert-ToGitBashPath -Value $resolvedScript
$translatedArgs = @()

foreach ($arg in $ScriptArgs) {
    if ($arg -and ($arg -match '^[A-Za-z]:\\' -or (Test-Path $arg))) {
        try {
            $resolved = if (Test-Path $arg) { (Resolve-Path $arg).Path } else { $arg }
            $translatedArgs += (Convert-ToGitBashPath -Value $resolved)
        } catch {
            $translatedArgs += $arg
        }
    } else {
        $translatedArgs += $arg
    }
}

if (-not $env:PYTHON_BIN) {
    $gitBashPython = Get-PythonForGitBash
    if ($gitBashPython) {
        $env:PYTHON_BIN = $gitBashPython
    }
}

& $bash $translatedScript @translatedArgs
exit $LASTEXITCODE
