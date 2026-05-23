#!/usr/bin/env bash
# monofarm-agent installer
# Usage: curl -sSL http://localhost:8000/agent/install.sh | bash -s -- --server http://localhost:8000
# Token is NOT required — the agent opens a browser for pairing on first start.

set -euo pipefail

# ── parse args ────────────────────────────────────────────────────────────────

TOKEN=""
SERVER="http://localhost:8000"

while [[ $# -gt 0 ]]; do
  case $1 in
    --token)  TOKEN="$2";  shift 2 ;;
    --server) SERVER="$2"; shift 2 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

# ── decide install dir (no sudo needed) ──────────────────────────────────────

INSTALL_DIR="$HOME/.monofarm-agent"
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

mkdir -p "$INSTALL_DIR"

# ── create venv + install deps ────────────────────────────────────────────────

echo "Creating virtual environment…"
"$PYTHON" -m venv "$INSTALL_DIR/venv"
VENV_PYTHON="$INSTALL_DIR/venv/bin/python"

echo "Installing dependencies (websockets, httpx)…"
"$INSTALL_DIR/venv/bin/pip" install --quiet websockets httpx

# ── download agent ────────────────────────────────────────────────────────────

echo "Downloading agent from $SERVER/agent/monofarm_agent.py …"
curl -sSL "$SERVER/agent/monofarm_agent.py" -o "$INSTALL_DIR/monofarm_agent.py"

# ── write config ──────────────────────────────────────────────────────────────

FRONTEND="${SERVER//:8000/:3000}"
cat > "$INSTALL_DIR/.env" <<EOF
MONOFARM_SERVER=${SERVER}
MONOFARM_FRONTEND=${FRONTEND}
MONOFARM_TOKEN=${TOKEN}
EOF
chmod 600 "$INSTALL_DIR/.env"
echo "Config written to $INSTALL_DIR/.env"

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
WorkingDirectory=${INSTALL_DIR}
ExecStart=${INSTALL_DIR}/venv/bin/python ${INSTALL_DIR}/monofarm_agent.py
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
    nohup "$VENV_PYTHON" "$INSTALL_DIR/monofarm_agent.py" \
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
    <string>${INSTALL_DIR}/monofarm_agent.py</string>
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
  nohup "$VENV_PYTHON" "$INSTALL_DIR/monofarm_agent.py" \
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
