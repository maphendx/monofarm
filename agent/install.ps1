# monofarm-agent Windows installer
# Usage: irm https://monofarm.app/agent/install.ps1 | iex
# Or with args: powershell -ExecutionPolicy Bypass -File install.ps1 -Token TOKEN -Server https://monofarm.app
#
# Installs to %USERPROFILE%\.monofarm-agent and registers a Task Scheduler entry
# so the agent starts automatically at login (no admin rights required).

param(
    [string]$Token  = $env:MONOFARM_TOKEN,
    [string]$Server = "https://monofarm.app"
)

$ErrorActionPreference = "Stop"

if (-not $Token) {
    # Prompt interactively if not provided
    $Token = Read-Host "Enter your monofarm token (from Settings → Agent Connection)"
}
if (-not $Token) {
    Write-Error "Token is required. Run: install.ps1 -Token YOUR_TOKEN"
    exit 1
}

$InstallDir = Join-Path $env:USERPROFILE ".monofarm-agent"
$AgentScript = Join-Path $InstallDir "monofarm_agent.py"
$VenvPython  = Join-Path $InstallDir "venv\Scripts\python.exe"
$TaskName    = "MonofarmAgent"

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
    # Refresh PATH
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
& "$InstallDir\venv\Scripts\pip" install --quiet websockets httpx

# ── download agent ────────────────────────────────────────────────────────────

Write-Host "Downloading agent from $Server/agent/monofarm_agent.py …"
Invoke-WebRequest -Uri "$Server/agent/monofarm_agent.py" -OutFile $AgentScript

# ── write config ──────────────────────────────────────────────────────────────

$EnvFile = Join-Path $InstallDir ".env"
Set-Content -Path $EnvFile -Value "MONOFARM_SERVER=$Server`nMONOFARM_TOKEN=$Token"
# Restrict permissions — only current user can read
$acl = Get-Acl $EnvFile
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $env:USERNAME, "FullControl", "Allow"
)
$acl.SetAccessRule($rule)
Set-Acl $EnvFile $acl

# ── Task Scheduler (no admin needed for current-user tasks) ───────────────────

Write-Host "Registering Task Scheduler entry…"

# Remove old task if present
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

$action  = New-ScheduledTaskAction `
    -Execute $VenvPython `
    -Argument "`"$AgentScript`" --server `"$Server`" --token `"$Token`"" `
    -WorkingDirectory $InstallDir

$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 9999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

Register-ScheduledTask `
    -TaskName  $TaskName `
    -Action    $action `
    -Trigger   $trigger `
    -Settings  $settings `
    -RunLevel  Limited `
    -Force | Out-Null

# Start immediately
Start-ScheduledTask -TaskName $TaskName

Start-Sleep -Seconds 2
$state = (Get-ScheduledTask -TaskName $TaskName).State

Write-Host ""
if ($state -eq "Running") {
    Write-Host "  [OK] monofarm-agent is running"
} else {
    Write-Host "  [!]  Task state: $state — check logs below"
}
Write-Host "  Logs:    Get-Content `"$InstallDir\agent.log`" -Wait"
Write-Host "  Restart: Start-ScheduledTask -TaskName $TaskName"
Write-Host "  Stop:    Stop-ScheduledTask  -TaskName $TaskName"
Write-Host "  Remove:  Unregister-ScheduledTask -TaskName $TaskName"
Write-Host ""
Write-Host "  Done! Your printers are now accessible remotely."
Write-Host ""
