@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 or newer before starting.
  pause
  exit /b 1
)
if not exist node_modules\tsx (
  echo Install dependencies first: npm install
  pause
  exit /b 1
)
call npm run build
if errorlevel 1 (
  pause
  exit /b 1
)
echo Open the address printed by the server in your browser after it starts.
call npm start
pause
