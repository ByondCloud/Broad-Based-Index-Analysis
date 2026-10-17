@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在抓取最新估值数据，请稍候...
python scripts\fetch_data.py
if errorlevel 1 (
  echo.
  echo 抓取失败：请检查网络连接，并确认已安装 Python 3。
) else (
  echo.
  echo 数据已更新，刷新页面即可查看。
)
pause
