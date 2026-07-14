# monofarm-agent Windows installer (exe-first — no Python required)
# Usage: irm https://api.monofarm.app/agent/install.ps1 | iex
#
# Downloads monofarm-agent.exe to %LOCALAPPDATA%\Programs\monofarm-agent,
# writes the token to %USERPROFILE%\.monofarm-agent\.env, and adds a Startup
# shortcut so the tray app launches at login (no admin needed).

param(
    [string]$PairingCode = $env:MONOFARM_PAIRING_CODE,
    [string]$Token       = $env:MONOFARM_TOKEN,
    [string]$Email       = $env:MONOFARM_EMAIL,
    [string]$Password    = $env:MONOFARM_PASSWORD,
    [string]$ReleasePublicKey = $(if ($env:MONOFARM_UPDATE_PUBLIC_KEYS) { $env:MONOFARM_UPDATE_PUBLIC_KEYS } else { "2Doaw17ATYHVEEIT9VAVb2Y3HInyNM8sesvLU9Uz33M=" }),
    [string]$ExpectedSha256 = $env:MONOFARM_AGENT_EXPECTED_SHA256,
    [string]$Server      = "https://api.monofarm.app",
    [string]$Frontend    = "https://monofarm.app"
)

$ErrorActionPreference = "Stop"

$ServerUri = [Uri]$Server
if (-not $ServerUri.IsAbsoluteUri -or $ServerUri.Scheme -ne [Uri]::UriSchemeHttps) {
    throw "Server must use HTTPS"
}
$Server = $Server.TrimEnd("/")
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if ($ReleasePublicKey -notmatch '^[A-Za-z0-9+/]{43}=$') {
    throw "ReleasePublicKey must be the trusted CI Ed25519 public key (base64)"
}
$PinnedSha256 = $ExpectedSha256.Trim().ToLowerInvariant()
if ($PinnedSha256 -and $PinnedSha256 -notmatch '^[0-9a-f]{64}$') {
    throw "ExpectedSha256 must be a SHA-256 digest"
}

$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\monofarm-agent"
$ExePath    = Join-Path $InstallDir "monofarm-agent.exe"
$ConfigDir  = Join-Path $env:USERPROFILE ".monofarm-agent"

Write-Host ""
Write-Host "  monofarm agent installer (Windows, exe)"
Write-Host "  Server:      $Server"
Write-Host "  Install dir: $InstallDir"
Write-Host ""

# ── Auto-login: exchange email+password for a token ───────────────────────────

if (-not $PairingCode -and -not $Token -and $Email -and $Password) {
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

# ── Download and atomically replace the exe ───────────────────────────────────

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $ConfigDir  | Out-Null

Write-Host "Downloading agent from $Server ..."
$DownloadPath = Join-Path $InstallDir "monofarm-agent.exe.download"
$BackupPath = Join-Path $InstallDir "monofarm-agent.exe.old"
Remove-Item -LiteralPath $DownloadPath -Force -ErrorAction SilentlyContinue
try {
    $VersionResponse = Invoke-RestMethod -Uri "$Server/api/agent/version" `
        -Method GET -ErrorAction Stop
    if (-not $VersionResponse.manifest -or
        $VersionResponse.version -ne $VersionResponse.manifest.version) {
        throw "Server did not provide a matching signed release manifest"
    }
    if ([string]$VersionResponse.update_public_key -ne $ReleasePublicKey) {
        throw "Server release key does not match the pinned CI public key"
    }
    $Artifact = $VersionResponse.manifest.artifacts.'windows-x86_64'
    if (-not $Artifact) {
        throw "No verified Windows artifact is available for this release"
    }
    $ArtifactUri = [Uri]$Artifact.url
    if (-not $ArtifactUri.IsAbsoluteUri -or
        $ArtifactUri.Scheme -ne [Uri]::UriSchemeHttps -or
        $ArtifactUri.UserInfo -or $ArtifactUri.Fragment) {
        throw "Windows artifact URL must be an absolute HTTPS URL"
    }
    [Int64]$ExpectedSize = $Artifact.size
    $ManifestSha256 = ([string]$Artifact.sha256).ToLowerInvariant()
    if ($ExpectedSize -le 0 -or $ManifestSha256 -notmatch '^[0-9a-f]{64}$') {
        throw "Windows artifact integrity metadata is invalid"
    }
    if ($PinnedSha256 -and $ManifestSha256 -ne $PinnedSha256) {
        throw "Release manifest digest does not match the out-of-band CI digest"
    }

    Invoke-WebRequest -Uri $ArtifactUri.AbsoluteUri `
        -OutFile $DownloadPath -UseBasicParsing -ErrorAction Stop
    if (-not (Test-Path -LiteralPath $DownloadPath) -or
        (Get-Item -LiteralPath $DownloadPath).Length -ne $ExpectedSize) {
        throw "Downloaded agent executable size does not match the release manifest"
    }
    $ActualSha256 = (Get-FileHash -LiteralPath $DownloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ActualSha256 -ne $ManifestSha256) {
        throw "Downloaded agent executable SHA-256 does not match the release manifest"
    }
} catch {
    Remove-Item -LiteralPath $DownloadPath -Force -ErrorAction SilentlyContinue
    throw
}

Get-Process -Name "monofarm-agent" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

Remove-Item -LiteralPath $BackupPath -Force -ErrorAction SilentlyContinue
$HadPreviousExe = Test-Path -LiteralPath $ExePath
try {
    if ($HadPreviousExe) {
        [System.IO.File]::Replace($DownloadPath, $ExePath, $BackupPath, $true)
    } else {
        [System.IO.File]::Move($DownloadPath, $ExePath)
    }
} finally {
    Remove-Item -LiteralPath $DownloadPath -Force -ErrorAction SilentlyContinue
}

# ── Write config (preserve existing keys like ALERT_CHAT_IDS) ─────────────────

$EnvFile = Join-Path $ConfigDir ".env"
$cfg = [ordered]@{
    MONOFARM_SERVER             = $Server
    MONOFARM_FRONTEND           = $Frontend
    MONOFARM_UPDATE_PUBLIC_KEYS = $ReleasePublicKey
}
if ($PairingCode) {
    $cfg["MONOFARM_PAIRING_CODE"] = $PairingCode
    $cfg["MONOFARM_TOKEN"] = ""
} elseif ($Token) {
    $cfg["MONOFARM_TOKEN"] = $Token
    $cfg["MONOFARM_PAIRING_CODE"] = ""
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
$AgentProcess = Start-Process -FilePath $ExePath -WorkingDirectory $InstallDir -PassThru

# Keep the previous executable until the candidate stays alive and its
# loopback health endpoint answers. A configured port of 0 intentionally
# disables the local UI, so process liveness is the bounded fallback there.
[int]$HealthPort = 8723
if ($cfg.Contains("MONOFARM_WEB_PORT")) {
    [int]$ConfiguredHealthPort = 0
    if ([int]::TryParse([string]$cfg["MONOFARM_WEB_PORT"], [ref]$ConfiguredHealthPort)) {
        $HealthPort = $ConfiguredHealthPort
    }
}
$HealthDeadline = (Get-Date).AddSeconds(20)
$LivenessDeadline = (Get-Date).AddSeconds(3)
$Healthy = $false
while ((Get-Date) -lt $HealthDeadline) {
    Start-Sleep -Milliseconds 500
    if ($AgentProcess.HasExited) { break }
    if ($HealthPort -le 0) {
        if ((Get-Date) -ge $LivenessDeadline) {
            $Healthy = $true
            break
        }
        continue
    }
    try {
        $HealthResponse = Invoke-WebRequest `
            -Uri "http://127.0.0.1:$HealthPort/healthz" `
            -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        if ($HealthResponse.StatusCode -eq 200) {
            $Healthy = $true
            break
        }
    } catch {
        # The process may still be starting; retry until the bounded deadline.
    }
}

if (-not $Healthy) {
    if (-not $AgentProcess.HasExited) {
        Stop-Process -Id $AgentProcess.Id -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $ExePath -Force -ErrorAction SilentlyContinue
    if ($HadPreviousExe -and (Test-Path -LiteralPath $BackupPath)) {
        Move-Item -LiteralPath $BackupPath -Destination $ExePath -Force
        Start-Process -FilePath $ExePath -WorkingDirectory $InstallDir
    } else {
        Remove-Item -LiteralPath $BatFile -Force -ErrorAction SilentlyContinue
    }
    throw "Agent candidate failed its health check; the previous release was restored"
}

Remove-Item -LiteralPath $BackupPath -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "  [OK] monofarm agent launched - look for the icon in the system tray."
Write-Host ""
Write-Host "  Note: Windows SmartScreen may warn about an unknown publisher."
Write-Host "        Click 'More info' then 'Run anyway' (the exe is not yet code-signed)."
Write-Host ""
Write-Host "  Logs:    Get-Content `"$ConfigDir\agent.log`" -Wait -Tail 50"
Write-Host "  Remove:  Remove-Item `"$BatFile`"; Remove-Item -Recurse `"$InstallDir`""
Write-Host ""
