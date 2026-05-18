@echo off
:: Build monofarm-agent.exe for Windows
:: Requires: pip install pyinstaller pystray Pillow websockets httpx

echo Building monofarm-agent.exe ...
pyinstaller ^
  --onefile ^
  --windowed ^
  --name "monofarm-agent" ^
  --icon "monofarm.ico" ^
  monofarm_tray.py

echo Done! Executable is in dist\monofarm-agent.exe
pause
