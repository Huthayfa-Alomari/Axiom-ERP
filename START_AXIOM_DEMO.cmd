@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install it, then reopen this file.
  pause
  exit /b 1
)
where npx >nul 2>nul
if errorlevel 1 (
  echo npm/npx is required. Install Node.js with npm, then reopen this file.
  pause
  exit /b 1
)

echo Installing project dependencies on the first run...
call npx --yes pnpm@10.0.0 install --frozen-lockfile
if errorlevel 1 (
  echo Dependency installation failed. Check your internet connection.
  pause
  exit /b 1
)

echo Starting Axiom ERP POS at http://localhost:3000/pos
start "" cmd /c "timeout /t 8 /nobreak >nul & start http://localhost:3000/pos"
call npx --yes pnpm@10.0.0 --filter @axiom/web dev
pause
