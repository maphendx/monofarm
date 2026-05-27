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

Adding new methods: implement in `tunnel.py` dispatch and the corresponding agent handler in `monofarm_agent.py`.

## Agent auth

Agent authenticates via `?token=<JWT>` query param on the WebSocket URL. The JWT is a regular user JWT — validated by `decode_token()` in `tunnel.py`. Do not add a separate auth scheme.

## Reconnect behaviour

Agent auto-reconnects every `RECONNECT_DELAY=5s` on disconnect. It also checks for updates every `UPDATE_INTERVAL=6h` via `GET /api/agent/version`. Do not add reconnect logic inside individual request handlers — it lives in the outer connection loop.

## Per-org TG bot (agent_tg.py)

`GET /api/agent/tg-config` → returns decrypted `tg_bot_token` + cached username for the org.
`POST /api/agent/tg-command` → handles bot commands and returns reply text (no network call from server — the agent sends the reply).
The agent runs a local `python-telegram-bot` instance using the per-org token. Do not call Telegram from `agent_tg.py` directly — return the text, the agent sends it.

## Config storage

Agent stores config in `~/.monofarm-agent/.env`. Never hardcode paths — always use `CONFIG_DIR / CONFIG_FILE`. On Windows the tray app (`monofarm_tray.py`) uses the same config dir.
