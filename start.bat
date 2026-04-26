@echo off
echo Starting RxGuard...

echo.
echo [1/2] Starting backend (Node.js)...
start "RxGuard Backend" cmd /k "cd /d %~dp0server && npm install && npm run dev"

timeout /t 4 >nul

echo [2/2] Starting frontend...
start "RxGuard Frontend" cmd /k "cd /d %~dp0frontend && npm install && npm run dev"

echo.
echo RxGuard is starting up...
echo Backend:  http://localhost:8000
echo Frontend: http://localhost:5173
echo.
pause
