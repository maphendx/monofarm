# monofarm-agent Windows installer
# Usage: irm https://monofarm.app/agent/install.ps1 | iex
#
# Installs the tray app to %USERPROFILE%\.monofarm-agent and adds a Startup
# folder shortcut so it launches automatically at login (no admin needed).

param(
    [string]$Token    = $env:MONOFARM_TOKEN,
    [string]$Server   = "https://api.monofarm.app",
    [string]$Frontend = "https://monofarm.app"
)

$ErrorActionPreference = "Stop"

$InstallDir  = Join-Path $env:USERPROFILE ".monofarm-agent"
$TrayScript  = Join-Path $InstallDir "monofarm_tray.py"
$AgentScript = Join-Path $InstallDir "monofarm_agent.py"
$VenvPython  = Join-Path $InstallDir "venv\Scripts\python.exe"
$VenvPythonW = Join-Path $InstallDir "venv\Scripts\pythonw.exe"

Write-Host ""
Write-Host "  monofarm agent installer (Windows)"
Write-Host "  Server:      $Server"
Write-Host "  Install dir: $InstallDir"
Write-Host ""

# ── Python check ─────────────────────────────────────────────────────────────

$PythonExe = $null
foreach ($candidate in @("python", "python3", "py")) {
    try {
        $ver = & $candidate --version 2>&1
        if ($ver -match "Python 3") {
            $PythonExe = (Get-Command $candidate).Source
            Write-Host "Python: $PythonExe ($ver)"
            break
        }
    } catch { }
}

if (-not $PythonExe) {
    Write-Host "Python 3 not found. Installing via winget…"
    winget install --id Python.Python.3.11 --source winget --silent
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("PATH", "User")
    $PythonExe = (Get-Command python).Source
}

# ── Install dir ───────────────────────────────────────────────────────────────

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# ── venv + deps ───────────────────────────────────────────────────────────────

Write-Host "Creating virtual environment…"
& $PythonExe -m venv "$InstallDir\venv"

Write-Host "Installing dependencies…"
& "$InstallDir\venv\Scripts\pip" install --quiet --upgrade pip
& "$InstallDir\venv\Scripts\pip" install --quiet websockets httpx pystray Pillow

# ── Download agent files ──────────────────────────────────────────────────────

Write-Host "Downloading agent from $Server …"
Invoke-WebRequest -Uri "$Server/agent/monofarm_agent.py" -OutFile $AgentScript
Invoke-WebRequest -Uri "$Server/agent/monofarm_tray.py"  -OutFile $TrayScript

# ── Write config ──────────────────────────────────────────────────────────────

$EnvFile = Join-Path $InstallDir ".env"
Set-Content -Path $EnvFile -Value "MONOFARM_SERVER=$Server`nMONOFARM_FRONTEND=$Frontend`nMONOFARM_TOKEN=$Token"
Write-Host "Config written to $EnvFile"

# ── Startup folder shortcut (runs at login, no admin needed) ──────────────────

Write-Host "Adding to Startup folder…"
$StartupDir = [Environment]::GetFolderPath("Startup")
$BatFile    = Join-Path $StartupDir "monofarm-agent.bat"
Set-Content -Path $BatFile -Value "@echo off`r`nstart `"`" `"$VenvPythonW`" `"$TrayScript`"`r`n"

# ── Kill any old agent instance, then start tray ─────────────────────────────

Write-Host "Starting tray app…"
# Stop old headless agent Task Scheduler entry if it was set up previously
Unregister-ScheduledTask -TaskName "MonofarmAgent" -Confirm:$false -ErrorAction SilentlyContinue
# Kill any running monofarm python process
Get-Process | Where-Object { $_.MainModule.FileName -like "*monofarm*\venv\*python*" } `
    -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

Start-Process -FilePath $VenvPythonW `
    -ArgumentList "`"$TrayScript`"" `
    -WorkingDirectory $InstallDir

Start-Sleep -Seconds 3

Write-Host ""
Write-Host "  [OK] monofarm tray app launched — look for the icon in the system tray"
Write-Host "       (bottom-right corner of the taskbar, may be in the ^ overflow menu)"
Write-Host ""
Write-Host "  Logs:    Get-Content `"$InstallDir\agent.log`" -Wait"
Write-Host "  Restart: & `"$VenvPythonW`" `"$TrayScript`""
Write-Host "  Remove:  Remove-Item `"$BatFile`""
Write-Host ""
Write-Host "  Done! Open the tray icon to pair with your monofarm account."
Write-Host ""
