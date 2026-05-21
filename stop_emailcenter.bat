@echo off
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :5000') do taskkill /f /pid %%a
echo EmailCenter arrêté
pause