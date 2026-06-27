<#
.SYNOPSIS
  Keep the Pi Speak headless gateway running (auto-restart / keep-alive).

.DESCRIPTION
  Launched by the "PiSpeakGateway" scheduled task (see gateway-autostart.ps1), this
  supervisor starts `node dist/headless-gateway.js` and relaunches it if it exits, with
  exponential backoff capped at -MaxBackoffSeconds. The backoff resets after the gateway
  has stayed up for -HealthyResetSeconds. If a *foreign* gateway is already serving the
  port (e.g. one started manually), the supervisor monitors instead of double-binding.

  Runs in the current user's session so the gateway inherits the user PATH, Tailscale
  auth, and the omp/codex/claude/pi CLIs and their profiles.

  Logs: %LOCALAPPDATA%\pi-speak\logs\gateway-supervisor.log (+ gateway-out/err.log)
#>
[CmdletBinding()]
param(
  [int]$Port = 8767,
  [int]$BackoffSeconds = 3,
  [int]$MaxBackoffSeconds = 30,
  [int]$HealthyResetSeconds = 60
)

$ErrorActionPreference = 'Stop'
# scripts/ -> repo root
$repo = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $repo 'dist\headless-gateway.js'

$logDir = Join-Path $env:LOCALAPPDATA 'pi-speak\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'gateway-supervisor.log'
$outLog = Join-Path $logDir 'gateway-out.log'
$errLog = Join-Path $logDir 'gateway-err.log'

function Write-Log([string]$msg) {
  $line = '{0} {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $msg
  try { Add-Content -Path $log -Value $line -Encoding utf8 } catch {}
}

function Test-GatewayHealthy {
  try {
    $r = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/health" -f $Port) -TimeoutSec 3
    return ($r.app -eq 'pi-speak')
  } catch { return $false }
}

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'node' }

if (-not (Test-Path $entry)) {
  Write-Log "FATAL: gateway entry not found: $entry (run 'npm run build' in $repo)"
  exit 1
}

Write-Log ("Supervisor starting. repo={0} node={1} port={2}" -f $repo, $node, $Port)
$backoff = $BackoffSeconds

while ($true) {
  if (Test-GatewayHealthy) {
    # Another gateway is already serving the port (manual run or prior instance).
    # Don't double-bind; monitor and only take over once it's gone.
    Start-Sleep -Seconds 10
    continue
  }

  Write-Log ("Starting gateway: {0} dist/headless-gateway.js" -f $node)
  $startedAt = Get-Date
  try {
    $proc = Start-Process -FilePath $node -ArgumentList 'dist/headless-gateway.js' `
      -WorkingDirectory $repo -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  } catch {
    Write-Log ("Start failed: {0}" -f $_.Exception.Message)
    Start-Sleep -Seconds $backoff
    $backoff = [Math]::Min($backoff * 2, $MaxBackoffSeconds)
    continue
  }

  Write-Log ("Gateway PID {0} started" -f $proc.Id)
  $proc.WaitForExit()
  $ranSeconds = ((Get-Date) - $startedAt).TotalSeconds
  Write-Log ("Gateway PID {0} exited (code={1}) after {2:N0}s" -f $proc.Id, $proc.ExitCode, $ranSeconds)

  if ($ranSeconds -ge $HealthyResetSeconds) {
    $backoff = $BackoffSeconds  # ran fine for a while; recover quickly from a one-off crash
  }
  Start-Sleep -Seconds $backoff
  $backoff = [Math]::Min($backoff * 2, $MaxBackoffSeconds)
}
