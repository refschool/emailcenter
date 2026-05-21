@echo off
cd /d E:\formapedia2026\EmailCenter
if not exist logs mkdir logs
call .venv\Scripts\activate.bat
start "EmailCenter" /min cmd /c "python app.py >> logs\app.log 2>&1"
