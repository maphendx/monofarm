# monofarm-agent Windows installer (exe-first — no Python required)
# Usage: irm https://api.monofarm.app/agent/install.ps1 | iex
#
# Downloads monofarm-agent.exe to %LOCALAPPDATA%\Programs\monofarm-agent,
# writes the token to %USERPROFILE%\.monofarm-agent\.env, and adds a Startup
# shortcut so the tray app launches at login (no admin needed).

param(
    [string]$Token    = $env:MONOFARM_TOKEN,
    [string]$Email    = $env:MONOFARM_EMAIL,
    [string]$Password = $env:MONOFARM_PASSWORD,
    [string]$Server   = "https://api.monofarm.app",
    [string]$Frontend = "https://monofarm.app"
)

$ErrorActionPreference = "Stop"

$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\monofarm-agent"
$ExePath    = Join-Path $InstallDir "monofarm-agent.exe"
$ConfigDir  = Join-Path $env:USERPROFILE ".monofarm-agent"

Write-Host ""
Write-Host "  monofarm agent installer (Windows, exe)"
Write-Host "  Server:      $Server"
Write-Host "  Install dir: $InstallDir"
Write-Host ""

# ── Auto-login: exchange email+password for a token ───────────────────────────

if (-not $Token -and $Email -and $Password) {
    Write-Host "Logging in as $Email ..."
    try {
        $body = @{email=$Email; password=$Password} | ConvertTo-Json
        $resp = Invoke-RestMethod -Uri "$Server/api/auth/login" -Method POST `
                    -Body $body -ContentType "application/json" -ErrorAction Stop
        $Token = $resp.access_token
        Write-Host "  [OK] Logged in - token acquired"
    } catch {
        Write-Host "  [!!] Login failed: $_"
        Write-Host "  You can paste the token later in the tray app's setup page."
    }
}

# ── Stop any running instance, then download the exe ──────────────────────────

Get-Process -Name "monofarm-agent" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $ConfigDir  | Out-Null

Write-Host "Downloading agent from $Server ..."
Invoke-WebRequest -Uri "$Server/agent/monofarm-agent.exe" -OutFile $ExePath

# ── Write config (preserve existing keys like ALERT_CHAT_IDS) ─────────────────

$EnvFile = Join-Path $ConfigDir ".env"
$cfg = [ordered]@{
    MONOFARM_SERVER   = $Server
    MONOFARM_FRONTEND = $Frontend
    MONOFARM_TOKEN    = $Token
}
if (Test-Path $EnvFile) {
    foreach ($line in Get-Content $EnvFile) {
        if ($line -match '^\s*([^#=]+)=(.*)$') {
            $k = $matches[1].Trim()
            if (-not $cfg.Contains($k)) { $cfg[$k] = $matches[2].Trim() }
        }
    }
}
($cfg.GetEnumerator() | Where-Object { $_.Value } | ForEach-Object { "$($_.Key)=$($_.Value)" }) `
    -join "`n" | Set-Content -Path $EnvFile -Encoding UTF8
Write-Host "Config written to $EnvFile"

# ── Startup folder shortcut (launches at login, no admin) ─────────────────────

Write-Host "Adding to Startup folder..."
$StartupDir = [Environment]::GetFolderPath("Startup")
$BatFile    = Join-Path $StartupDir "monofarm-agent.bat"
Set-Content -Path $BatFile -Value "@echo off`r`nstart `"`" `"$ExePath`"`r`n"

# Remove any legacy Python-based startup / scheduled task from older installs.
Unregister-ScheduledTask -TaskName "MonofarmAgent" -Confirm:$false -ErrorAction SilentlyContinue

# ── Launch ────────────────────────────────────────────────────────────────────

Write-Host "Starting monofarm-agent ..."
Start-Process -FilePath $ExePath -WorkingDirectory $InstallDir

Start-Sleep -Seconds 2
Write-Host ""
Write-Host "  [OK] monofarm agent launched - look for the icon in the system tray."
Write-Host ""
Write-Host "  Note: Windows SmartScreen may warn about an unknown publisher."
Write-Host "        Click 'More info' then 'Run anyway' (the exe is not yet code-signed)."
Write-Host ""
Write-Host "  Logs:    Get-Content `"$ConfigDir\agent.log`" -Wait -Tail 50"
Write-Host "  Remove:  Remove-Item `"$BatFile`"; Remove-Item -Recurse `"$InstallDir`""
Write-Host ""
