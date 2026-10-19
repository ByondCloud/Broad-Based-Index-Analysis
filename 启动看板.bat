@echo off
setlocal
cd /d "%~dp0"
if exist "web\index.html" (
  start "" "web\index.html"
) else (
  echo [ERROR] web\index.html not found. Please check the folder.
  echo.
  pause
)
