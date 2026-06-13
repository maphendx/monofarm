@echo off
:: Build monofarm-agent.exe for Windows (run on a Windows machine).
:: CI builds this automatically — see .github/workflows/agent-build.yml.

echo Installing build dependencies ...
pip install pyinstaller -r requirements.txt

echo Building monofarm-agent.exe ...
pyinstaller --noconfirm monofarm-agent.spec

echo Done! Executable is in dist\monofarm-agent.exe
pause
