@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "web\index.html" (
  start "" "web\index.html"
) else (
  echo 未找到 web\index.html，请确认目录完整。
  pause
)
