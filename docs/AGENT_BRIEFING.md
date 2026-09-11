# monofarm — Agent Briefing (updated 2026-05-18)

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

Agent methods: GET/POST (HTTP proxy), STREAM (httpx), BAMBU_CAMERA, FFMPEG_STREAM, DISCOVER_BAMBU

## Credentials

Credentials and printer access codes must not be stored in this repository.
Previously documented credentials require rotation if they were ever active;
removing this section does not remove them from Git history or existing copies.
Use a secret manager and per-environment configuration.

## Pending

Paddle billing verification (need domain + /pricing /terms /privacy /refund pages)
Warehouse Phase 1
Production deploy
