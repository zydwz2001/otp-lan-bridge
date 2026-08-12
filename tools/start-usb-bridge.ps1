param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 41837,
    [string]$DeviceSerial = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$adbCandidates = @(
    (Join-Path $projectRoot ".tooling\android-sdk\platform-tools\adb.exe"),
    (Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe")
)
$adbPath = $adbCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $adbPath) {
    $adbCommand = Get-Command adb -ErrorAction SilentlyContinue
    if ($adbCommand) { $adbPath = $adbCommand.Source }
}
if (-not $adbPath) {
    throw "ADB was not found. Install Android SDK Platform-Tools first."
}

& $adbPath start-server | Out-Null
$deviceLines = @(@(& $adbPath devices) | Select-Object -Skip 1 | Where-Object { $_ -match "\sdevice$" })
if ($DeviceSerial) {
    $serial = $DeviceSerial
} elseif ($deviceLines.Count -eq 1) {
    $serial = ($deviceLines[0] -split "\s+")[0]
} elseif ($deviceLines.Count -eq 0) {
    throw "No authorized phone found. Enable USB debugging, connect the cable, and approve this computer on the phone."
} else {
    throw "Multiple devices found. Use -DeviceSerial to select one."
}

& $adbPath -s $serial forward "tcp:$Port" "tcp:$Port"
if ($LASTEXITCODE -ne 0) { throw "Failed to create the USB port forwarding rule." }

Write-Host "USB bridge is ready." -ForegroundColor Green
Write-Host "Extension address: 127.0.0.1"
Write-Host "Port: $Port"
Write-Host "Device serial: $serial"
