[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$releaseDir = Join-Path $projectRoot "release"
$androidDir = Join-Path $projectRoot "android"
$extensionDir = Join-Path $projectRoot "extension"
$localJdk = Join-Path $projectRoot ".tooling\jdk\jdk-17.0.20+8"
$localSdk = Join-Path $projectRoot ".tooling\sdk"

if (-not (Test-Path -LiteralPath (Join-Path $androidDir "gradlew.bat"))) {
    throw "Android project not found under $projectRoot"
}
if (-not (Test-Path -LiteralPath (Join-Path $extensionDir "package.json"))) {
    throw "Verification Code Transfer extension not found under $projectRoot"
}

if (Test-Path -LiteralPath $localJdk) { $env:JAVA_HOME = $localJdk }
if (Test-Path -LiteralPath $localSdk) {
    $env:ANDROID_HOME = $localSdk
    $env:ANDROID_SDK_ROOT = $localSdk
}

function Build-Extension([string] $path, [string] $name) {
    Push-Location $path
    try {
        & npm ci
        if ($LASTEXITCODE -ne 0) { throw "$name npm ci failed" }
        & npm run check
        if ($LASTEXITCODE -ne 0) { throw "$name type check failed" }
        & npm test
        if ($LASTEXITCODE -ne 0) { throw "$name tests failed" }
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw "$name build failed" }
    } finally {
        Pop-Location
    }
}

Build-Extension $extensionDir "Verification Code Transfer extension"

Push-Location $androidDir
try {
    & .\gradlew.bat testDebugUnitTest lintDebug assembleDebug --no-daemon
    if ($LASTEXITCODE -ne 0) { throw "Android build failed" }
} finally {
    Pop-Location
}

if ((Split-Path -Parent $releaseDir) -ne $projectRoot) {
    throw "Refusing to replace an output directory outside the project"
}
if (Test-Path -LiteralPath $releaseDir) {
    Remove-Item -LiteralPath $releaseDir -Recurse -Force
}
New-Item -ItemType Directory -Path $releaseDir | Out-Null

$apkSource = Join-Path $androidDir "app\build\outputs\apk\debug\app-debug.apk"
$apkTarget = Join-Path $releaseDir "verification-code-transfer-android.apk"
$extensionTarget = Join-Path $releaseDir "verification-code-transfer-chrome.zip"
Copy-Item -LiteralPath $apkSource -Destination $apkTarget
Compress-Archive -Path (Join-Path $extensionDir "dist\*") -DestinationPath $extensionTarget -CompressionLevel Optimal

$checksums = @($apkTarget, $extensionTarget) | ForEach-Object {
    $hash = Get-FileHash -Algorithm SHA256 -LiteralPath $_
    "$($hash.Hash.ToLowerInvariant())  $(Split-Path -Leaf $_)"
}
Set-Content -LiteralPath (Join-Path $releaseDir "SHA256SUMS.txt") -Value $checksums -Encoding ascii

Write-Host "Release files are ready:" -ForegroundColor Green
Get-ChildItem -LiteralPath $releaseDir | Select-Object Name, Length
