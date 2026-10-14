@echo off
rem Puts a Mallow icon on your desktop. Run it again if you move this folder.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0.' -Recurse -File | Unblock-File" >nul 2>nul
if exist "%~dp0runtime\python\python.exe" (
  echo ok> "%~dp0runtime\.ready"
  "%~dp0runtime\python\python.exe" "%~dp0mallow.py" --add-to-desktop
) else (
  py "%~dp0mallow.py" --add-to-desktop
)
pause
