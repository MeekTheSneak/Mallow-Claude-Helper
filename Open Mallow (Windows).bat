@echo off
rem Starts Mallow. It uses the copy of Python in the runtime folder, so there is nothing to install.
cd /d "%~dp0"
set "PYW=%~dp0runtime\python\pythonw.exe"
if exist "%PYW%" (
  rem Windows marks downloaded files as "from the internet", which stops the window library loading.
  rem Clearing that mark on Mallow's own files is a one-time step.
  if not exist "%~dp0runtime\.ready" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0.' -Recurse -File | Unblock-File" >nul 2>nul
    echo ok> "%~dp0runtime\.ready"
  )
  start "" "%PYW%" "%~dp0mallow.py" --log "%USERPROFILE%\.mallow\launch.log"
  exit /b
)
where pyw >nul 2>nul && (start "" pyw "%~dp0mallow.py" & exit /b)
where pythonw >nul 2>nul && (start "" pythonw "%~dp0mallow.py" & exit /b)
echo The runtime folder is missing. Download Mallow again from GitHub, or install Python 3 from python.org.
pause
