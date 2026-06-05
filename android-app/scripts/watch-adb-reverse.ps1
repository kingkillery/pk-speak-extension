param(
    [int]$Port = 8767,
    [int]$PollSeconds = 3,
    [switch]$RunVerification,
    [switch]$RestartGateway,
    [switch]$ManualUsbCycle,
    [switch]$Once
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

function Get-AttachedDevice {
    $devices = @(& $adb devices | Select-Object -Skip 1 | Where-Object { $_ -match '\tdevice$' })
    if (-not $devices) {
        return $null
    }
    return (($devices[0] -split '\s+')[0])
}

function Get-AdbDeviceStatusSummary {
    $lines = & $adb devices | Select-Object -Skip 1 | Where-Object { $_.Trim() }
    if (-not $lines) {
        return "No attached Android device or running emulator found."
    }

    $summaries = $lines | ForEach-Object {
        $parts = $_ -split '\s+'
        if ($parts.Count -ge 2) {
            "$($parts[0]) is $($parts[1])"
        } else {
            $_
        }
    }
    return "No ready Android device found. ADB reported: $($summaries -join '; ')."
}

function Ensure-Reverse {
    param([string]$DeviceId)
    & $adb -s $DeviceId reverse "tcp:$Port" "tcp:$Port" | Out-Null
    $reverseList = & $adb -s $DeviceId reverse --list
    if ($reverseList -notmatch "tcp:$Port\s+tcp:$Port") {
        throw "Failed to configure adb reverse tcp:$Port tcp:$Port for $DeviceId."
    }
}

Write-Host "Using ADB: $adb"
Write-Host "Watching for Android device and adb reverse tcp:$Port tcp:$Port. Press Ctrl+C to stop."
$lastDevice = $null

while ($true) {
    $device = Get-AttachedDevice
    if (-not $device) {
        if ($lastDevice) {
            Write-Host "Device disconnected: $lastDevice"
            $lastDevice = $null
        }
        if ($Once) {
            throw (Get-AdbDeviceStatusSummary)
        }
        Start-Sleep -Seconds $PollSeconds
        continue
    }

    if ($device -ne $lastDevice) {
        Write-Host "Device connected: $device"
        Ensure-Reverse -DeviceId $device
        Write-Host "ADB reverse configured for $device."
        $lastDevice = $device

        if ($RunVerification) {
            $verifyArgs = @(
                '-NoProfile',
                '-ExecutionPolicy', 'Bypass',
                '-File', (Join-Path $PSScriptRoot 'verify-connection-recovery.ps1'),
                '-Port', "$Port",
                '-DeviceId', "$device"
            )
            if ($RestartGateway) {
                $verifyArgs += '-RestartGateway'
            }
            if ($ManualUsbCycle) {
                $verifyArgs += '-ManualUsbCycle'
            }
            & powershell @verifyArgs
        }
    } else {
        try {
            Ensure-Reverse -DeviceId $device
        } catch {
            Write-Host $_.Exception.Message
        }
    }

    if ($Once) {
        break
    }

    Start-Sleep -Seconds $PollSeconds
}
