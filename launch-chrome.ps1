#!/usr/bin/env pwsh
# Launch Chrome with Remote Debugging Port for Manual Chrome Mode

$ChromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$TempProfile = "$env:TEMP\chrome-debug-profile"

# Check if Chrome exists
if (-not (Test-Path $ChromePath)) {
    Write-Host "❌ Chrome not found at: $ChromePath" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please install Google Chrome from: https://www.google.com/chrome/" -ForegroundColor Yellow
    exit 1
}

Write-Host "✅ Found Chrome at: $ChromePath" -ForegroundColor Green
Write-Host ""
Write-Host "Starting Chrome with Remote Debugging Port 9222..." -ForegroundColor Cyan
Write-Host "Using temporary profile at: $TempProfile" -ForegroundColor Gray
Write-Host "Keep this window open while using the server" -ForegroundColor Yellow
Write-Host ""

# Kill any existing Chrome processes first
Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

# Launch Chrome with debugging port and temporary profile
& $ChromePath `
  --remote-debugging-port=9222 `
  --remote-debugging-address=127.0.0.1 `
  --user-data-dir=$TempProfile

Write-Host ""
Write-Host "⚠️  Chrome closed. The server will no longer be able to access manual tabs." -ForegroundColor Yellow

