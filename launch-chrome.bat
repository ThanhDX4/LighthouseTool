@echo off
REM Launch Chrome with Remote Debugging Port for Manual Chrome Mode

set "CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe"
set "TEMP_PROFILE=%TEMP%\chrome-debug-profile"

if not exist "%CHROME_PATH%" (
    echo.
    echo ERROR: Chrome not found at %CHROME_PATH%
    echo.
    echo Please install Google Chrome from: https://www.google.com/chrome/
    echo.
    pause
    exit /b 1
)

echo.
echo Starting Chrome with Remote Debugging Port 9222...
echo Using temporary profile at: %TEMP_PROFILE%
echo.
echo Keep this window open while using the server
echo.

taskkill /F /IM chrome.exe 2>nul
timeout /t 1 /nobreak >nul

start "" "%CHROME_PATH%" ^
  --remote-debugging-port=9222 ^
  --remote-debugging-address=127.0.0.1 ^
  --user-data-dir="%TEMP_PROFILE%"

echo.
echo Chrome launched! You can close this window or leave it open.
echo.
pause
