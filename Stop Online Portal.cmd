@echo off
setlocal
cd /d "%~dp0"
set "PORT=3141"
if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
    if /I "%%A"=="PORT" set "PORT=%%B"
  )
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$port = [int]'%PORT%'; $connections = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue; if (-not $connections) { Write-Host ('Online Portal is not running on port {0}.' -f $port); exit 0 }; $processIds = $connections | Select-Object -ExpandProperty OwningProcess -Unique; foreach ($processId in $processIds) { if ($processId -gt 0) { Stop-Process -Id $processId -Force; Write-Host ('Stopped Online Portal process {0} on port {1}.' -f $processId, $port) } }"
pause
endlocal
