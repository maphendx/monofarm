#!/usr/bin/env bash
# monofarm-agent installer
# Usage: bash install.sh [--release-public-key '<additional trusted public key>']

set -euo pipefail

# ── parse args ────────────────────────────────────────────────────────────────

TOKEN=""
TOKEN_PROVIDED="false"
PAIRING_CODE=""
RELEASE_PUBLIC_KEY="${MONOFARM_UPDATE_PUBLIC_KEYS:-2Doaw17ATYHVEEIT9VAVb2Y3HInyNM8sesvLU9Uz33M=}"
SERVER="https://api.monofarm.app"

while [[ $# -gt 0 ]]; do
  case $1 in
    --pairing-code)
      [[ $# -ge 2 && -n "${2:-}" ]] || { echo "Error: --pairing-code requires a value"; exit 1; }
      PAIRING_CODE="$2"
      shift 2
      ;;
    --token)
      [[ $# -ge 2 && -n "${2:-}" ]] || { echo "Error: --token requires a value"; exit 1; }
      TOKEN="$2"
      TOKEN_PROVIDED="true"
      shift 2
      ;;
    --release-public-key)
      [[ $# -ge 2 && -n "${2:-}" ]] || { echo "Error: --release-public-key requires a value"; exit 1; }
      RELEASE_PUBLIC_KEY="$2"
      shift 2
      ;;
    --server)
      [[ $# -ge 2 && -n "${2:-}" ]] || { echo "Error: --server requires a value"; exit 1; }
      SERVER="$2"
      shift 2
      ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

if [[ "$TOKEN_PROVIDED" == "true" ]]; then
  echo "Warning: --token is deprecated; use a one-time --pairing-code for new installs."
fi
if [[ ! "$RELEASE_PUBLIC_KEY" =~ ^[A-Za-z0-9+/]{43}=$ ]]; then
  echo "Error: --release-public-key must be the trusted CI Ed25519 public key (base64)."
  exit 1
fi

SERVER="${SERVER%/}"
if [[ "$SERVER" != https://* ]]; then
  echo "Error: --server must use HTTPS"
  exit 1
fi

# ── decide install dir (no sudo needed) ──────────────────────────────────────

INSTALL_DIR="$HOME/.monofarm-agent"
RELEASES_DIR="$INSTALL_DIR/releases"
CURRENT_LINK="$INSTALL_DIR/current"
AGENT_ENTRYPOINT="$CURRENT_LINK/monofarm_agent.py"
SERVICE_FILE="$HOME/.config/systemd/user/monofarm-agent.service"
PYTHON=$(command -v python3 || command -v python || echo "")

echo ""
echo "  monofarm agent installer"
echo "  Server: $SERVER"
echo "  Install dir: $INSTALL_DIR"
echo ""

# ── check python ──────────────────────────────────────────────────────────────

if [[ -z "$PYTHON" ]]; then
  echo "Error: python3 not found. Install it:"
  echo "  sudo apt install python3 python3-pip   # Debian/Ubuntu/Pi"
  echo "  brew install python3                   # macOS"
  exit 1
fi

echo "Python: $PYTHON ($($PYTHON --version 2>&1))"

# ── install dir ───────────────────────────────────────────────────────────────

mkdir -p "$INSTALL_DIR" "$RELEASES_DIR"

# ── create venv ───────────────────────────────────────────────────────────────

echo "Creating virtual environment…"
"$PYTHON" -m venv "$INSTALL_DIR/venv"
VENV_PYTHON="$INSTALL_DIR/venv/bin/python"

# ── verify signed manifest, then atomically activate the exact runtime ─────────

if ! command -v openssl >/dev/null 2>&1; then
  echo "Error: OpenSSL with Ed25519 support is required to verify the agent release."
  exit 1
fi

BOOTSTRAP_PATH="$INSTALL_DIR/legacy_bootstrap.py"
BOOTSTRAP_DOWNLOAD="$BOOTSTRAP_PATH.download"
rm -f "$BOOTSTRAP_DOWNLOAD"
trap 'rm -f "$BOOTSTRAP_DOWNLOAD"' EXIT

echo "Downloading signed-runtime bootstrap from $SERVER …"
curl \
  --fail \
  --show-error \
  --silent \
  --location \
  --proto '=https' \
  --proto-redir '=https' \
  --tlsv1.2 \
  "$SERVER/agent/monofarm_agent.py" \
  --output "$BOOTSTRAP_DOWNLOAD"
[[ -s "$BOOTSTRAP_DOWNLOAD" ]] || { echo "Error: downloaded bootstrap is empty"; exit 1; }
mv "$BOOTSTRAP_DOWNLOAD" "$BOOTSTRAP_PATH"
trap - EXIT

MONOFARM_UPDATE_PUBLIC_KEYS="$RELEASE_PUBLIC_KEY" \
  "$VENV_PYTHON" "$BOOTSTRAP_PATH" --server "$SERVER" --install-only
[[ -s "$AGENT_ENTRYPOINT" ]] || { echo "Error: signed agent runtime was not activated"; exit 1; }
echo "Agent runtime activated at $CURRENT_LINK"

# ── write config ──────────────────────────────────────────────────────────────

FRONTEND="https://monofarm.app"
ENV_FILE="$INSTALL_DIR/.env"
ENV_TEMP=$(mktemp "$INSTALL_DIR/.env.XXXXXX")
{
  printf 'MONOFARM_SERVER=%s\n' "$SERVER"
  printf 'MONOFARM_FRONTEND=%s\n' "$FRONTEND"
  printf 'MONOFARM_UPDATE_PUBLIC_KEYS=%s\n' "$RELEASE_PUBLIC_KEY"
  if [[ -n "$PAIRING_CODE" ]]; then
    printf 'MONOFARM_PAIRING_CODE=%s\n' "$PAIRING_CODE"
  fi
  if [[ "$TOKEN_PROVIDED" == "true" ]]; then
    printf 'MONOFARM_TOKEN=%s\n' "$TOKEN"
  fi
  if [[ -f "$ENV_FILE" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      case "$line" in
        MONOFARM_SERVER=*|MONOFARM_FRONTEND=*|MONOFARM_UPDATE_PUBLIC_KEYS=*) ;;
        MONOFARM_PAIRING_CODE=*)
          [[ -n "$PAIRING_CODE" ]] || printf '%s\n' "$line"
          ;;
        MONOFARM_TOKEN=) ;;
        MONOFARM_TOKEN=*)
          [[ "$TOKEN_PROVIDED" == "true" ]] || printf '%s\n' "$line"
          ;;
        *) printf '%s\n' "$line" ;;
      esac
    done < "$ENV_FILE"
  fi
} > "$ENV_TEMP"
chmod 600 "$ENV_TEMP"
mv "$ENV_TEMP" "$ENV_FILE"
echo "Config written to $ENV_FILE"

# ── systemd (user-level, no sudo) ─────────────────────────────────────────────

if command -v systemctl &>/dev/null && systemctl --user daemon-reload &>/dev/null 2>&1; then
  echo "Setting up systemd user service…"
  mkdir -p "$(dirname "$SERVICE_FILE")"
  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=monofarm local agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${CURRENT_LINK}
ExecStart=${INSTALL_DIR}/venv/bin/python ${AGENT_ENTRYPOINT}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable monofarm-agent
  systemctl --user restart monofarm-agent

  sleep 2
  STATUS=$(systemctl --user is-active monofarm-agent 2>/dev/null || echo "unknown")

  echo ""
  if [[ "$STATUS" == "active" ]]; then
    echo "  ✓ monofarm-agent is running (systemd)"
    echo "  Logs:    journalctl --user -u monofarm-agent -f"
    echo "  Restart: systemctl --user restart monofarm-agent"
    echo "  Stop:    systemctl --user stop monofarm-agent"
  else
    echo "  ✗ Status: $STATUS — starting manually instead"
    nohup "$VENV_PYTHON" "$AGENT_ENTRYPOINT" \
      > "$INSTALL_DIR/agent.log" 2>&1 &
    echo "  PID: $!  |  Logs: tail -f $INSTALL_DIR/agent.log"
  fi

elif [[ "$(uname)" == "Darwin" ]]; then
  # macOS — use launchd (survives reboots, auto-restart)
  PLIST_DIR="$HOME/Library/LaunchAgents"
  PLIST_FILE="$PLIST_DIR/app.monofarm.agent.plist"
  echo "Setting up macOS LaunchAgent…"
  mkdir -p "$PLIST_DIR"
  cat > "$PLIST_FILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>app.monofarm.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>${INSTALL_DIR}/venv/bin/python</string>
    <string>${AGENT_ENTRYPOINT}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${INSTALL_DIR}/agent.log</string>
  <key>StandardErrorPath</key><string>${INSTALL_DIR}/agent.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>${HOME}</string>
  </dict>
</dict>
</plist>
EOF
  launchctl unload "$PLIST_FILE" 2>/dev/null || true
  launchctl load -w "$PLIST_FILE"
  echo ""
  echo "  ✓ monofarm-agent installed as LaunchAgent"
  echo "  Logs:    tail -f $INSTALL_DIR/agent.log"
  echo "  Restart: launchctl kickstart -k gui/$(id -u)/app.monofarm.agent"
  echo "  Stop:    launchctl unload $PLIST_FILE"

else
  # Linux without systemd (Docker, WSL, etc.) — run in background
  echo "systemd not available — starting in background…"
  nohup "$VENV_PYTHON" "$AGENT_ENTRYPOINT" \
    > "$INSTALL_DIR/agent.log" 2>&1 &
  AGENT_PID=$!
  echo ""
  echo "  ✓ monofarm-agent started (PID: $AGENT_PID)"
  echo "  Logs: tail -f $INSTALL_DIR/agent.log"
  echo "  Stop: kill $AGENT_PID"
  echo "$AGENT_PID" > "$INSTALL_DIR/agent.pid"
fi

echo ""
echo "  Done! Your Klipper printers are now accessible remotely."
echo ""
