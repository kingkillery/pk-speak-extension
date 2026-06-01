param(
    [string]$AvdName = 'pi-speak-api35',
    [string]$Package = 'system-images;android-35;google_apis;x86_64',
    [string]$Device = 'pixel_6'
)

$ErrorActionPreference = 'Stop'

$sdkRoot = $env:ANDROID_HOME
if (-not $sdkRoot) {
    $sdkRoot = $env:ANDROID_SDK_ROOT
}
if (-not $sdkRoot) {
    $localProperties = Join-Path $PSScriptRoot '..\local.properties'
    if (Test-Path $localProperties) {
        $sdkLine = Get-Content $localProperties | Where-Object { $_ -like 'sdk.dir=*' } | Select-Object -First 1
        if ($sdkLine) {
            $sdkRoot = ($sdkLine -replace '^sdk\.dir=', '') -replace '\\:', ':' -replace '\\\\', '\'
        }
    }
}
if (-not $sdkRoot) {
    $sdkRoot = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
}

$sdkManager = Join-Path $sdkRoot 'cmdline-tools\latest\bin\sdkmanager.bat'
$avdManager = Join-Path $sdkRoot 'cmdline-tools\latest\bin\avdmanager.bat'
$emulator = Join-Path $sdkRoot 'emulator\emulator.exe'

if (-not (Test-Path $sdkManager)) {
    throw "sdkmanager was not found at $sdkManager."
}
if (-not (Test-Path $avdManager)) {
    throw "avdmanager was not found at $avdManager."
}

Write-Host "Installing Android emulator package and system image if missing..."
& $sdkManager 'emulator' $Package

if (-not (Test-Path $emulator)) {
    throw "Android emulator package did not install emulator.exe at $emulator."
}

$existingAvds = & $avdManager list avd
if ($existingAvds -match [regex]::Escape("Name: $AvdName")) {
    Write-Host "AVD already exists: $AvdName"
} else {
    Write-Host "Creating AVD: $AvdName"
    'no' | & $avdManager create avd --name $AvdName --package $Package --device $Device --force
}

Write-Host "Starting emulator: $AvdName"
Start-Process -FilePath $emulator -ArgumentList @('-avd', $AvdName, '-no-snapshot-load') -WindowStyle Hidden
Write-Host "After the emulator boots, run:"
Write-Host "powershell -NoProfile -ExecutionPolicy Bypass -File .\android-app\scripts\watch-adb-reverse.ps1 -RunVerification -RestartGateway"
Write-Host "A physical phone is still required for the -ManualUsbCycle unplug/replug acceptance check."
