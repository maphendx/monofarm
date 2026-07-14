# monofarm — Agent Briefing (updated 2026-07-14)

> Current architecture and operations: [AGENT_RUNTIME_V2.md](AGENT_RUNTIME_V2.md).
> This briefing retains camera notes; authentication and dispatch now use the
> Agent v2 runtime described there.

## Camera — DONE ✅

Bambu A1/P1 camera works via native binary TLS protocol (port 6000):
- 80-byte auth: `[0x40,0,0,0, 0x3000 LE, 0,0,0,0, "bblp"×32bytes, access_code×32bytes]`
- Frames: 16-byte header `[payload_size LE, itrack=0, flags=1, reserved=0]` + JPEG
- No LAN mode required. No FFmpeg. No go2rtc.
- Agent handles via `BAMBU_CAMERA` WebSocket method (in monofarm_tray.py + monofarm_agent.py)
- Camera opens ON DEMAND (toggle button, not auto-load)

X1/H2D: RTSPS port 322 via FFmpeg (requires LAN Liveview on printer)

Source: github.com/Doridian/OpenBambuAPI/blob/main/video.md

## Architecture

Browser ← Backend :8000 ← WS tunnel ← Agent (farm PC) ← Printer LAN

Typed commands use Backend → durable command lease → Agent SQLite journal →
fixed provider adapter → printer. The WebSocket tunnel remains for live state,
cameras, discovery and the v1 migration path.

## Credentials

Never store production emails, passwords, LAN access codes, tokens or private
addresses in tracked documentation. Use the deployment secret manager and the
local agent config. Any credential previously committed here must be rotated.

## Pending

Paddle billing verification (need domain + /pricing /terms /privacy /refund pages)
Warehouse Phase 1
Production deploy
