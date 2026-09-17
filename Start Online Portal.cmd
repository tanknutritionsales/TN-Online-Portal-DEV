@echo off
setlocal
cd /d "%~dp0"
set "PORT=3141"
if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
    if /I "%%A"=="PORT" set "PORT=%%B"
  )
)
start "Online Portal Server" cmd /k "npm start"
start "" "http://127.0.0.1:%PORT%"
endlocal
