@echo off
setlocal
cd /d "%~dp0"
echo.
echo ==== Update market data ====
echo This may take 2-3 minutes. Keep the network connected.
echo.

set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY (
  where py >nul 2>nul && set "PY=py -3"
)
if not defined PY (
  echo [ERROR] Python not found in PATH.
  echo Please install Python 3 and make sure "python" works in cmd.
  echo.
  pause
  exit /b 1
)

%PY% scripts\fetch_data.py
if errorlevel 1 (
  echo.
  echo [ERROR] Update failed. Check your network connection and try again.
  echo.
  pause
  exit /b 1
)

echo.
echo [OK] Data updated. Open web\index.html and refresh the page.
echo.
pause
