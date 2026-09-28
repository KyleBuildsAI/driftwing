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
rem The major and minor version from "v22.11.0". An empty or unreadable answer (a broken install, a
rem wrapper that prints something else) counts as unknown: 0, which asks for the LTS install below.
set "NODE_MAJOR="
set "NODE_MINOR="
for /f "tokens=1,2 delims=v." %%v in ('node -v 2^>nul') do if not defined NODE_MAJOR (
  set "NODE_MAJOR=%%v"
  set "NODE_MINOR=%%w"
)
if not defined NODE_MAJOR set "NODE_MAJOR=0"
for /f "delims=0123456789" %%c in ("%NODE_MAJOR%") do set "NODE_MAJOR=0"
if not defined NODE_MINOR set "NODE_MINOR=0"
for /f "delims=0123456789" %%c in ("%NODE_MINOR%") do set "NODE_MINOR=0"
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
rem NODE_MAJOR and NODE_MINOR are digits only here, so the comparisons below are numeric. The
rem supported range is Vite's: 20.19 or later on Node 20, 22.12 or later, and every release after.
set "NODE_TOO_OLD="
if %NODE_MAJOR% LSS 20 set "NODE_TOO_OLD=1"
if %NODE_MAJOR% EQU 20 if %NODE_MINOR% LSS 19 set "NODE_TOO_OLD=1"
if %NODE_MAJOR% EQU 21 set "NODE_TOO_OLD=1"
if %NODE_MAJOR% EQU 22 if %NODE_MINOR% LSS 12 set "NODE_TOO_OLD=1"
if defined NODE_TOO_OLD (
  echo.
  echo   DRIFTWING needs Node.js 20.19 or newer, or 22.12 or newer ^(found version %NODE_MAJOR%.%NODE_MINOR%^).
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
  echo   running: open http://127.0.0.1:5199 in your browser. Otherwise check the messages above:
  echo   an outdated Node.js also stops it. Install the LTS version from https://nodejs.org/en/download
  pause
  exit /b 1
)
