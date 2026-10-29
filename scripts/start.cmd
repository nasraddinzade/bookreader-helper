@echo off
rem Запуск книжной читалки: сборка интерфейса, сервер на 127.0.0.1:5180, открытие браузера.
rem Если сервер уже запущен, просто открывает читалку. Закрытие окна останавливает сервер.
chcp 65001 >nul
cd /d "%~dp0.."
title Book reader (127.0.0.1:5180)

curl -s -m 2 -o nul http://127.0.0.1:5180/api/settings
if %errorlevel%==0 (
  start "" http://127.0.0.1:5180/
  exit /b 0
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install || goto :fail
)
call npm run build || goto :fail
node server/index.js --open
if errorlevel 1 goto :fail
exit /b 0

:fail
echo.
echo Book reader failed to start. See the messages above.
pause
