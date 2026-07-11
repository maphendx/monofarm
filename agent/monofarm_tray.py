#!/usr/bin/env python3
"""monofarm-agent tray + browser UI.

Serves a local web UI at http://127.0.0.1:4747 — opens automatically in any browser.
Settings, live status, and log tail are all in the browser; no tkinter needed.

Tray icon: green = connected, yellow = connecting, grey = disconnected.
Right-click menu: Open Settings, Open Dashboard, Stop/Start Agent, Exit.

Dependencies:
    pip install pystray Pillow websockets httpx paho-mqtt
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

AGENT_VERSION      = "0.8.3"
UI_HTTP_PORT       = 4747   # browser navigates here for the HTML page
UI_WS_PORT         = 4748   # browser WebSocket connects here for live updates
CONFIG_DIR         = pathlib.Path.home() / ".monofarm-agent"
CONFIG_FILE        = CONFIG_DIR / ".env"
_DEFAULT_API_PORT  = "8000"
_DEFAULT_FE_PORT   = "3000"

log = logging.getLogger("monofarm")

# ── Config ────────────────────────────────────────────────────────────────────

def load_config() -> dict[str, str]:
    cfg = {"MONOFARM_SERVER": "https://api.monofarm.app", "MONOFARM_TOKEN": "", "MONOFARM_FRONTEND": "https://monofarm.app"}
    if CONFIG_FILE.exists():
        for line in CONFIG_FILE.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.startswith("#"):
                k, _, v = line.partition("=")
                cfg[k.strip()] = v.strip()
    return cfg


def save_config(server: str, token: str) -> None:
    """Persist server+token, preserving other keys (FRONTEND, ALERT_CHAT_IDS).

    Atomic (temp + os.replace) so a crash can't truncate the config. Merging is
    essential — a naive overwrite would wipe ALERT_CHAT_IDS set via the bot.
    """
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    cfg = load_config()
    cfg["MONOFARM_SERVER"] = server
    cfg["MONOFARM_TOKEN"]  = token
    data = "".join(f"{k}={v}\n" for k, v in cfg.items() if v != "")
    tmp = CONFIG_DIR / ".env.tmp"
    tmp.write_text(data, encoding="utf-8")
    try:
        tmp.chmod(0o600)
    except Exception:
        pass
    os.replace(tmp, CONFIG_FILE)


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
    frozen = getattr(sys, "frozen", False)
    # Frozen .exe: launch the exe directly. Source: launch the interpreter + script.
    script = "" if frozen else str(pathlib.Path(__file__).resolve())
    if platform.system() == "Windows":
        arg = "" if frozen else f' "{script}"'
        p.write_text(f'@echo off\nstart "" "{exe}"{arg}\n', encoding="utf-8")
    elif platform.system() == "Darwin":
        prog_args = f'<string>{exe}</string>' if frozen else f'<string>{exe}</string><string>{script}</string>'
        plist = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"'
            ' "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
            '<plist version="1.0"><dict>\n'
            '  <key>Label</key><string>app.monofarm.agent</string>\n'
            '  <key>ProgramArguments</key>\n'
            f'  <array>{prog_args}</array>\n'
            '  <key>RunAtLoad</key><true/>\n'
            '  <key>KeepAlive</key><true/>\n'
            '</dict></plist>\n'
        )
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(plist, encoding="utf-8")

# ── Tray icon ─────────────────────────────────────────────────────────────────

# Farm Grid icon: 8 outer dots + filled center on a 24×24 virtual grid.
# Supersampled 4× (96px) then downscaled to 64px for crisp rendering.
_FARM_OUTER = [
    (5, 5), (12, 5), (19, 5),
    (5, 12),         (19, 12),
    (5, 19), (12, 19), (19, 19),
]
_FARM_CENTER = (12, 12)

_C_ACCENT = (34, 211, 238)    # --accent
_C_OK     = (34, 197, 94)     # --state-ok
_C_GREY   = (107, 114, 128)   # --state-idle
_C_DIM    = (63,  63,  70)    # very dim
_C_ERR    = (239, 68,  68)    # --state-error


def _make_icon(state: str) -> Image.Image:
    scale = 4                        # supersampling factor
    work  = 24 * scale               # 96px working canvas
    img   = Image.new("RGBA", (work, work), (0, 0, 0, 0))
    draw  = ImageDraw.Draw(img)

    r_outer  = round(1.6 * scale)
    r_center = round(2.6 * scale)

    if state == "connected":
        outer_col  = _C_ACCENT + (210,)
        center_col = _C_ACCENT + (255,)
        slash      = False
        alert      = False
    elif state == "connecting":
        outer_col  = _C_GREY + (160,)
        center_col = _C_ACCENT + (180,)
        slash      = False
        alert      = False
    elif state == "alert":
        outer_col  = _C_GREY + (180,)
        center_col = _C_GREY + (200,)
        slash      = False
        alert      = True
    else:  # disconnected / offline
        outer_col  = _C_DIM + (140,)
        center_col = _C_DIM + (160,)
        slash      = True
        alert      = False

    for gx, gy in _FARM_OUTER:
        cx = round(gx * scale)
        cy = round(gy * scale)
        draw.ellipse([cx - r_outer, cy - r_outer, cx + r_outer, cy + r_outer],
                     fill=outer_col)

    ccx, ccy = round(_FARM_CENTER[0] * scale), round(_FARM_CENTER[1] * scale)
    draw.ellipse([ccx - r_center, ccy - r_center, ccx + r_center, ccy + r_center],
                 fill=center_col)

    if alert:
        ax, ay = round(19 * scale), round(5 * scale)
        draw.ellipse([ax - r_outer, ay - r_outer, ax + r_outer, ay + r_outer],
                     fill=_C_ERR + (240,))

    if slash:
        lw = max(2, round(1.5 * scale))
        draw.line([(round(5*scale), round(5*scale)), (round(19*scale), round(19*scale))],
                  fill=_C_ERR + (160,), width=lw)

    return img.resize((64, 64), Image.LANCZOS)

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

        if server:
            async with server:
                await asyncio.Future()
        else:
            await asyncio.Future()

    async def _run_update_check(self, websocket) -> None:
        """Triggered by the browser's Update button — delegates to the agent."""
        cfg = load_config()
        await self._broadcast({"type": "update_status", "checking": True})
        try:
            if monofarm_agent:
                await monofarm_agent.check_for_update(cfg["MONOFARM_SERVER"])
            # If we reach here, no update was found (a restart would have fired otherwise)
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
                elif t == "claim_printer":
                    asyncio.create_task(self._do_claim_printer(msg.get("dev_id", ""), websocket))
                elif t == "claim_moonraker":
                    asyncio.create_task(self._do_claim_moonraker(msg.get("url", ""), msg.get("name", "Klipper Printer"), websocket))
                elif t == "login":
                    asyncio.create_task(self._do_login(msg.get("email", ""), msg.get("password", ""), msg.get("server", ""), websocket))
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
        if monofarm_agent is None:
            log.error("Cannot start: monofarm_agent module not loaded")
            self._set_state("disconnected")
            return
        # Host the agent's canonical relay loop; on_state drives the tray icon + UI.
        self._agent_task   = asyncio.create_task(
            monofarm_agent.run(server, token, on_state=self._on_agent_state)
        )
        self._printer_task = asyncio.create_task(self._printer_loop(server, token))

    def _on_agent_state(self, state: str) -> None:
        """Reflect the agent's connection state on the tray icon + local UI."""
        self._set_state(state)

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
        """Fetch claimed printers + undiscovered Bambu/Moonraker devices from backend."""
        headers = {"Authorization": f"Bearer {token}"}
        async with httpx.AsyncClient(timeout=8, verify=False) as client:
            lan_bambu = []
            try:
                rb = await client.get(f"{server}/api/printers/bambu-discover", headers=headers)
                if rb.status_code == 200:
                    data = rb.json() or []
                    lan_bambu = data.get("devices") if isinstance(data, dict) else data
                    if not isinstance(lan_bambu, list):
                        lan_bambu = []
            except Exception as exc:
                log.debug("Bambu LAN discovery skipped: %s", exc)
            r   = await client.get(f"{server}/api/printers", headers=headers)
            raw = r.json() if r.status_code == 200 else []
            rd  = await client.get(f"{server}/api/printers/bambu/discovered", headers=headers)
            disc_bambu = rd.json() if rd.status_code == 200 else []
            rm  = await client.get(f"{server}/api/printers/moonraker/discovered", headers=headers)
            disc_moon = rm.json() if rm.status_code == 200 else []

        claimed = await asyncio.gather(*[self._check_local(p) for p in raw], return_exceptions=False)
        known_bambu_ids = {p.get("bambu_dev_id") for p in raw if p.get("bambu_dev_id")}
        cloud_disc_ids = {d.get("dev_id") for d in disc_bambu if d.get("dev_id")}
        unclaimed_bambu = [
            {"dev_id": d["dev_id"], "name": d.get("name") or d["dev_id"], "model": d.get("model", ""),
             "bambu_dev_ip": d.get("ip"), "kind": "bambu", "claimed": False, "local_ok": bool(d.get("ip")), "local_ms": None}
            for d in disc_bambu
        ]
        unclaimed_bambu.extend(
            {"dev_id": d["dev_id"], "name": d.get("name") or d["dev_id"], "model": d.get("model", ""),
             "bambu_dev_ip": d.get("ip"), "kind": "bambu", "claimed": False, "local_ok": bool(d.get("ip")), "local_ms": None}
            for d in lan_bambu
            if d.get("dev_id") and d.get("dev_id") not in known_bambu_ids and d.get("dev_id") not in cloud_disc_ids
        )
        unclaimed_moon = [
            {"url": d["url"], "name": d.get("name", "Klipper Printer"),
             "kind": "moonraker", "claimed": False, "local_ok": False, "local_ms": None}
            for d in disc_moon
        ]
        return [{**p, "claimed": True} for p in claimed] + unclaimed_bambu + unclaimed_moon

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

    async def _do_claim_printer(self, dev_id: str, websocket) -> None:
        cfg = load_config()
        try:
            async with httpx.AsyncClient(timeout=10, verify=False) as client:
                r = await client.post(
                    f"{cfg['MONOFARM_SERVER']}/api/printers/bambu/claim",
                    headers={"Authorization": f"Bearer {cfg['MONOFARM_TOKEN']}"},
                    json={"dev_id": dev_id},
                )
            if r.status_code in (200, 201):
                log.info("Bambu printer %s added to monofarm", dev_id)
                printers = await self._fetch_printers(cfg["MONOFARM_SERVER"], cfg["MONOFARM_TOKEN"])
                self._printers = printers
                await self._broadcast({"type": "printers", "printers": printers})
            else:
                err = (r.json().get("detail", "Error") if r.content else "Error")
                log.warning("Claim failed for %s: %s", dev_id, err)
                await websocket.send(json.dumps({"type": "claim_err", "dev_id": dev_id, "error": err}))
        except Exception as e:
            log.warning("Claim error: %s", e)

    async def _do_claim_moonraker(self, url: str, name: str, websocket) -> None:
        cfg = load_config()
        try:
            async with httpx.AsyncClient(timeout=10, verify=False) as client:
                r = await client.post(
                    f"{cfg['MONOFARM_SERVER']}/api/printers/moonraker/claim",
                    headers={"Authorization": f"Bearer {cfg['MONOFARM_TOKEN']}"},
                    json={"url": url, "name": name},
                )
            if r.status_code in (200, 201):
                log.info("Moonraker printer %s added to monofarm", url)
                printers = await self._fetch_printers(cfg["MONOFARM_SERVER"], cfg["MONOFARM_TOKEN"])
                self._printers = printers
                await self._broadcast({"type": "printers", "printers": printers})
            else:
                err = (r.json().get("detail", "Error") if r.content else "Error")
                log.warning("Claim moonraker failed for %s: %s", url, err)
                await websocket.send(json.dumps({"type": "claim_err", "dev_id": url, "error": err}))
        except Exception as e:
            log.warning("Claim moonraker error: %s", e)

    async def _do_login(self, email: str, password: str, server: str, websocket) -> None:
        try:
            async with httpx.AsyncClient(timeout=10, verify=False) as client:
                r = await client.post(
                    f"{server}/api/auth/login",
                    json={"email": email, "password": password},
                )
            if r.status_code == 200:
                token = r.json().get("access_token", "")
                save_config(server, token)
                await websocket.send(json.dumps({"type": "login_ok", "token": token}))
                await self._do_start(server, token)
            else:
                err = (r.json().get("detail", "Invalid credentials") if r.content else "Login failed")
                await websocket.send(json.dumps({"type": "login_err", "error": err}))
        except Exception as e:
            await websocket.send(json.dumps({"type": "login_err", "error": str(e)}))

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


# ── Core agent (single source of truth for the relay loop) ────────────────────

# Host the agent's canonical run() loop instead of duplicating WebSocket dispatch
# (the old duplicate drifted and silently dropped the Telegram bot, Moonraker
# live state and failure alerts on Windows). The tray now only adds the GUI.
sys.path.insert(0, str(pathlib.Path(__file__).parent))

try:
    import monofarm_agent  # type: ignore
except Exception as exc:  # pragma: no cover
    monofarm_agent = None  # type: ignore
    log.warning("monofarm_agent.py not importable: %s", exc)


# ── Browser UI HTML ───────────────────────────────────────────────────────────

_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>monofarm agent</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --accent:#22d3ee;--state-ok:#22c55e;--state-warn:#f59e0b;--state-error:#ef4444;--state-idle:#71717a;
  --bg:#0c0c0e;--surface:#141416;--surface-hi:#1c1c1f;--card:#1a1a1e;
  --border:rgba(255,255,255,.06);--border-strong:rgba(255,255,255,.12);--input:#0f0f12;
  --text:#e4e4e7;--text-muted:#a1a1aa;--text-faint:#52525b;--text-dim:#71717a
}
html,body{height:100%;overflow:hidden}
body{background:var(--bg);color:var(--text);font-family:'IBM Plex Sans',system-ui,-apple-system,sans-serif;display:flex;flex-direction:column}

/* ── TOP BAR ── */
.topbar{
  height:48px;display:flex;align-items:center;gap:12px;
  padding:0 18px;border-bottom:1px solid var(--border);
  background:var(--surface);flex-shrink:0
}
.logo{font-size:13px;font-weight:700;letter-spacing:-.01em;color:#fff}
.logo span{color:var(--text-faint);font-weight:400}
.ver-badge{font-size:10px;color:var(--text-faint);background:var(--surface-hi);border:1px solid var(--border-strong);border-radius:4px;padding:2px 6px}
.topbar-right{margin-left:auto;display:flex;align-items:center;gap:6px}
.toast{font-size:11px;color:var(--text-faint);margin-right:4px;transition:color .3s}
.toast.show{color:var(--state-ok)}
.tb-btn{background:var(--card);border:1px solid var(--border-strong);color:var(--text-muted);border-radius:6px;padding:5px 12px;font-size:11px;font-weight:500;cursor:pointer;transition:all .15s;white-space:nowrap}
.tb-btn:hover{color:#fff;border-color:var(--border-strong)}
.tb-btn.accent{background:rgba(34,211,238,.10);border-color:rgba(34,211,238,.3);color:var(--accent)}
.tb-btn.accent:hover{background:var(--accent);color:#052e2b}
.offline-pill{display:none;background:rgba(239,68,68,.10);border:1px solid rgba(239,68,68,.3);color:var(--state-error);border-radius:20px;padding:3px 10px;font-size:10px;font-weight:600}
.offline-pill.show{display:block}

/* ── LAYOUT ── */
.layout{display:flex;flex:1;overflow:hidden}

/* ── SIDEBAR ── */
.sidebar{
  width:260px;flex-shrink:0;display:flex;flex-direction:column;
  border-right:1px solid var(--border);background:var(--surface);overflow-y:auto
}
.sidebar-block{padding:16px 16px 0}
.sidebar-block+.sidebar-block{border-top:1px solid var(--border);padding-top:16px}
.sidebar-block:last-child{padding-bottom:16px}

/* Status */
.status-wrap{padding:18px 16px 16px}
.status-dot-row{display:flex;align-items:center;gap:10px;margin-bottom:6px}
.big-dot{width:12px;height:12px;border-radius:50%;flex-shrink:0;transition:background .3s}
.big-dot.connected{background:var(--state-ok);box-shadow:0 0 10px rgba(34,197,94,.27)}
.big-dot.connecting{background:var(--state-warn);animation:pulse 1.2s ease-in-out infinite}
.big-dot.disconnected,.big-dot.offline{background:var(--surface-hi)}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.8)}}
.status-label{font-size:16px;font-weight:600}
.status-label.connected{color:var(--state-ok)}
.status-label.connecting{color:var(--state-warn)}
.status-label.disconnected,.status-label.offline{color:var(--text-faint)}
.status-desc{font-size:11px;color:var(--text-faint);padding-left:22px}

/* Form */
.field{margin-bottom:12px}
.lbl{display:block;font-size:10px;font-weight:600;color:var(--text-faint);text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px}
.inp{width:100%;background:var(--input);border:1px solid var(--border-strong);border-radius:6px;color:var(--text);font-size:12px;padding:7px 10px;outline:none;transition:border-color .15s}
.inp:focus{border-color:var(--accent)}
.inp-row{display:flex;gap:5px}
.inp-row .inp{flex:1;min-width:0}
.show-btn{background:var(--surface-hi);border:1px solid var(--border-strong);color:var(--text-muted);border-radius:6px;padding:0 10px;font-size:11px;cursor:pointer;white-space:nowrap;flex-shrink:0}
.show-btn:hover{color:#fff}
.chk-row{display:flex;align-items:center;gap:7px;cursor:pointer;margin-top:4px}
.chk-row input{accent-color:var(--state-ok);width:13px;height:13px;cursor:pointer}
.chk-row span{font-size:12px;color:var(--text-muted)}

/* Buttons */
.btn-row{display:flex;gap:6px;padding:12px 16px;border-top:1px solid var(--border)}
.btn{flex:1;padding:8px 10px;border:none;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s;white-space:nowrap}
.btn:disabled{opacity:.35;cursor:default}
.btn-connect{background:#fff;color:#09090b}
.btn-connect:hover:not(:disabled){background:#e4e4e7}
.btn-disc{background:var(--surface-hi);color:var(--state-error);border:1px solid rgba(239,68,68,.15)}
.btn-disc:hover:not(:disabled){background:rgba(239,68,68,.10)}

/* ── MAIN ── */
.main{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}

/* Section header */
.sec-hdr{
  display:flex;align-items:center;justify-content:space-between;
  padding:12px 18px 10px;border-bottom:1px solid var(--border);
  flex-shrink:0;min-height:42px
}
.sec-title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text-faint)}
.sec-meta{font-size:11px;color:var(--text-faint)}

/* Printers area */
.printers-area{flex-shrink:0}
.printers-empty{padding:28px 18px;text-align:center;font-size:12px;color:var(--text-faint)}
.p-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;padding:10px 18px 14px}

/* Printer card */
.p-card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px 14px;min-width:0;transition:border-color .2s}
.p-card.local{border-color:rgba(34,197,94,.15)}
.p-card.printing{border-color:rgba(34,211,238,.15)}
.p-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.p-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.p-dot.ok{background:var(--state-ok);box-shadow:0 0 5px rgba(34,197,94,.27)}
.p-dot.ok.printing{background:var(--accent);box-shadow:0 0 5px rgba(34,211,238,.27);animation:pulse 2s ease-in-out infinite}
.p-dot.nok{background:var(--surface-hi)}
.p-name{font-size:13px;font-weight:600;color:var(--text);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.p-badge{font-size:9px;font-weight:700;border-radius:4px;padding:2px 5px;text-transform:uppercase;letter-spacing:.04em;flex-shrink:0}
.p-badge.printing{background:rgba(34,211,238,.10);color:var(--accent)}
.p-badge.paused{background:rgba(245,158,11,.10);color:var(--state-warn)}
.p-badge.error{background:rgba(239,68,68,.10);color:var(--state-error)}
.p-badge.idle,.p-badge.operational{background:var(--surface-hi);color:var(--text-faint)}
.p-badge.offline,.p-badge.unknown{background:var(--surface-hi);color:#3f3f46}
.p-job{font-size:10px;color:var(--text-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:4px}
.p-bar-wrap{height:3px;background:var(--surface-hi);border-radius:2px;overflow:hidden;margin-bottom:5px}
.p-bar{height:3px;background:var(--accent);border-radius:2px;transition:width 1s linear}
.p-foot{display:flex;justify-content:space-between;align-items:center}
.p-ip{font-size:9px;color:var(--text-faint);font-family:'IBM Plex Mono','Courier New',monospace}
.p-ms{font-size:9px;color:rgba(34,197,94,.4)}

/* ── LOG ── */
.log-area{flex:1;display:flex;flex-direction:column;overflow:hidden;border-top:1px solid var(--border)}
.log-box{flex:1;overflow-y:auto;padding:8px 18px;font-family:'IBM Plex Mono','Courier New',monospace;font-size:11px;line-height:1.7}
.l{white-space:pre-wrap;word-break:break-all}
.l.info{color:#3f3f46}
.l.warn{color:#713f12}
.l.err{color:#7f1d1d}
.l.info.recent{color:var(--text-muted)}
.l.warn.recent{color:var(--state-warn)}
.l.err.recent{color:var(--state-error)}

/* Unclaimed / discovered printers */
.p-discover-hdr{grid-column:1/-1;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text-faint);padding:4px 2px 0}
.p-unclaimed{border-color:rgba(34,211,238,.12);background:var(--surface-hi)}
.claim-btn{background:rgba(34,211,238,.10);border:1px solid rgba(34,211,238,.3);color:var(--accent);border-radius:5px;padding:3px 10px;font-size:10px;font-weight:600;cursor:pointer;transition:all .15s}
.claim-btn:hover:not(:disabled){background:var(--accent);color:#052e2b}
.claim-btn:disabled{opacity:.4;cursor:default}

/* Scrollbar */
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--surface-hi);border-radius:2px}
</style>
</head>
<body>

<!-- TOP BAR -->
<div class="topbar">
  <div class="logo">monofarm <span>agent</span></div>
  <div class="ver-badge" id="ver">v—</div>
  <span class="offline-pill" id="offline-pill">● disconnected from agent</span>
  <div class="topbar-right">
    <span class="toast" id="toast"></span>
    <button class="tb-btn" id="btn-update" onclick="checkUpdate()">↻ Check update</button>
    <button class="tb-btn accent" onclick="openDash()">Open dashboard ↗</button>
  </div>
</div>

<!-- LAYOUT -->
<div class="layout">

  <!-- SIDEBAR -->
  <div class="sidebar">

    <!-- Status -->
    <div class="status-wrap">
      <div class="status-dot-row">
        <div class="big-dot disconnected" id="dot"></div>
        <div class="status-label disconnected" id="slabel">Disconnected</div>
      </div>
      <div class="status-desc" id="sdesc">Not connected to monofarm cloud</div>
    </div>

    <!-- Settings form -->
    <div class="sidebar-block">
      <div class="field">
        <label class="lbl" for="inp-server">Server URL</label>
        <input class="inp" id="inp-server" type="text" placeholder="https://api.monofarm.app" autocomplete="off">
      </div>
      <!-- Token tab -->
      <div id="form-token">
        <div class="field">
          <label class="lbl" for="inp-token">Token</label>
          <div class="inp-row">
            <input class="inp" id="inp-token" type="password" placeholder="eyJ…" autocomplete="off">
            <button class="show-btn" onclick="toggleTok(this)">Show</button>
          </div>
        </div>
        <div style="text-align:center;margin:-4px 0 8px">
          <button class="show-btn" style="width:100%;font-size:10px" onclick="switchForm('login')">або увійти через email →</button>
        </div>
      </div>
      <!-- Login tab -->
      <div id="form-login" style="display:none">
        <div class="field">
          <label class="lbl" for="inp-email">Email</label>
          <input class="inp" id="inp-email" type="email" placeholder="you@example.com" autocomplete="email">
        </div>
        <div class="field">
          <label class="lbl" for="inp-pass">Password</label>
          <input class="inp" id="inp-pass" type="password" placeholder="••••••••" autocomplete="current-password">
        </div>
        <div style="text-align:center;margin:-4px 0 8px">
          <button class="show-btn" style="width:100%;font-size:10px" onclick="switchForm('token')">← або вставити токен</button>
        </div>
      </div>
      <label class="chk-row">
        <input type="checkbox" id="inp-autostart">
        <span>Start with system</span>
      </label>
    </div>

    <!-- Action buttons -->
    <div class="btn-row">
      <button class="btn btn-connect" id="btn-connect" onclick="doConnect()">Connect</button>
      <button class="btn btn-disc" onclick="doDisconnect()">Disconnect</button>
    </div>

  </div>

  <!-- MAIN -->
  <div class="main">

    <!-- Printers section -->
    <div class="printers-area" id="printers-area">
      <div class="sec-hdr">
        <span class="sec-title">Printers</span>
        <span class="sec-meta" id="printer-count"></span>
      </div>
      <div id="printers-empty" class="printers-empty">No printers — connect the agent to see them here.</div>
      <div class="p-grid" id="printers-list" style="display:none"></div>
    </div>

    <!-- Log section -->
    <div class="log-area">
      <div class="sec-hdr">
        <span class="sec-title">Log</span>
        <button class="tb-btn" onclick="clearLog()" style="font-size:10px;padding:3px 8px">Clear</button>
      </div>
      <div class="log-box" id="log"></div>
    </div>

  </div>
</div>

<script>
const WS_PORT = """ + str(UI_WS_PORT) + r""";
let ws, reconnTimer, logCount = 0;

const STATES = {
  connected:    ['Connected',    'Tunnel active — proxying requests'],
  connecting:   ['Connecting…',  'Establishing WebSocket tunnel'],
  disconnected: ['Disconnected', 'Not connected to monofarm cloud'],
  offline:      ['Agent offline','Cannot reach local agent UI'],
};

function connect() {
  clearTimeout(reconnTimer);
  try {
    ws = new WebSocket(`ws://${location.hostname}:${WS_PORT}`);
    ws.onopen = () => document.getElementById('offline-pill').classList.remove('show');
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.type === 'init') {
        document.getElementById('ver').textContent        = 'v' + (m.version || '?');
        document.getElementById('inp-server').value       = m.server || '';
        document.getElementById('inp-token').value        = m.token  || '';
        document.getElementById('inp-autostart').checked  = !!m.autostart;
        setState(m.state);
        (m.logs || []).forEach(l => addLog(l, false));
        renderPrinters(m.printers || []);
      } else if (m.type === 'state_change') {
        setState(m.state);
      } else if (m.type === 'log') {
        addLog(m.line, true);
      } else if (m.type === 'printers') {
        renderPrinters(m.printers || []);
      } else if (m.type === 'login_ok') {
        document.getElementById('inp-token').value = m.token || '';
        document.getElementById('btn-connect').disabled = false;
        switchForm('token');
        showToast('Успішний вхід ✓');
      } else if (m.type === 'login_err') {
        document.getElementById('btn-connect').disabled = false;
        document.getElementById('btn-connect').textContent = 'Увійти';
        showToast('Помилка входу: ' + (m.error || 'невідомо'));
      } else if (m.type === 'claim_err') {
        const btn = document.getElementById('claim-' + CSS.escape(m.dev_id));
        if (btn) { btn.disabled = false; btn.textContent = '+ Додати'; }
        showToast('Помилка: ' + (m.error || 'невідома'));
      } else if (m.type === 'update_status') {
        const btn = document.getElementById('btn-update');
        btn.disabled = m.checking;
        btn.textContent = m.checking ? '↻ Checking…' : '↻ Check update';
        if (m.message) showToast(m.message);
      }
    };
    ws.onclose = () => {
      document.getElementById('offline-pill').classList.add('show');
      setState('offline');
      reconnTimer = setTimeout(connect, 2000);
    };
    ws.onerror = () => ws.close();
  } catch(e) { reconnTimer = setTimeout(connect, 2000); }
}

function setState(s) {
  const info = STATES[s] || [s, ''];
  const dot  = document.getElementById('dot');
  const lbl  = document.getElementById('slabel');
  const desc = document.getElementById('sdesc');
  dot.className   = 'big-dot ' + s;
  lbl.className   = 'status-label ' + s;
  lbl.textContent = info[0];
  desc.textContent = info[1];
}

function addLog(line, isRecent) {
  const box = document.getElementById('log');
  const d = document.createElement('div');
  const lvl = /ERROR/.test(line) ? 'err' : /WARNING/.test(line) ? 'warn' : 'info';
  d.className = 'l ' + lvl + (isRecent ? ' recent' : '');
  d.textContent = line;
  box.appendChild(d);
  logCount++;
  if (isRecent) {
    setTimeout(() => d.classList.remove('recent'), 3000);
  }
  while (box.children.length > 600) box.removeChild(box.firstChild);
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  if (atBottom || isRecent) box.scrollTop = box.scrollHeight;
}

function clearLog() {
  document.getElementById('log').innerHTML = '';
  logCount = 0;
}

function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

let _formMode = 'token';
function switchForm(mode) {
  _formMode = mode;
  document.getElementById('form-token').style.display = mode === 'token' ? '' : 'none';
  document.getElementById('form-login').style.display = mode === 'login' ? '' : 'none';
  document.getElementById('btn-connect').textContent = mode === 'login' ? 'Увійти' : 'Connect';
}

function doConnect() {
  const s = document.getElementById('inp-server').value.trim();
  const a = document.getElementById('inp-autostart').checked;
  if (_formMode === 'login') {
    const email = document.getElementById('inp-email').value.trim();
    const pass  = document.getElementById('inp-pass').value;
    if (!email || !pass) { showToast("Email і пароль обов’язкові"); return; }
    document.getElementById('btn-connect').disabled = true;
    document.getElementById('btn-connect').textContent = 'Входимо…';
    send({type:'login', server:s, email, password:pass, autostart:a});
  } else {
    const t = document.getElementById('inp-token').value.trim();
    if (!t) { showToast('Token is required'); return; }
    send({type:'connect', server:s, token:t, autostart:a});
  }
}
function doDisconnect() { send({type:'disconnect'}); }
function openDash()     { send({type:'open_dashboard'}); }
function checkUpdate()  {
  send({type:'check_update'});
  const btn = document.getElementById('btn-update');
  btn.disabled = true;
  btn.textContent = '↻ Checking…';
}

function toggleTok(btn) {
  const inp = document.getElementById('inp-token');
  const hide = inp.type === 'password';
  inp.type = hide ? 'text' : 'password';
  btn.textContent = hide ? 'Hide' : 'Show';
}

let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); }, 3500);
}

function cleanJob(job) {
  if (!job) return '';
  job = job.replace(/^cache\//, '').replace(/\.3mf\.3mf$/, '.3mf').replace(/\.gcode\.3mf$/, '.3mf');
  job = job.replace(/_(?:PLA|PETG|ABS|TPU|ASA|PC|FLEX|SILK|WOOD)_\d.*$/, '');
  return job.length > 32 ? job.slice(0, 30) + '…' : job;
}

function claimPrinter(dev_id) {
  const btn = document.getElementById('claim-' + dev_id);
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  send({type: 'claim_printer', dev_id});
}

function claimMoonraker(url, name) {
  const id = 'moon-' + btoa(url).replace(/[^a-zA-Z0-9]/g, '');
  const btn = document.getElementById('claim-' + id);
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  send({type: 'claim_moonraker', url, name});
}

function renderPrinters(list) {
  const grid    = document.getElementById('printers-list');
  const empty   = document.getElementById('printers-empty');
  const count   = document.getElementById('printer-count');

  const claimed    = (list || []).filter(p => p.claimed !== false);
  const unclaimed  = (list || []).filter(p => p.claimed === false);

  if (!claimed.length && !unclaimed.length) {
    grid.style.display  = 'none';
    empty.style.display = '';
    count.textContent   = '';
    return;
  }
  grid.style.display  = '';
  empty.style.display = 'none';

  const printing = claimed.filter(p => p.state === 'printing').length;
  const online   = claimed.filter(p => p.local_ok).length;
  const parts = [];
  if (printing) parts.push(`${printing} printing`);
  if (claimed.length) parts.push(`${online}/${claimed.length} reachable`);
  if (unclaimed.length) parts.push(`${unclaimed.length} нових`);
  count.textContent = parts.join(' · ');

  const claimedHtml = claimed.map(p => {
    const isBambu  = (p.kind || '').includes('bambu');
    const ip       = p.bambu_dev_ip || (p.moonraker_url ? p.moonraker_url.replace(/https?:\/\//, '').split(/[/?]/)[0] : '');
    const state    = p.state || 'unknown';
    const job      = cleanJob(p.job || '');
    const pct      = p.progress_pct != null ? p.progress_pct : null;
    const dotClass = p.local_ok ? (state === 'printing' ? 'ok printing' : 'ok') : 'nok';
    const cardCls  = 'p-card' + (p.local_ok ? ' local' : '') + (state === 'printing' ? ' printing' : '');
    return `<div class="${cardCls}">
      <div class="p-head">
        <div class="p-dot ${dotClass}"></div>
        <div class="p-name" title="${p.name || ''}">${p.name || 'Printer'}</div>
        <div class="p-badge ${state}">${state}</div>
      </div>
      ${job ? `<div class="p-job" title="${job}">${job}</div>` : ''}
      ${pct != null ? `<div class="p-bar-wrap"><div class="p-bar" style="width:${pct}%"></div></div>` : ''}
      <div class="p-foot">
        <span class="p-ip">${ip || (isBambu ? 'Bambu Cloud' : '—')}</span>
        ${p.local_ms ? `<span class="p-ms">${p.local_ms}ms</span>` : ''}
      </div>
    </div>`;
  }).join('');

  const unclaimedHtml = unclaimed.length ? `
    <div class="p-discover-hdr">Виявлено — ще не додано до ферми</div>
    ${unclaimed.map(p => {
      if (p.kind === 'moonraker') {
        const moonId = 'moon-' + btoa(p.url || '').replace(/[^a-zA-Z0-9]/g, '');
        const ip = (p.url || '').replace(/https?:\/\//, '').split(/[/?]/)[0];
        return `<div class="p-card p-unclaimed">
          <div class="p-head">
            <div class="p-dot nok"></div>
            <div class="p-name">${p.name || 'Klipper'}</div>
            <div class="p-badge offline">Klipper</div>
          </div>
          <div class="p-foot" style="margin-top:8px">
            <span class="p-ip">${ip}</span>
            <button id="claim-${moonId}" class="claim-btn" onclick="claimMoonraker(${JSON.stringify(p.url)},${JSON.stringify(p.name||'Klipper Printer')})">+ Додати</button>
          </div>
        </div>`;
      }
      return `<div class="p-card p-unclaimed">
        <div class="p-head">
          <div class="p-dot nok"></div>
          <div class="p-name">${p.name || p.dev_id}</div>
          <div class="p-badge offline">${p.model || 'Bambu'}</div>
        </div>
        <div class="p-foot" style="margin-top:8px">
          <span class="p-ip">${p.dev_id}</span>
          <button id="claim-${p.dev_id}" class="claim-btn" onclick="claimPrinter('${p.dev_id}')">+ Додати</button>
        </div>
      </div>`;
    }).join('')}
  ` : '';

  grid.innerHTML = claimedHtml + unclaimedHtml;
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
        from logging.handlers import RotatingFileHandler
        file_h = RotatingFileHandler(
            CONFIG_DIR / "agent.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8",
        )
        file_h.setFormatter(fmt)
        root_log.addHandler(file_h)
    except Exception:
        pass

    if monofarm_agent is not None:
        monofarm_agent._cleanup_old_exe()
        if not monofarm_agent.acquire_single_instance():
            log.error("Another monofarm-agent is already running — exiting.")
            sys.exit(0)

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
