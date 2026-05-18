#!/usr/bin/env python3
"""monofarm-agent tray + browser UI.

Serves a local web UI at http://127.0.0.1:4747 — opens automatically in any browser.
Settings, live status, and log tail are all in the browser; no tkinter needed.

Tray icon: green = connected, yellow = connecting, grey = disconnected.
Right-click menu: Open Settings, Open Dashboard, Stop/Start Agent, Exit.

Dependencies:
    pip install pystray Pillow websockets httpx
"""
from __future__ import annotations

import asyncio
import base64
import collections
import json
import logging
import os
import pathlib
import platform
import ssl
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

try:
    import pystray
    from PIL import Image, ImageDraw
    import websockets
    import websockets.exceptions
    import httpx
except ImportError:
    print("Missing deps: pip install pystray Pillow websockets httpx")
    sys.exit(1)

# ── Constants ─────────────────────────────────────────────────────────────────

AGENT_VERSION      = "0.4.5"
UI_HTTP_PORT       = 4747   # browser navigates here for the HTML page
UI_WS_PORT         = 4748   # browser WebSocket connects here for live updates
CONFIG_DIR         = pathlib.Path.home() / ".monofarm-agent"
CONFIG_FILE        = CONFIG_DIR / ".env"
_DEFAULT_API_PORT  = "8000"
_DEFAULT_FE_PORT   = "3000"
RECONNECT_DELAY    = 5

log = logging.getLogger("monofarm")

# ── Config ────────────────────────────────────────────────────────────────────

def load_config() -> dict[str, str]:
    cfg = {"MONOFARM_SERVER": "https://monofarm.app", "MONOFARM_TOKEN": "", "MONOFARM_FRONTEND": ""}
    if CONFIG_FILE.exists():
        for line in CONFIG_FILE.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.startswith("#"):
                k, _, v = line.partition("=")
                cfg[k.strip()] = v.strip()
    return cfg


def save_config(server: str, token: str) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(
        f"MONOFARM_SERVER={server}\nMONOFARM_TOKEN={token}\n", encoding="utf-8"
    )
    try:
        CONFIG_FILE.chmod(0o600)
    except Exception:
        pass


def dashboard_url(server: str) -> str:
    import re
    cfg = load_config()
    if cfg.get("MONOFARM_FRONTEND"):
        return cfg["MONOFARM_FRONTEND"]
    m = re.search(r":(\d+)(/|$)", server)
    if m and m.group(1) == _DEFAULT_API_PORT:
        return server.replace(f":{_DEFAULT_API_PORT}", f":{_DEFAULT_FE_PORT}", 1)
    return server

# ── Autostart ─────────────────────────────────────────────────────────────────

def _autostart_path() -> pathlib.Path | None:
    if platform.system() == "Windows":
        startup = pathlib.Path(os.environ.get("APPDATA", "")) / \
                  "Microsoft/Windows/Start Menu/Programs/Startup"
        return startup / "monofarm-agent.bat"
    if platform.system() == "Darwin":
        return pathlib.Path.home() / "Library/LaunchAgents/app.monofarm.agent.plist"
    return None


def _is_autostart() -> bool:
    p = _autostart_path()
    return p is not None and p.exists()


def _set_autostart(enabled: bool) -> None:
    p = _autostart_path()
    if p is None:
        return
    if not enabled:
        if p.exists():
            p.unlink()
        return
    exe    = sys.executable
    script = pathlib.Path(__file__).resolve()
    if platform.system() == "Windows":
        p.write_text(f'@echo off\nstart "" "{exe}" "{script}"\n', encoding="utf-8")
    elif platform.system() == "Darwin":
        plist = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"'
            ' "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
            '<plist version="1.0"><dict>\n'
            '  <key>Label</key><string>app.monofarm.agent</string>\n'
            '  <key>ProgramArguments</key>\n'
            f'  <array><string>{exe}</string><string>{script}</string></array>\n'
            '  <key>RunAtLoad</key><true/>\n'
            '  <key>KeepAlive</key><true/>\n'
            '</dict></plist>\n'
        )
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(plist, encoding="utf-8")

# ── Tray icon ─────────────────────────────────────────────────────────────────

_COLORS = {
    "connected":    (34, 197, 94),
    "connecting":   (234, 179, 8),
    "disconnected": (107, 114, 128),
}


def _make_icon(state: str) -> Image.Image:
    size  = 64
    color = _COLORS.get(state, _COLORS["disconnected"])
    img   = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw  = ImageDraw.Draw(img)
    r     = size // 2 - 4
    cx, cy = size // 2, size // 2 - 2
    draw.ellipse([cx - r, cy - r, cx + r, cy + r + 4],      fill=color + (255,))
    draw.rectangle([cx - r, cy + 2, cx + r, cy + r + 10],   fill=color + (255,))
    for bx in [cx - r, cx - r // 3, cx + r // 3]:
        draw.ellipse([bx, cy + r + 4, bx + 10, cy + r + 14], fill=color + (255,))
    draw.ellipse([cx - 10, cy - 6, cx - 3,  cy + 2], fill=(255, 255, 255, 220))
    draw.ellipse([cx + 3,  cy - 6, cx + 10, cy + 2], fill=(255, 255, 255, 220))
    return img

# ── Log handler — broadcasts lines to browser WS clients ──────────────────────

class _BrowserLogHandler(logging.Handler):
    """Intercepts log records and forwards them to connected browser tabs."""

    def __init__(self) -> None:
        super().__init__()
        self._buf: collections.deque[str] = collections.deque(maxlen=300)
        self._app: App | None = None

    def attach(self, app: App) -> None:
        self._app = app

    def emit(self, record: logging.LogRecord) -> None:
        line = self.format(record)
        self._buf.append(line)
        if self._app:
            self._app.broadcast_log(line)

    @property
    def buf(self) -> list[str]:
        return list(self._buf)


_browser_log = _BrowserLogHandler()

# ── Central app (asyncio loop + agent + local WS server) ──────────────────────

class App:
    """
    Single background asyncio event loop that manages:
    - The agent tunnel (WebSocket client → monofarm cloud)
    - A local WebSocket server (port 4748) for browser control
    State changes are broadcast to all open browser tabs in real time.
    """

    def __init__(self) -> None:
        self.state          = "disconnected"
        self._loop:         asyncio.AbstractEventLoop | None = None
        self._ws_clients:   set = set()
        self._agent_task:   asyncio.Task | None = None
        self._printer_task: asyncio.Task | None = None
        self._printers:     list = []
        self.on_state_change: list = []

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def start_loop(self) -> None:
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        loop.run_until_complete(self._main())

    async def _main(self) -> None:
        _browser_log.attach(self)
        try:
            server = await websockets.serve(self._ws_handler, "0.0.0.0", UI_WS_PORT)
        except OSError as e:
            log.warning("Could not start local UI WebSocket on port %s: %s", UI_WS_PORT, e)
            server = None

        cfg = load_config()
        if cfg["MONOFARM_TOKEN"]:
            await self._do_start(cfg["MONOFARM_SERVER"], cfg["MONOFARM_TOKEN"])
            asyncio.create_task(self._update_loop(cfg["MONOFARM_SERVER"]))

        if server:
            async with server:
                await asyncio.Future()
        else:
            await asyncio.Future()

    async def _update_loop(self, server: str) -> None:
        while True:
            await _check_for_update(server)
            await asyncio.sleep(6 * 3600)

    async def _run_update_check(self, websocket) -> None:
        """Triggered by the browser's Update button."""
        cfg = load_config()
        await self._broadcast({"type": "update_status", "checking": True})
        try:
            await _check_for_update(cfg["MONOFARM_SERVER"])
            # If we reach here, no update was found (execv would have fired otherwise)
            await self._broadcast({"type": "update_status", "checking": False,
                                   "message": f"Already up to date (v{AGENT_VERSION})"})
        except Exception as e:
            await self._broadcast({"type": "update_status", "checking": False,
                                   "message": f"Error: {e}"})

    # ── Browser WebSocket handler ─────────────────────────────────────────────

    async def _ws_handler(self, websocket, path: str = "") -> None:
        self._ws_clients.add(websocket)
        try:
            cfg = load_config()
            await websocket.send(json.dumps({
                "type":      "init",
                "state":     self.state,
                "server":    cfg["MONOFARM_SERVER"],
                "token":     cfg["MONOFARM_TOKEN"],
                "autostart": _is_autostart(),
                "version":   AGENT_VERSION,
                "logs":      _browser_log.buf,
                "printers":  self._printers,
            }))
            async for raw in websocket:
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                t = msg.get("type")
                if t == "connect":
                    save_config(msg.get("server", ""), msg.get("token", ""))
                    if msg.get("autostart") is not None:
                        _set_autostart(bool(msg["autostart"]))
                    await self._do_start(msg["server"], msg["token"])
                elif t == "disconnect":
                    self._do_stop()
                elif t == "open_dashboard":
                    webbrowser.open(dashboard_url(load_config()["MONOFARM_SERVER"]))
                elif t == "check_update":
                    asyncio.create_task(self._run_update_check(websocket))
        finally:
            self._ws_clients.discard(websocket)

    async def _broadcast(self, payload: dict) -> None:
        if not self._ws_clients:
            return
        text = json.dumps(payload)
        await asyncio.gather(
            *(c.send(text) for c in list(self._ws_clients)),
            return_exceptions=True,
        )

    def broadcast_log(self, line: str) -> None:
        if self._loop and self._loop.is_running():
            asyncio.run_coroutine_threadsafe(
                self._broadcast({"type": "log", "line": line}), self._loop
            )

    def _set_state(self, state: str) -> None:
        self.state = state
        for cb in self.on_state_change:
            try:
                cb(state)
            except Exception:
                pass
        if self._loop and self._loop.is_running():
            asyncio.run_coroutine_threadsafe(
                self._broadcast({"type": "state_change", "state": state}), self._loop
            )

    # ── Agent lifecycle ───────────────────────────────────────────────────────

    async def _do_start(self, server: str, token: str) -> None:
        self._do_stop()
        self._agent_task   = asyncio.create_task(self._agent_loop(server, token))
        self._printer_task = asyncio.create_task(self._printer_loop(server, token))

    def _do_stop(self) -> None:
        if self._agent_task and not self._agent_task.done():
            self._agent_task.cancel()
        if self._printer_task and not self._printer_task.done():
            self._printer_task.cancel()
        self._printers = []
        self._set_state("disconnected")

    def start_agent(self, server: str, token: str) -> None:
        """Thread-safe: schedule agent start from tray callbacks."""
        if self._loop:
            asyncio.run_coroutine_threadsafe(self._do_start(server, token), self._loop)

    def stop_agent(self) -> None:
        """Thread-safe: stop agent from tray callbacks."""
        if self._loop:
            self._loop.call_soon_threadsafe(self._do_stop)

    # ── Printer discovery ─────────────────────────────────────────────────────

    async def _printer_loop(self, server: str, token: str) -> None:
        await asyncio.sleep(3)  # wait for agent to connect first
        while True:
            try:
                printers = await self._fetch_printers(server, token)
                self._printers = printers
                await self._broadcast({"type": "printers", "printers": printers})
            except asyncio.CancelledError:
                return
            except Exception as e:
                log.debug("Printer refresh error: %s", e)
            await asyncio.sleep(15)

    async def _fetch_printers(self, server: str, token: str) -> list:
        """Fetch printer list from backend, then check local reachability."""
        async with httpx.AsyncClient(timeout=8, verify=False) as client:
            r = await client.get(
                f"{server}/api/printers",
                headers={"Authorization": f"Bearer {token}"},
            )
            if r.status_code != 200:
                return []
            raw = r.json()

        # Run local reachability checks in parallel
        tasks = [self._check_local(p) for p in raw]
        return await asyncio.gather(*tasks, return_exceptions=False)

    async def _check_local(self, p: dict) -> dict:
        """Add local_ok + local_ms to a printer dict."""
        kind         = p.get("kind", "")
        moonraker_url = p.get("moonraker_url")
        bambu_ip      = p.get("bambu_dev_ip")

        local_ok = False
        local_ms = None
        try:
            import time
            t0 = time.monotonic()
            async with httpx.AsyncClient(timeout=2, verify=False) as cl:
                if moonraker_url:
                    base = moonraker_url.split("?")[0].rstrip("/")
                    await cl.get(f"{base}/printer/info")
                    local_ok = True
                elif bambu_ip:
                    # Bambu: just try TCP on port 8883 (MQTT)
                    _, writer = await asyncio.wait_for(
                        asyncio.open_connection(bambu_ip, 8883), timeout=2
                    )
                    writer.close()
                    local_ok = True
            local_ms = round((time.monotonic() - t0) * 1000)
        except Exception:
            pass

        return {**p, "local_ok": local_ok, "local_ms": local_ms}

    # ── Agent tunnel ──────────────────────────────────────────────────────────

    async def _agent_loop(self, server: str, token: str) -> None:
        ws_url = (
            server.replace("https://", "wss://").replace("http://", "ws://")
            + f"/api/agent/connect?token={token}"
        )
        while True:
            try:
                self._set_state("connecting")
                async with websockets.connect(
                    ws_url,
                    ping_interval=20,
                    ping_timeout=10,
                    open_timeout=15,
                    max_size=None,
                ) as ws:
                    self._set_state("connected")
                    log.info("Connected to monofarm cloud ✓  (waiting for requests…)")
                    async for message in ws:
                        try:
                            req = json.loads(message)
                        except Exception:
                            continue
                        method = req.get("method", "GET").upper()
                        if method == "BAMBU_CAMERA":
                            asyncio.create_task(_handle_bambu_camera(ws, req))
                        elif method == "FFMPEG_STREAM":
                            asyncio.create_task(_handle_ffmpeg_stream(ws, req))
                        elif method == "DISCOVER_BAMBU":
                            asyncio.create_task(_handle_discover_bambu(ws, req))
                        elif method == "BAMBU_UPLOAD":
                            asyncio.create_task(_handle_bambu_upload(ws, req))
                        elif method == "MOONRAKER_UPLOAD":
                            asyncio.create_task(_handle_moonraker_upload(ws, req))
                        elif method == "STREAM":
                            asyncio.create_task(_handle_stream(ws, req))
                        else:
                            asyncio.create_task(_handle_request(ws, req))

            except asyncio.CancelledError:
                return
            except websockets.exceptions.InvalidStatusCode as e:
                if e.status_code in (4001, 4002):
                    log.error("Authentication failed — check your token in the UI")
                    self._set_state("disconnected")
                    return
                log.warning("Server rejected connection (%s). Retrying in %ss…",
                            e.status_code, RECONNECT_DELAY)
                self._set_state("disconnected")
            except (OSError, websockets.exceptions.WebSocketException) as e:
                log.warning("Disconnected: %s. Retrying in %ss…", e, RECONNECT_DELAY)
                self._set_state("disconnected")
            except Exception as e:
                log.exception("Unexpected error: %s", e)
                self._set_state("disconnected")

            await asyncio.sleep(RECONNECT_DELAY)


# ── Auto-update ───────────────────────────────────────────────────────────────

async def _check_for_update(server: str) -> None:
    """Download monofarm_agent.py + monofarm_tray.py if a newer version is available, then restart."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{server}/api/agent/version")
            if resp.status_code != 200:
                return
            remote = resp.json().get("version", "")
            if not remote or remote == AGENT_VERSION:
                return
            log.info("Update available: %s → %s. Downloading…", AGENT_VERSION, remote)
            script_dir = pathlib.Path(__file__).parent
            for fname in ("monofarm_agent.py", "monofarm_tray.py"):
                r = await client.get(f"{server}/agent/{fname}")
                r.raise_for_status()
                (script_dir / fname).write_bytes(r.content)
            log.info("Updated to %s — restarting…", remote)
            os.execv(sys.executable, [sys.executable] + sys.argv)
    except Exception as e:
        log.debug("Update check skipped: %s", e)


# ── HTTP server — serves the browser UI page ──────────────────────────────────

def _start_http_server() -> None:
    html = _HTML_BYTES

    class _H(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(html)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(html)

        def log_message(self, *_) -> None:
            pass

    srv = HTTPServer(("0.0.0.0", UI_HTTP_PORT), _H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    log.info("Agent UI at http://127.0.0.1:%s", UI_HTTP_PORT)


# ── Request handlers (imported from core agent) ───────────────────────────────

# Add the agent directory to path so we can import handlers without duplication.
sys.path.insert(0, str(pathlib.Path(__file__).parent))

try:
    from monofarm_agent import (  # type: ignore
        handle_request        as _handle_request,
        handle_stream         as _handle_stream,
        handle_bambu_camera   as _handle_bambu_camera,
        handle_ffmpeg_stream  as _handle_ffmpeg_stream,
        handle_discover_bambu as _handle_discover_bambu,
        handle_bambu_upload   as _handle_bambu_upload,
        handle_moonraker_upload as _handle_moonraker_upload,
    )
except ImportError:
    log.warning("monofarm_agent.py not found — proxy handlers unavailable")

    async def _stub(ws, req):  # type: ignore
        await ws.send(json.dumps({"id": req.get("id"), "status": 503,
                                  "body": None, "error": "agent not loaded"}))

    _handle_request = _handle_stream = _handle_bambu_camera = _stub
    _handle_ffmpeg_stream = _handle_discover_bambu = _stub
    _handle_bambu_upload = _handle_moonraker_upload = _stub


# ── Browser UI HTML ───────────────────────────────────────────────────────────

_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>monofarm agent</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --green:#22c55e;--yellow:#eab308;--red:#ef4444;--blue:#60a5fa;
  --bg:#080808;--card:#111;--border:#1e1e1e;--input:#161616;
  --text:#e5e7eb;--muted:#6b7280;--dim:#4b5563
}
body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif;min-height:100vh;padding:24px 16px}
.wrap{max-width:760px;margin:0 auto}

/* Header */
.hdr{display:flex;align-items:center;gap:10px;margin-bottom:20px}
.logo{font-family:'Courier New',monospace;font-size:18px;font-weight:700;color:#fff}
.logo em{color:#333;font-style:normal;font-weight:400}
.ver{font-size:11px;color:var(--dim);background:#111;border:1px solid #222;border-radius:4px;padding:2px 7px}
.hdr-right{margin-left:auto;display:flex;align-items:center;gap:8px}

/* Toast */
.toast{font-size:11px;color:var(--dim);transition:opacity .3s}
.toast.show{color:var(--green)}

/* Card */
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px 18px;margin-bottom:12px}
.card-title{font-size:10px;font-weight:700;color:var(--dim);text-transform:uppercase;letter-spacing:.1em;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between}

/* Top row: status + quick actions */
.top-row{display:flex;gap:12px;margin-bottom:12px}
.top-row .card{flex:1;margin-bottom:0}
.s-row{display:flex;align-items:center;gap:9px}
.dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}
.dot.connected{background:var(--green);box-shadow:0 0 7px #22c55e55}
.dot.connecting{background:var(--yellow);animation:blink 1.1s ease-in-out infinite}
.dot.disconnected,.dot.offline{background:#2a2a2a}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
.s-label{font-size:14px;font-weight:500}
.s-label.connected{color:var(--green)}
.s-label.connecting{color:var(--yellow)}
.s-label.disconnected,.s-label.offline{color:var(--dim)}

/* Settings (collapsible) */
.settings-body{display:none}
.settings-body.open{display:block}
.field{margin-bottom:11px}
.lbl{display:block;font-size:11px;color:var(--muted);margin-bottom:4px}
.inp{width:100%;background:var(--input);border:1px solid #252525;border-radius:6px;color:#fff;font-size:13px;padding:7px 10px;outline:none;transition:border-color .15s}
.inp:focus{border-color:#444}
.inp-row{display:flex;gap:6px}
.inp-row .inp{flex:1;min-width:0}
.chk-row{display:flex;align-items:center;gap:7px;cursor:pointer;margin-top:2px}
.chk-row input{accent-color:var(--green);width:13px;height:13px;cursor:pointer}
.chk-row span{font-size:12px;color:var(--muted)}
.btns{display:flex;gap:7px;margin-top:14px;flex-wrap:wrap;align-items:center}

/* Buttons */
.btn{padding:7px 14px;border:none;border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;transition:opacity .15s;white-space:nowrap;line-height:1}
.btn:hover{opacity:.8}
.btn:disabled{opacity:.4;cursor:default}
.btn-primary{background:#fff;color:#111}
.btn-danger{background:#161616;color:var(--red);border:1px solid #252525}
.btn-link{background:#161616;color:var(--blue);border:1px solid #252525}
.btn-ghost{background:transparent;color:var(--dim);border:1px solid #252525;font-size:11px;padding:5px 10px}
.btn-ghost:hover{color:#fff}
.btn-ml{margin-left:auto}
.show-btn{background:#161616;border:1px solid #252525;color:var(--muted);border-radius:6px;padding:0 11px;font-size:12px;cursor:pointer;flex-shrink:0}
.show-btn:hover{color:#fff}

/* Printers grid */
.p-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
@media(max-width:600px){.p-grid{grid-template-columns:repeat(2,1fr)}}
.p-card{background:#0d0d0d;border:1px solid #1a1a1a;border-radius:8px;padding:10px 12px;min-width:0}
.p-card.local{border-color:#1a2a1a}
.p-head{display:flex;align-items:center;gap:7px;margin-bottom:5px}
.p-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.p-dot.ok{background:var(--green);box-shadow:0 0 4px #22c55e55}
.p-dot.nok{background:#222}
.p-name{font-size:13px;font-weight:600;color:#e5e7eb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.p-state{font-size:10px;font-weight:600;border-radius:3px;padding:1px 5px;flex-shrink:0}
.p-state.printing{background:#0c1a2e;color:var(--blue)}
.p-state.paused{background:#1a1400;color:var(--yellow)}
.p-state.error{background:#1a0000;color:var(--red)}
.p-state.offline{background:#111;color:#333}
.p-state.idle,.p-state.operational,.p-state.unknown{background:#111;color:#4b5563}
.p-job{font-size:10px;color:#374151;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:3px}
.p-meta{font-size:10px;color:#2a2a2a}
.p-meta.local{color:#374151}

/* Log */
.log-box{background:#060606;border:1px solid #181818;border-radius:6px;height:160px;overflow-y:auto;padding:8px 11px;font-family:'Courier New',monospace;font-size:11px;line-height:1.65}
.l{white-space:pre-wrap;word-break:break-all}
.l.info{color:#374151}
.l.warn{color:#6b3a00}
.l.error{color:#6b0000}

/* Offline bar */
.offline-bar{text-align:center;font-size:12px;color:#333;padding:8px;background:#0d0d0d;border:1px solid #181818;border-radius:7px;margin-bottom:12px;display:none}
.offline-bar.show{display:block}

/* Toggle arrow */
.toggle-arrow{font-size:10px;cursor:pointer;color:var(--dim);user-select:none;padding:2px 6px}
.toggle-arrow:hover{color:#fff}
</style>
</head>
<body>
<div class="wrap">

  <div class="hdr">
    <div class="logo">monofarm <em>agent</em></div>
    <div class="ver" id="ver">v—</div>
    <div class="hdr-right">
      <span class="toast" id="toast"></span>
      <button class="btn btn-ghost" id="btn-update" onclick="checkUpdate()">↻ Update</button>
      <button class="btn btn-link" onclick="openDash()">Dashboard ↗</button>
    </div>
  </div>

  <div class="offline-bar" id="offline-bar">agent UI offline — retrying…</div>

  <div class="top-row">
    <div class="card" style="min-width:0">
      <div class="card-title" style="margin-bottom:10px">Status</div>
      <div class="s-row">
        <div class="dot disconnected" id="dot"></div>
        <div class="s-label disconnected" id="slabel">Disconnected</div>
      </div>
    </div>
    <div class="card" style="min-width:0;display:flex;flex-direction:column;justify-content:space-between">
      <div class="card-title" style="margin-bottom:10px">
        <span>Settings</span>
        <span class="toggle-arrow" onclick="toggleSettings()" id="settings-arrow">▼ show</span>
      </div>
      <div class="btns" style="margin-top:0">
        <button class="btn btn-primary" onclick="doConnect()">Connect</button>
        <button class="btn btn-danger" onclick="doDisconnect()">Disconnect</button>
      </div>
    </div>
  </div>

  <div class="card settings-body" id="settings-body">
    <div class="field">
      <label class="lbl">Server URL</label>
      <input class="inp" id="inp-server" type="text" placeholder="https://monofarm.app">
    </div>
    <div class="field">
      <label class="lbl">Token</label>
      <div class="inp-row">
        <input class="inp" id="inp-token" type="password" placeholder="eyJ…">
        <button class="show-btn" onclick="toggleTok(this)">Show</button>
      </div>
    </div>
    <label class="chk-row">
      <input type="checkbox" id="inp-autostart">
      <span>Start with system</span>
    </label>
    <div class="btns">
      <button class="btn btn-primary" onclick="doConnect()">Save & Connect</button>
    </div>
  </div>

  <div class="card" id="printers-card" style="display:none">
    <div class="card-title">
      <span>Printers</span>
      <span id="printer-count" style="font-weight:400;text-transform:none;letter-spacing:0;font-size:11px"></span>
    </div>
    <div class="p-grid" id="printers-list"></div>
  </div>

  <div class="card">
    <div class="card-title">Log</div>
    <div class="log-box" id="log"></div>
  </div>

</div>
<script>
const WS_PORT = """ + str(UI_WS_PORT) + r""";
let ws, reconnTimer;

function connect() {
  clearTimeout(reconnTimer);
  try {
    ws = new WebSocket(`ws://${location.hostname}:${WS_PORT}`);
    ws.onopen = () => document.getElementById('offline-bar').classList.remove('show');
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.type === 'init') {
        document.getElementById('ver').textContent       = 'v' + (m.version || '?');
        document.getElementById('inp-server').value      = m.server || '';
        document.getElementById('inp-token').value       = m.token  || '';
        document.getElementById('inp-autostart').checked = !!m.autostart;
        setState(m.state);
        (m.logs || []).forEach(addLog);
        renderPrinters(m.printers || []);
      } else if (m.type === 'state_change') {
        setState(m.state);
      } else if (m.type === 'log') {
        addLog(m.line);
      } else if (m.type === 'printers') {
        renderPrinters(m.printers || []);
      } else if (m.type === 'update_status') {
        const btn = document.getElementById('btn-update');
        btn.disabled = m.checking;
        btn.textContent = m.checking ? '↻ Checking…' : '↻ Update';
        if (m.message) showToast(m.message);
      }
    };
    ws.onclose = () => {
      document.getElementById('offline-bar').classList.add('show');
      setState('offline');
      reconnTimer = setTimeout(connect, 2000);
    };
    ws.onerror = () => ws.close();
  } catch(e) { reconnTimer = setTimeout(connect, 2000); }
}

function setState(s) {
  const dot = document.getElementById('dot');
  const lbl = document.getElementById('slabel');
  const n = {connected:'Connected',connecting:'Connecting…',disconnected:'Disconnected',offline:'Agent offline'};
  dot.className = 'dot ' + s;
  lbl.className = 's-label ' + s;
  lbl.textContent = n[s] || s;
}

function addLog(line) {
  const box = document.getElementById('log');
  const d = document.createElement('div');
  d.className = 'l ' + (/ERROR/.test(line) ? 'error' : /WARNING/.test(line) ? 'warn' : 'info');
  d.textContent = line;
  box.appendChild(d);
  while (box.children.length > 500) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function doConnect() {
  const s = document.getElementById('inp-server').value.trim();
  const t = document.getElementById('inp-token').value.trim();
  const a = document.getElementById('inp-autostart').checked;
  if (!t) { alert('Token is required'); return; }
  send({type:'connect', server:s, token:t, autostart:a});
}
function doDisconnect() { send({type:'disconnect'}); }
function openDash()      { send({type:'open_dashboard'}); }
function checkUpdate()   { send({type:'check_update'}); document.getElementById('btn-update').disabled=true; document.getElementById('btn-update').textContent='↻ Checking…'; }

function toggleSettings() {
  const body  = document.getElementById('settings-body');
  const arrow = document.getElementById('settings-arrow');
  const open  = body.classList.toggle('open');
  arrow.textContent = open ? '▲ hide' : '▼ show';
}

function toggleTok(btn) {
  const inp = document.getElementById('inp-token');
  const h = inp.type === 'password';
  inp.type = h ? 'text' : 'password';
  btn.textContent = h ? 'Hide' : 'Show';
}

let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); t.textContent=''; }, 4000);
}

function cleanJob(job) {
  if (!job) return '';
  job = job.replace(/^cache\//, '');
  job = job.replace(/\.3mf\.3mf$/, '.3mf');
  job = job.replace(/\.gcode\.3mf$/, '.3mf');
  job = job.replace(/_(?:PLA|PETG|ABS|TPU|ASA|PC|FLEX|SILK|WOOD)_\d.*$/, '');
  return job.length > 28 ? job.slice(0, 26) + '…' : job;
}

function renderPrinters(list) {
  const card  = document.getElementById('printers-card');
  const cont  = document.getElementById('printers-list');
  const count = document.getElementById('printer-count');
  if (!list || !list.length) { card.style.display = 'none'; return; }
  card.style.display = '';
  const printing = list.filter(p => p.state === 'printing').length;
  const online   = list.filter(p => p.local_ok).length;
  count.textContent = `${printing} printing · ${online}/${list.length} local`;
  cont.innerHTML = list.map(p => {
    const isBambu = (p.kind || '').includes('bambu');
    const ip      = p.bambu_dev_ip || (p.moonraker_url ? p.moonraker_url.replace(/https?:\/\//, '').split(/[/?]/)[0] : '');
    const state   = p.state || 'unknown';
    const job     = cleanJob(p.job || '');
    const ms      = p.local_ms ? `${ip} · ${p.local_ms}ms` : ip;
    return `<div class="p-card${p.local_ok ? ' local' : ''}">
      <div class="p-head">
        <div class="p-dot ${p.local_ok ? 'ok' : 'nok'}"></div>
        <div class="p-name">${p.name || 'Printer'}</div>
        <div class="p-state ${state}">${state}</div>
      </div>
      ${job ? `<div class="p-job">${job}</div>` : ''}
      <div class="p-meta${p.local_ok ? ' local' : ''}">${ms || (isBambu ? 'Bambu Cloud' : '—')}</div>
    </div>`;
  }).join('');
}

connect();
</script>
</body>
</html>
"""

_HTML_BYTES = _HTML.encode()


# ── Tray ──────────────────────────────────────────────────────────────────────

app = App()


def _open_ui() -> None:
    webbrowser.open(f"http://127.0.0.1:{UI_HTTP_PORT}")


def _build_menu(icon: pystray.Icon) -> pystray.Menu:
    state      = app.state
    state_text = {"connected": "Connected", "connecting": "Connecting…", "disconnected": "Disconnected"}
    return pystray.Menu(
        pystray.MenuItem(state_text.get(state, state), None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Open Settings…", lambda _i, _it: _open_ui()),
        pystray.MenuItem("Open Dashboard", lambda _i, _it: webbrowser.open(
            dashboard_url(load_config()["MONOFARM_SERVER"]))),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem(
            "Stop Agent" if app.state != "disconnected" else "Start Agent",
            lambda _i, _it: (
                app.stop_agent() if app.state != "disconnected"
                else app.start_agent(load_config()["MONOFARM_SERVER"], load_config()["MONOFARM_TOKEN"])
            ),
        ),
        pystray.MenuItem("Exit", lambda _i, _it: (app.stop_agent(), icon.stop())),
    )


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)

    fmt = logging.Formatter("%(asctime)s %(levelname)s: %(message)s", datefmt="%H:%M:%S")
    _browser_log.setFormatter(fmt)

    root_log = logging.getLogger()
    root_log.setLevel(logging.INFO)
    root_log.addHandler(_browser_log)

    stream_h = logging.StreamHandler()
    stream_h.setFormatter(fmt)
    root_log.addHandler(stream_h)

    try:
        file_h = logging.FileHandler(CONFIG_DIR / "agent.log", encoding="utf-8")
        file_h.setFormatter(fmt)
        root_log.addHandler(file_h)
    except Exception:
        pass

    _start_http_server()
    app.start_loop()

    icon = pystray.Icon(
        "monofarm",
        icon=_make_icon("disconnected"),
        title="monofarm Agent",
        menu=pystray.Menu(lambda: _build_menu(icon)),
    )

    def _on_state(state: str) -> None:
        icon.icon  = _make_icon(state)
        icon.title = f"monofarm — {state.capitalize()}"

    app.on_state_change.append(_on_state)

    cfg = load_config()
    if not cfg["MONOFARM_TOKEN"]:
        # First run — open browser so the user can enter their token
        threading.Timer(1.2, _open_ui).start()

    icon.run()


if __name__ == "__main__":
    main()
