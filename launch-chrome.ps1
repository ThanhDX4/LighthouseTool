#!/usr/bin/env pwsh
# Launch Chrome with Remote Debugging Port for Manual Chrome Mode
# Does NOT close existing Chrome windows

$ChromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$DebugPort = 9222
$TempProfile = Join-Path $env:TEMP "chrome-debug-profile-$DebugPort"

# Check if Chrome exists
if (-not (Test-Path $ChromePath)) {
    Write-Host "❌ Chrome not found at: $ChromePath" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please install Google Chrome from: https://www.google.com/chrome/" -ForegroundColor Yellow
    exit 1
}

# Check if debug port is already in use
$PortInUse = Get-NetTCPConnection `
    -LocalPort $DebugPort `
    -State Listen `
    -ErrorAction SilentlyContinue

if ($PortInUse) {
    Write-Host "⚠️  Port $DebugPort is already in use." -ForegroundColor Yellow
    Write-Host "Chrome debugging may already be running at:" -ForegroundColor Cyan
    Write-Host "http://127.0.0.1:$DebugPort" -ForegroundColor Green
    Write-Host ""
    Write-Host "Existing Chrome windows are NOT closed." -ForegroundColor Gray
    exit 0
}

Write-Host "✅ Found Chrome at: $ChromePath" -ForegroundColor Green
Write-Host ""
Write-Host "Starting Chrome with Remote Debugging Port $DebugPort..." -ForegroundColor Cyan
Write-Host "Using isolated temporary profile at: $TempProfile" -ForegroundColor Gray
Write-Host "Existing Chrome windows will NOT be closed." -ForegroundColor Green
Write-Host ""

# Ensure temp profile directory exists
New-Item -ItemType Directory -Force -Path $TempProfile | Out-Null

# Launch Chrome with debugging port and isolated profile
& $ChromePath `
  --remote-debugging-port=$DebugPort `
  --remote-debugging-address=127.0.0.1 `
  --user-data-dir="$TempProfile" `
  --new-window `
  about:blank

Write-Host ""
Write-Host "⚠️  Debug Chrome closed. The server will no longer be able to access manual tabs." -ForegroundColor Yellow