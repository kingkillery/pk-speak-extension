param(
    [int]$Port = 8767,
    [string]$PackageName = 'com.example',
    [string]$ActivityName = 'com.example.MainActivity',
    [string]$DeviceId,
    [int]$TimeoutSeconds = 25,
    [switch]$RestartGateway,
    [switch]$ManualUsbCycle,
    [string]$GatewayStartCommand = 'node dist/headless-gateway.js'
)

$ErrorActionPreference = 'Stop'

function Resolve-Adb {
    $sdkRoot = $env:ANDROID_HOME
    if (-not $sdkRoot) {
        $sdkRoot = $env:ANDROID_SDK_ROOT
    }
    if (-not $sdkRoot) {
        $sdkRoot = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
    }

    $sdkAdb = Join-Path $sdkRoot 'platform-tools\adb.exe'
    if (Test-Path $sdkAdb) {
        return $sdkAdb
    }
    return 'adb'
}

$adb = Resolve-Adb
Write-Host "Using ADB: $adb"

function Get-DeviceId {
    param([string]$PreferredDeviceId)

    $adbDeviceLines = & $adb devices | Select-Object -Skip 1 | Where-Object { $_.Trim() }
    $devices = $adbDeviceLines | Where-Object { $_ -match '\tdevice$' }
    if (-not $devices) {
        if (-not $adbDeviceLines) {
            throw "No attached Android device or running emulator found. Connect a device with USB debugging enabled and rerun this script."
        }

        $summaries = $adbDeviceLines | ForEach-Object {
            $parts = $_ -split '\s+'
            if ($parts.Count -ge 2) {
                "$($parts[0]) is $($parts[1])"
            } else {
                $_
            }
        }
        throw "No ready Android device found. ADB reported: $($summaries -join '; '). Accept the USB debugging prompt or reconnect the device and rerun this script."
    }

    if ($PreferredDeviceId) {
        $matchingDevice = $devices | Where-Object { $_ -match "^$([regex]::Escape($PreferredDeviceId))\s+device$" } | Select-Object -First 1
        if (-not $matchingDevice) {
            throw "Requested Android device '$PreferredDeviceId' is not attached or authorized."
        }
        return (($matchingDevice -split '\s+')[0])
    }

    return (($devices[0] -split '\s+')[0])
}

function Get-AttachedDeviceId {
    $devices = & $adb devices | Select-Object -Skip 1 | Where-Object { $_ -match '\tdevice$' }
    if (-not $devices) {
        return $null
    }
    return (($devices[0] -split '\s+')[0])
}

function Get-AttachedDeviceIds {
    $devices = & $adb devices | Select-Object -Skip 1 | Where-Object { $_ -match '\tdevice$' }
    if (-not $devices) {
        return @()
    }
    return @($devices | ForEach-Object { ($_ -split '\s+')[0] })
}

function Wait-ForNoDevice {
    param(
        [int]$TimeoutSeconds,
        [string]$PreferredDeviceId
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $devices = Get-AttachedDeviceIds
        if ($PreferredDeviceId) {
            if ($devices -notcontains $PreferredDeviceId) {
                return $true
            }
        } elseif ($devices.Count -eq 0) {
            return $true
        }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Wait-ForDevice {
    param(
        [int]$TimeoutSeconds,
        [string]$PreferredDeviceId
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $devices = Get-AttachedDeviceIds
        if ($PreferredDeviceId) {
            if ($devices -contains $PreferredDeviceId) {
                return $PreferredDeviceId
            }
        } elseif ($devices.Count -gt 0) {
            return $devices[0]
        }
        Start-Sleep -Seconds 1
    }
    return $null
}

function Wait-ForLogState {
    param(
        [string]$DeviceId,
        [string]$Expected,
        [int]$TimeoutSeconds
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $logs = & $adb -s $DeviceId logcat -d -s 'PiSpeakConnection:D' '*:S'
        if ($logs -match [regex]::Escape("Gateway connection state: $Expected")) {
            return $true
        }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Get-GatewayProcessId {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $conn) {
        return $null
    }
    return $conn.OwningProcess
}

function Start-GatewayProcess {
    Write-Host "Starting gateway with: $GatewayStartCommand"
    $process = Start-Process powershell `
        -ArgumentList @('-NoProfile', '-Command', $GatewayStartCommand) `
        -WorkingDirectory (Resolve-Path (Join-Path $PSScriptRoot '..\..')) `
        -WindowStyle Hidden `
        -PassThru
    Start-Sleep -Seconds 3
    return $process
}

$deviceId = Get-DeviceId -PreferredDeviceId $DeviceId
if ($ManualUsbCycle -and -not $DeviceId -and $deviceId -like 'emulator-*') {
    $physicalDeviceId = Get-AttachedDeviceIds | Where-Object { $_ -notlike 'emulator-*' } | Select-Object -First 1
    if ($physicalDeviceId) {
        $deviceId = $physicalDeviceId
    }
}
$selectedDeviceId = $deviceId
Write-Host "Using Android device: $deviceId"
if ($ManualUsbCycle -and $deviceId -like 'emulator-*') {
    throw "-ManualUsbCycle requires a physical Android phone. Use an emulator only for reverse-loss and server-restart app verification."
}

Push-Location (Join-Path $PSScriptRoot '..')
try {
    .\gradlew.bat assembleDebug
} finally {
    Pop-Location
}

$apkPath = Resolve-Path (Join-Path $PSScriptRoot '..\app\build\outputs\apk\debug\app-debug.apk')
& $adb -s $deviceId install -r $apkPath | Out-Null

& $adb -s $deviceId reverse "tcp:$Port" "tcp:$Port" | Out-Null
& $adb -s $deviceId logcat -c
& $adb -s $deviceId shell am force-stop $PackageName | Out-Null
& $adb -s $deviceId shell am start -n "$PackageName/$ActivityName" | Out-Null

if (-not (Wait-ForLogState -DeviceId $deviceId -Expected 'Connected' -TimeoutSeconds $TimeoutSeconds)) {
    throw "App did not report Connected within $TimeoutSeconds seconds after adb reverse setup."
}
Write-Host "Connected state verified."

Write-Host "Simulating USB reverse loss with adb reverse --remove..."
& $adb -s $deviceId logcat -c
& $adb -s $deviceId reverse --remove "tcp:$Port" | Out-Null
if (-not (Wait-ForLogState -DeviceId $deviceId -Expected 'Gateway unreachable' -TimeoutSeconds ($TimeoutSeconds + 10))) {
    throw "App did not report Gateway unreachable after reverse removal."
}
Write-Host "Unreachable state after reverse loss verified."

Write-Host "Restoring adb reverse..."
& $adb -s $deviceId logcat -c
& $adb -s $deviceId reverse "tcp:$Port" "tcp:$Port" | Out-Null
if (-not (Wait-ForLogState -DeviceId $deviceId -Expected 'Connected' -TimeoutSeconds $TimeoutSeconds)) {
    throw "App did not report Connected after reverse restoration."
}
Write-Host "Reconnect after reverse restoration verified."

if ($ManualUsbCycle) {
    Write-Host "Manual USB cycle verification requested."
    & $adb -s $deviceId logcat -c
    Read-Host "Unplug the USB cable from the Android device, then press Enter"
    if (-not (Wait-ForNoDevice -TimeoutSeconds $TimeoutSeconds -PreferredDeviceId $selectedDeviceId)) {
        throw "ADB still reports an attached Android device after USB unplug prompt."
    }
    Write-Host "ADB device disconnect verified."
    Write-Host "Waiting 10 seconds while unplugged so the app heartbeat can observe the lost gateway..."
    Start-Sleep -Seconds 10

    Read-Host "Re-plug the USB cable, accept any USB debugging prompt, then press Enter"
    $deviceId = Wait-ForDevice -TimeoutSeconds ($TimeoutSeconds + 30) -PreferredDeviceId $selectedDeviceId
    if (-not $deviceId) {
        throw "ADB did not report an attached Android device after USB re-plug."
    }
    Write-Host "ADB device reconnect verified: $deviceId"

    if (-not (Wait-ForLogState -DeviceId $deviceId -Expected 'Gateway unreachable' -TimeoutSeconds ($TimeoutSeconds + 10))) {
        throw "App did not report Gateway unreachable during the physical USB cycle."
    }
    Write-Host "Unreachable state during physical USB cycle verified."

    & $adb -s $deviceId logcat -c
    & $adb -s $deviceId reverse "tcp:$Port" "tcp:$Port" | Out-Null
    if (-not (Wait-ForLogState -DeviceId $deviceId -Expected 'Connected' -TimeoutSeconds $TimeoutSeconds)) {
        throw "App did not report Connected after physical USB re-plug and reverse restoration."
    }
    Write-Host "Reconnect after physical USB cycle verified."
}

if ($RestartGateway) {
    $gatewayPid = Get-GatewayProcessId
    if (-not $gatewayPid) {
        throw "No gateway process is listening on port $Port; cannot run restart verification."
    }

    Write-Host "Stopping gateway process $gatewayPid to verify server restart recovery..."
    & $adb -s $deviceId logcat -c
    Stop-Process -Id $gatewayPid -Force
    if (-not (Wait-ForLogState -DeviceId $deviceId -Expected 'Gateway unreachable' -TimeoutSeconds ($TimeoutSeconds + 10))) {
        throw "App did not report Gateway unreachable after gateway stop."
    }
    Write-Host "Unreachable state after gateway stop verified."

    & $adb -s $deviceId logcat -c
    $startedGateway = Start-GatewayProcess
    try {
        if (-not (Wait-ForLogState -DeviceId $deviceId -Expected 'Connected' -TimeoutSeconds $TimeoutSeconds)) {
            throw "App did not report Connected after gateway restart."
        }
        Write-Host "Reconnect after gateway restart verified."
    } finally {
        if ($startedGateway -and -not $startedGateway.HasExited) {
            Write-Host "Leaving restarted gateway process running: $($startedGateway.Id)"
        }
    }
} else {
    Write-Host "Server restart verification not requested."
    Write-Host "To automate it, rerun with -RestartGateway after confirming the gateway can be safely stopped and restarted:"
    Write-Host "powershell -NoProfile -ExecutionPolicy Bypass -File .\android-app\scripts\verify-connection-recovery.ps1 -RestartGateway -ManualUsbCycle"
}
