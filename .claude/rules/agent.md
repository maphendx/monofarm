---
paths:
  - "agent/**"
  - "backend/app/api/agent.py"
  - "backend/app/api/agent_tg.py"
  - "backend/app/services/tunnel.py"
---

# Local farm agent

Long-form context in root `CLAUDE.md`. Rules specific to agent code:

## Version bump — three files, always together

When changing agent behaviour, bump `AGENT_VERSION` in **all three**:
- `agent/monofarm_agent.py` — `AGENT_VERSION = "x.y.z"`
- `agent/monofarm_tray.py` — `AGENT_VERSION = "x.y.z"`
- `backend/app/api/agent.py` — `AGENT_VERSION = "x.y.z"`

Forgetting one causes the agent to self-update in a loop.

## Wire protocol — do not change message shapes

Request/response envelope is fixed (used by both agent and backend tunnel):

```python
# Regular
server→agent: {"id": "…", "method": "GET|POST|…", "url": "…", "body": null}
agent→server: {"id": "…", "status": 200, "body": {…}, "error": null}

# Streaming (camera / mjpeg)
server→agent: {"id": "…", "method": "STREAM", "url": "…"}
agent→server: {"id": "…", "type": "stream_start", "status": 200}
agent→server: {"id": "…", "type": "chunk", "data": "<base64>"}  # repeated
agent→server: {"id": "…", "type": "stream_end"}

# Bambu camera
method: "BAMBU_CAMERA", body: {"dev_ip": "…", "access_code": "…"}
```

Adding new methods: implement backend dispatch in `tunnel.py`, agent dispatch in `agent/transports/websocket.py`, and the handler in the owning transport or printer module.

## Agent auth

Agent authenticates via `?token=<JWT>` query param on the WebSocket URL. The JWT is a regular user JWT — validated by `decode_token()` in `tunnel.py`. Do not add a separate auth scheme.

## Reconnect behaviour

Agent auto-reconnects every `RECONNECT_DELAY=5s` on disconnect. It also checks for updates every `UPDATE_INTERVAL=6h` via `GET /api/agent/version`. Do not add reconnect logic inside individual request handlers — it lives in the outer connection loop.

## Per-org TG bot (agent_tg.py)

`GET /api/agent/tg-config` → returns decrypted `tg_bot_token` + cached username for the org.
`POST /api/agent/tg-command` → handles bot commands and returns reply text (no network call from server — the agent sends the reply).
The agent runs a local `python-telegram-bot` instance using the per-org token. Do not call Telegram from `agent_tg.py` directly — return the text, the agent sends it.

## Config storage

Agent stores config in `~/.monofarm-agent/.env`. Never hardcode paths — always use `CONFIG_DIR / CONFIG_FILE`. On Windows the tray app (`monofarm_tray.py`) uses the same config dir. Writes go through the atomic `_write_config` / `save_config` (temp + `os.replace`) and **merge** existing keys — never overwrite the file with a subset (that once wiped `ALERT_CHAT_IDS`).

## One canonical loop — tray is a thin host

`monofarm_agent.run(server, token, *, on_state=None, run_updates=True)` is the single public loop hosted by the tray. `core/runtime.py` owns connection and reconnect lifecycle; `transports/websocket.py` owns server-message dispatch. The tray only adds GUI, local browser UI, autostart and discovery. Do not add a parallel dispatch loop to the facade or tray.

## Relay purity — nothing processed on our server

The agent is the smart edge: it receives commands and relays them to local printers, and receives printer state and relays it to the cloud. The server is **relay + cache only** — do not move printer/alert/photo processing onto the server. Failure-alert detection, camera snapshots and Telegram sending all happen on the agent (see [[project_printer_alerts]]).

## Distribution — exe-first on Windows

- Windows: a frozen PyInstaller **.exe** (`monofarm-agent.spec`, entry `monofarm_tray.py`). Built on a Windows CI runner (`.github/workflows/agent-build.yml`) — **cannot build on Linux/macOS** — and uploaded to R2 at `agent/monofarm-agent.exe`. Served by `GET /agent/monofarm-agent.exe` (302 → presigned). `install.ps1` is exe-first (no Python).
- Linux/Pi/dev: `install.sh` downloads `/agent/source.zip`. Keep every runtime source file in `agent/source_manifest.json`.
- Auto-update (`core/updates.py`) is frozen-aware: `.exe` self-swaps; source installs validate and replace the complete manifest tree, with `monofarm_agent.py` last. The facade bootstrap upgrades pre-0.8.16 flat installs. Still bump `AGENT_VERSION` in all three files together; tag `agent-v*` to publish a new exe.
