@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo 正在启动本地 Web 服务...

start "Uvicorn Server" ".\.venv\Scripts\python.exe" -m uvicorn app.main:app --host 127.0.0.1 --port 8000

echo 正在等待服务启动...
timeout /t 2 /nobreak >nul

echo 正在打开浏览器...
start "" "http://127.0.0.1:8000"

exit