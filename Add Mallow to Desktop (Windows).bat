@echo off
rem Puts a Mallow icon on your desktop. Run it again if you move this folder.
cd /d "%~dp0"
set "MALLOW_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath $env:MALLOW_DIR -Recurse -File | Unblock-File" >nul 2>nul && echo ok> "%~dp0runtime\.ready"
if exist "%~dp0runtime\python\python.exe" (
  "%~dp0runtime\python\python.exe" "%~dp0mallow.py" --add-to-desktop
) else (
  py "%~dp0mallow.py" --add-to-desktop
)
pause
