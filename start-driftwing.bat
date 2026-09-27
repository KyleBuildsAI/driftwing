@echo off
setlocal
title DRIFTWING
cd /d "%~dp0"

rem ---- Node.js is required ------------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   DRIFTWING needs Node.js to run.
  echo   Install the LTS version from https://nodejs.org/en/download
  echo   then double-click start-driftwing.bat again.
  echo.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)
rem The major version from "v22.11.0". An empty or unreadable answer (a broken install, a wrapper
rem that prints something else) counts as unknown: 0, which asks for the LTS install below.
set "NODE_MAJOR="
for /f "tokens=1 delims=v." %%v in ('node -v 2^>nul') do if not defined NODE_MAJOR set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR set "NODE_MAJOR=0"
for /f "delims=0123456789" %%c in ("%NODE_MAJOR%") do set "NODE_MAJOR=0"
if "%NODE_MAJOR%"=="0" (
  echo.
  echo   DRIFTWING could not read your Node.js version.
  echo   Install the LTS version from https://nodejs.org/en/download
  echo   then double-click start-driftwing.bat again.
  echo.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)
rem NODE_MAJOR is digits only here, so the comparison below is numeric.
if %NODE_MAJOR% LSS 20 (
  echo.
  echo   DRIFTWING needs Node.js 20 or newer ^(found version %NODE_MAJOR%^).
  echo   Install the LTS version from https://nodejs.org/en/download
  echo.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)

rem ---- First run: install dependencies --------------------------------------------------
if not exist "node_modules\" (
  echo Installing DRIFTWING's dependencies ^(first run only^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   Installing dependencies failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

rem ---- Start the dev server; Vite opens http://127.0.0.1:5199 once it is ready ----------
echo Starting DRIFTWING at http://127.0.0.1:5199 ^(close this window to stop it^)...
call npm run dev -- --open
if errorlevel 1 (
  echo.
  echo   DRIFTWING could not start. If port 5199 is already in use, DRIFTWING may already be
  echo   running: open http://127.0.0.1:5199 in your browser.
  pause
  exit /b 1
)
