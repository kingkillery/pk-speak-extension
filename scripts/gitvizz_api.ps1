param(
    [string]$ConfigPath = $(Join-Path (Split-Path -Parent $PSScriptRoot) ".llm-wiki\config.json"),
    [string]$Path = "/openapi.json",
    [ValidateSet("GET", "POST", "PUT", "PATCH", "DELETE")]
    [string]$Method = "GET",
    [string]$BaseUrl = $env:LLM_WIKI_GITVIZZ_BACKEND_URL,
    [string]$JsonBody,
    [string[]]$FormField,
    [string]$Authorization,
    [switch]$UseApiBase
)

$ErrorActionPreference = "Stop"

if (-not $BaseUrl -and (Test-Path $ConfigPath)) {
    $config = Get-Content -Path $ConfigPath -Raw | ConvertFrom-Json
    $BaseUrl = if ($UseApiBase -and $config.gitvizz.api_base_url) { $config.gitvizz.api_base_url } else { $config.gitvizz.backend_url }
}

if (-not $BaseUrl) {
    throw "GitVizz backend URL is not configured."
}

$normalizedBase = $BaseUrl.TrimEnd("/")
$normalizedPath = if ($Path.StartsWith("/")) { $Path } else { "/$Path" }
$uri = "$normalizedBase$normalizedPath"
$headers = @{}

if ($Authorization) {
    $headers["Authorization"] = $Authorization
}

if ($JsonBody) {
    $headers["Content-Type"] = "application/json"
    Invoke-RestMethod -Uri $uri -Method $Method -Headers $headers -Body $JsonBody | ConvertTo-Json -Depth 100
    exit 0
}

if ($FormField) {
    $form = @{}
    foreach ($entry in $FormField) {
        $parts = $entry -split "=", 2
        if ($parts.Count -ne 2) {
            throw "FormField entries must use key=value format."
        }
        $form[$parts[0]] = $parts[1]
    }
    Invoke-RestMethod -Uri $uri -Method $Method -Headers $headers -Form $form | ConvertTo-Json -Depth 100
    exit 0
}

Invoke-RestMethod -Uri $uri -Method $Method -Headers $headers | ConvertTo-Json -Depth 100
