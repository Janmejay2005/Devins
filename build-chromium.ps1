param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$extensionSource = Join-Path $projectRoot "sih-agent\extension"
$distributionRoot = Join-Path $projectRoot "dist"
$packageDirectory = Join-Path $distributionRoot "devins-chromium"
$archivePath = Join-Path $projectRoot "devins-chromium.zip"

$runtimeFiles = @(
    "background.js",
    "blazeface.min.js",
    "content.js",
    "face.js",
    "fusion.js",
    "ocr.js",
    "perception.js",
    "popup.html",
    "popup.js",
    "runtime-check.js",
    "sandbox-face.js",
    "sandbox.html",
    "tensorflow.min.js",
    "tesseract.min.js",
    "worker.min.js"
)

$iconFiles = @(
    "devins-16.png",
    "devins-32.png",
    "devins-48.png",
    "devins-128.png"
)

$outputsExist = (Test-Path $packageDirectory) -or (Test-Path $archivePath)
if ($outputsExist -and -not $Force) {
    throw "Build outputs already exist. Re-run with -Force to replace dist/devins-chromium and devins-chromium.zip."
}

foreach ($file in $runtimeFiles) {
    $sourcePath = Join-Path $extensionSource $file
    if (-not (Test-Path $sourcePath -PathType Leaf)) {
        throw "Required runtime file is missing: $sourcePath"
    }
}

foreach ($file in $iconFiles) {
    $sourcePath = Join-Path $extensionSource "assets\$file"
    if (-not (Test-Path $sourcePath -PathType Leaf)) {
        throw "Required extension icon is missing: $sourcePath"
    }
}

$manifestSource = Join-Path $extensionSource "manifest.chromium.json"
if (-not (Test-Path $manifestSource -PathType Leaf)) {
    throw "Chromium manifest is missing: $manifestSource"
}

$manifest = Get-Content $manifestSource -Raw | ConvertFrom-Json
if ($manifest.manifest_version -ne 3 -or $manifest.background.service_worker -ne "background.js") {
    throw "Chromium manifest must use Manifest V3 and background.js as its service worker."
}
if ($manifest.background.PSObject.Properties.Name -contains "scripts" -or $manifest.browser_specific_settings) {
    throw "Chromium manifest contains Firefox-only background or browser configuration."
}

if ($Force) {
    Remove-Item $packageDirectory, $archivePath -Recurse -Force -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Path (Join-Path $packageDirectory "assets") -Force | Out-Null
Copy-Item $manifestSource (Join-Path $packageDirectory "manifest.json")

foreach ($file in $runtimeFiles) {
    Copy-Item (Join-Path $extensionSource $file) $packageDirectory
}

foreach ($file in $iconFiles) {
    Copy-Item (Join-Path $extensionSource "assets\$file") (Join-Path $packageDirectory "assets")
}

Compress-Archive -Path (Join-Path $packageDirectory "*") -DestinationPath $archivePath -CompressionLevel Optimal

Write-Host "Chromium extension: $packageDirectory"
Write-Host "ZIP package: $archivePath"