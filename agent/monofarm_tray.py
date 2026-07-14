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
import collections
import ipaddress
import json
import logging
import os
import pathlib
import platform
import socket
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlsplit

from network_policy import require_cloud_server_url, tls_verification_for_local_url

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

AGENT_VERSION      = "0.9.1"
UI_HTTP_PORT       = 4747   # browser navigates here for the HTML page
UI_WS_PORT         = 4748   # browser WebSocket connects here for live updates
UI_BIND_HOST       = "127.0.0.1"
CONFIG_DIR         = pathlib.Path.home() / ".monofarm-agent"
CONFIG_FILE        = CONFIG_DIR / ".env"
_DEFAULT_API_PORT  = "8000"
_DEFAULT_FE_PORT   = "3000"

log = logging.getLogger("monofarm")


def _is_loopback_hostname(hostname: str | None) -> bool:
    if not hostname:
        return False
    normalized = hostname.rstrip(".").lower()
    if normalized == "localhost":
        return True
    try:
        return ipaddress.ip_address(normalized).is_loopback
    except ValueError:
        return False


def _is_loopback_host(value: str | None) -> bool:
    if not value:
        return False
    try:
        parsed = urlsplit(f"//{value}")
        _ = parsed.port
    except ValueError:
        return False
    return (
        parsed.username is None
        and parsed.password is None
        and not parsed.path
        and not parsed.query
        and not parsed.fragment
        and _is_loopback_hostname(parsed.hostname)
    )


def _is_loopback_origin(value: str | None) -> bool:
    if not value:
        return True
    try:
        parsed = urlsplit(value)
        _ = parsed.port
    except ValueError:
        return False
    return (
        parsed.scheme in {"http", "https"}
        and parsed.username is None
        and parsed.password is None
        and not parsed.path
        and not parsed.query
        and not parsed.fragment
        and _is_loopback_hostname(parsed.hostname)
    )


def _websocket_header(websocket, name: str) -> str | None:
    headers = getattr(websocket, "request_headers", None)
    if headers is None:
        request = getattr(websocket, "request", None)
        headers = getattr(request, "headers", None)
    if headers is None:
        return None

    get_all = getattr(headers, "get_all", None)
    if get_all is not None:
        try:
            values = get_all(name)
        except Exception:
            return None
        return str(values[0]) if len(values) == 1 else None
    try:
        value = headers.get(name)
    except Exception:
        return None
    return str(value) if value is not None else None


def _is_local_websocket_request(websocket) -> bool:
    return _is_loopback_host(_websocket_header(websocket, "Host")) and _is_loopback_origin(
        _websocket_header(websocket, "Origin")
    )

# ── Config ────────────────────────────────────────────────────────────────────

def load_config() -> dict[str, str]:
    cfg = {"MONOFARM_SERVER": "https://api.monofarm.app", "MONOFARM_TOKEN": "", "MONOFARM_FRONTEND": "https://monofarm.app"}
    if CONFIG_FILE.exists():
        for line in CONFIG_FILE.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.startswith("#"):
                k, _, v = line.partition("=")
                cfg[k.strip()] = v.strip()
    return cfg


def _has_device_identity(cfg: dict[str, str] | None = None) -> bool:
    values = cfg or load_config()
    return bool(values.get("MONOFARM_DEVICE_ID") and values.get("MONOFARM_DEVICE_SECRET"))


def save_config(server: str, token: str) -> None:
    """Persist server+token, preserving other keys (FRONTEND, ALERT_CHAT_IDS).

    Atomic (temp + os.replace) so a crash can't truncate the config. Merging is
    essential — a naive overwrite would wipe ALERT_CHAT_IDS set via the bot.
    """
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    cfg = load_config()
    cfg["MONOFARM_SERVER"] = require_cloud_server_url(server)
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
        self._session_user_token = ""  # never persisted; only for admin-only setup actions
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
            server = await websockets.serve(self._ws_handler, UI_BIND_HOST, UI_WS_PORT)
        except OSError as e:
            log.warning("Could not start local UI WebSocket on port %s: %s", UI_WS_PORT, e)
            server = None

        cfg = load_config()
        if cfg["MONOFARM_TOKEN"] or _has_device_identity(cfg):
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
        if not _is_local_websocket_request(websocket):
            await websocket.close(
                code=1008,
                reason="Local UI requires loopback Host and Origin",
            )
            return
        self._ws_clients.add(websocket)
        try:
            cfg = load_config()
            await websocket.send(json.dumps({
                "type":      "init",
                "state":     self.state,
                "server":    cfg["MONOFARM_SERVER"],
                "configured": bool(cfg["MONOFARM_TOKEN"]) or _has_device_identity(cfg),
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
                    stored = load_config()
                    server = str(msg.get("server") or stored["MONOFARM_SERVER"]).strip()
                    token = str(msg.get("token") or stored["MONOFARM_TOKEN"]).strip()
                    save_config(server, token)
                    if msg.get("autostart") is not None:
                        _set_autostart(bool(msg["autostart"]))
                    await self._do_start(server, token)
                elif t == "pair":
                    stored = load_config()
                    server = str(msg.get("server") or stored["MONOFARM_SERVER"]).strip()
                    pairing_code = str(msg.get("pairing_code") or "").strip()
                    if msg.get("autostart") is not None:
                        _set_autostart(bool(msg["autostart"]))
                    asyncio.create_task(self._do_pair(server, pairing_code, websocket))
                elif t == "disconnect":
                    self._do_stop()
                elif t == "open_dashboard":
                    webbrowser.open(dashboard_url(load_config()["MONOFARM_SERVER"]))
                elif t == "check_update":
                    asyncio.create_task(self._run_update_check(websocket))
                elif t == "refresh_printers":
                    asyncio.create_task(self._run_printer_refresh(websocket))
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
                await self._refresh_printers()
            except asyncio.CancelledError:
                return
            except Exception as e:
                log.debug("Printer refresh error: %s", e)
            await asyncio.sleep(15)

    async def _refresh_printers(self) -> None:
        """Refresh the local/cloud printer list and publish one shared snapshot."""
        cfg = load_config()
        printers = await self._fetch_printers(
            cfg["MONOFARM_SERVER"], cfg["MONOFARM_TOKEN"]
        )
        self._printers = printers
        await self._broadcast({"type": "printers", "printers": printers})

    async def _run_printer_refresh(self, websocket) -> None:
        try:
            await self._refresh_printers()
        except Exception as exc:
            log.warning("Printer refresh failed: %s", exc)
            await websocket.send(
                json.dumps({"type": "refresh_err", "error": str(exc)})
            )

    async def _fetch_printers(self, server: str, token: str) -> list:
        """Fetch claimed printers + undiscovered Bambu/Moonraker devices from backend."""
        user_token = token or self._session_user_token
        if _has_device_identity() and not user_token:
            if monofarm_agent is None:
                return []
            access_token = await monofarm_agent._get_runtime_access_token(server, "")
            async with httpx.AsyncClient(timeout=8, follow_redirects=False) as client:
                response = await client.get(
                    f"{server}/api/agent/v2/runtime-config",
                    headers={"Authorization": f"Bearer {access_token}"},
                )
            response.raise_for_status()
            configured = []
            for printer in (response.json() or {}).get("printers") or []:
                if printer.get("transport") == "moonraker":
                    configured.append(
                        {
                            "id": printer["id"],
                            "name": printer["name"],
                            "kind": printer["kind"],
                            "moonraker_url": printer["moonraker_url"],
                        }
                    )
                elif printer.get("transport") == "bambu_lan":
                    configured.append(
                        {
                            "id": printer["id"],
                            "name": printer["name"],
                            "kind": "bambu",
                            "bambu_model": printer.get("model"),
                            "bambu_dev_id": printer["dev_id"],
                            "bambu_dev_ip": printer["ip"],
                        }
                    )
            claimed = await asyncio.gather(
                *[self._check_local(printer) for printer in configured],
                return_exceptions=False,
            )
            return [{**printer, "claimed": True} for printer in claimed]

        token = user_token
        headers = {"Authorization": f"Bearer {token}"}
        async with httpx.AsyncClient(timeout=8) as client:
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
        moonraker_url = p.get("moonraker_url")
        bambu_ip      = p.get("bambu_dev_ip")

        local_ok = False
        local_ms = None
        try:
            import time
            t0 = time.monotonic()
            verify = (
                tls_verification_for_local_url(
                    moonraker_url, "MONOFARM_MOONRAKER_INSECURE_TARGETS"
                )
                if moonraker_url
                else True
            )
            async with httpx.AsyncClient(timeout=2, verify=verify) as cl:
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
        user_token = cfg["MONOFARM_TOKEN"] or self._session_user_token
        if not user_token:
            await websocket.send(json.dumps({
                "type": "claim_err",
                "dev_id": dev_id,
                "error": "Sign in as an admin to add printers",
            }))
            return
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                r = await client.post(
                    f"{cfg['MONOFARM_SERVER']}/api/printers/bambu/claim",
                    headers={"Authorization": f"Bearer {user_token}"},
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
        user_token = cfg["MONOFARM_TOKEN"] or self._session_user_token
        if not user_token:
            await websocket.send(json.dumps({
                "type": "claim_err",
                "dev_id": url,
                "error": "Sign in as an admin to add printers",
            }))
            return
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                r = await client.post(
                    f"{cfg['MONOFARM_SERVER']}/api/printers/moonraker/claim",
                    headers={"Authorization": f"Bearer {user_token}"},
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

    async def _do_pair(self, server: str, pairing_code: str, websocket) -> None:
        """Exchange an admin-created one-time code for a dedicated device identity."""
        if monofarm_agent is None:
            await websocket.send(
                json.dumps({"type": "login_err", "error": "Agent runtime is unavailable"})
            )
            return
        if not pairing_code:
            await websocket.send(
                json.dumps({"type": "login_err", "error": "Pairing code is required"})
            )
            return
        try:
            await monofarm_agent._pair_device_flow(server, pairing_code)
            await websocket.send(json.dumps({"type": "login_ok"}))
            await self._do_start(server, "")
        except Exception as exc:
            await websocket.send(json.dumps({"type": "login_err", "error": str(exc)}))

    async def _do_login(self, email: str, password: str, server: str, websocket) -> None:
        """Use an admin login once to create a code; never persist its user JWT."""
        try:
            server = require_cloud_server_url(server)
            async with httpx.AsyncClient(timeout=10) as client:
                r = await client.post(
                    f"{server}/api/auth/login",
                    json={"email": email, "password": password},
                )
            if r.status_code == 200:
                token = r.json().get("access_token", "")
                async with httpx.AsyncClient(timeout=10) as client:
                    pairing = await client.post(
                        f"{server}/api/agent/devices/pairing-codes",
                        headers={"Authorization": f"Bearer {token}"},
                        json={
                            "name": socket.gethostname() or "Monofarm Agent",
                            "scopes": [
                                "agent:connect",
                                "commands:read",
                                "events:write",
                                "status:write",
                            ],
                        },
                    )
                if pairing.status_code != 201:
                    detail = (
                        pairing.json().get("detail", "Admin access is required to pair the agent")
                        if pairing.content
                        else "Could not create an agent pairing code"
                    )
                    await websocket.send(json.dumps({"type": "login_err", "error": detail}))
                    return
                self._session_user_token = token
                await self._do_pair(server, pairing.json().get("pairing_code", ""), websocket)
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

    srv = HTTPServer((UI_BIND_HOST, UI_HTTP_PORT), _H)
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
<html lang="uk">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Monofarm Agent</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0b0b0d;--bg-elevated:#121214;--surface:#151517;--surface-2:#19191c;--surface-hi:#212125;
  --border:rgba(255,255,255,.08);--border-strong:rgba(255,255,255,.14);--border-focus:rgba(34,211,238,.45);
  --text:#e7e9ec;--text-hi:#fff;--text-muted:#a4a9b3;--text-faint:#767c87;--text-dim:#54585f;
  --accent:#22d3ee;--accent-hi:#67e8f9;--accent-soft:rgba(34,211,238,.12);--accent-ring:rgba(34,211,238,.22);
  --state-print:#38bdf8;--state-ok:#4ade80;--state-idle:#9ca3af;--state-warn:#fbbf24;--state-error:#f87171;--state-offline:#5b616b;
  --r-xs:4px;--r-sm:6px;--r-md:8px;--r-lg:10px;--r-xl:14px;--r-full:9999px;
  --dur-quick:160ms;--dur-instant:80ms;--ease-out:cubic-bezier(.16,1,.3,1)
}
html,body{height:100%}
html{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
body{background:var(--bg);color:var(--text);font:14px/1.5 "IBM Plex Sans","Segoe UI",system-ui,sans-serif;font-feature-settings:"ss01","cv11";overflow:hidden}
button,input{font:inherit}button{cursor:pointer}button:focus-visible,input:focus-visible{outline:none;box-shadow:0 0 0 3px var(--accent-ring)}
.shell{height:100%;display:grid;grid-template-columns:256px minmax(0,1fr);transition:grid-template-columns var(--dur-quick) var(--ease-out)}
.shell.sidebar-collapsed{grid-template-columns:72px minmax(0,1fr)}
.sidebar{background:var(--bg-elevated);border-right:1px solid var(--border);display:flex;flex-direction:column;min-height:0;padding:8px;gap:0}
.brand{height:48px;display:flex;align-items:center;gap:10px;padding:0 10px;overflow:hidden}
.brand-logo{width:40px;height:32px;flex:0 0 40px;color:var(--text-hi)}.brand-copy{min-width:0;display:flex;align-items:center;gap:8px;white-space:nowrap}.brand-wordmark{font-size:14px;font-weight:600;letter-spacing:-.02em}.brand-wordmark span{color:var(--text-muted);font-weight:400}.brand-meta{padding:2px 5px;border:1px solid var(--border);border-radius:var(--r-xs);color:var(--text-faint);font:9px/1.2 "IBM Plex Mono",monospace}
.nav-cta{width:100%;height:40px;display:flex;align-items:center;gap:10px;margin:16px 0 8px;border:1px solid var(--border-strong);background:var(--surface);color:var(--text);border-radius:var(--r-md);padding:0 12px;text-align:left;font-size:12px;font-weight:500;transition:background var(--dur-quick),border-color var(--dur-quick),color var(--dur-quick)}.nav-cta:hover{background:var(--surface-hi);border-color:var(--border-focus)}
.nav{display:grid;gap:4px}.nav-btn{width:100%;height:40px;display:flex;align-items:center;gap:10px;border:0;background:transparent;color:var(--text-muted);border-radius:var(--r-md);padding:0 12px;text-align:left;font-size:12px;transition:background var(--dur-quick),color var(--dur-quick)}
.nav-btn:hover{background:var(--surface);color:var(--text)}.nav-btn.active{background:var(--accent-soft);color:var(--accent)}
.nav-icon{width:18px;height:18px;display:grid;place-items:center;flex:0 0 auto}.nav-icon svg{width:18px;height:18px}.nav-label{white-space:nowrap}
.sidebar-spacer{flex:1;min-height:20px}
.agent-status{display:flex;align-items:center;gap:10px;min-height:48px;padding:7px 10px;border-radius:var(--r-md);background:var(--surface);overflow:hidden}
.status-row{display:flex;align-items:center;gap:8px}.big-dot{width:7px;height:7px;border-radius:50%;background:var(--state-idle);flex:0 0 auto}.big-dot.connected{background:var(--state-ok)}.big-dot.connecting{background:var(--state-warn);animation:pulse 1.4s ease-in-out infinite}.big-dot.offline,.big-dot.disconnected{background:var(--state-offline)}
@keyframes pulse{50%{opacity:.45;transform:scale(.8)}}
.status-copy{min-width:0}.status-label{display:block;font-size:11px;font-weight:500;white-space:nowrap}.status-desc{overflow:hidden;color:var(--text-faint);font-size:10px;text-overflow:ellipsis;white-space:nowrap}.shell.sidebar-collapsed .brand-copy,.shell.sidebar-collapsed .nav-label,.shell.sidebar-collapsed .status-copy{display:none}.shell.sidebar-collapsed .brand,.shell.sidebar-collapsed .nav-btn,.shell.sidebar-collapsed .nav-cta,.shell.sidebar-collapsed .agent-status{justify-content:center;padding-left:0;padding-right:0}
.main{min-width:0;display:flex;flex-direction:column;overflow:hidden}.client-topbar{height:64px;display:flex;align-items:center;gap:12px;flex:0 0 auto;padding:0 16px 0 12px;border-bottom:1px solid var(--border);background:var(--bg)}.sidebar-toggle{width:28px;height:28px;display:grid;place-items:center;border:0;border-radius:var(--r-sm);background:transparent;color:var(--text-muted)}.sidebar-toggle:hover{background:var(--surface);color:var(--text)}.topbar-divider{width:1px;height:16px;background:var(--border-strong)}.breadcrumb{font-size:12px;font-weight:500;color:var(--text-muted)}.client-actions{margin-left:auto;display:flex;gap:8px}.top-actions{position:fixed;right:18px;bottom:18px;z-index:20}.offline-pill{display:none}.offline-pill.show{display:none}.toast{max-width:320px;padding:9px 12px;border:1px solid var(--border-strong);border-radius:var(--r-md);background:var(--bg-elevated);box-shadow:0 8px 24px rgba(0,0,0,.35);color:var(--text);font-size:11px;opacity:0;transform:translateY(5px);transition:opacity var(--dur-quick),transform var(--dur-quick)}.toast.show{opacity:1;transform:none}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border:1px solid transparent;border-radius:var(--r-sm);background:transparent;color:var(--text-muted);font-size:13px;font-weight:500;white-space:nowrap;transition:background var(--dur-quick),border-color var(--dur-quick),color var(--dur-quick),transform var(--dur-instant) var(--ease-out)}.btn:hover:not(:disabled){background:var(--surface-hi);color:var(--text)}.btn:active:not(:disabled){transform:scale(.97)}.btn:disabled{opacity:.5;cursor:default}.btn-primary{background:var(--accent);border-color:var(--accent);color:#052e2b;font-weight:600}.btn-primary:hover:not(:disabled){background:var(--accent-hi);color:#052e2b}.btn-secondary{background:var(--surface);border-color:var(--border-strong);color:var(--text)}.btn-danger{color:var(--state-error);border-color:rgba(239,68,68,.3)}
.view{display:none;min-height:0;flex:1;overflow:auto}.view.active{display:flex;flex-direction:column}.content{padding:24px;width:100%}.section-head{display:flex;align-items:flex-start;gap:18px;margin-bottom:20px}.section-copy{max-width:680px}.section-title{font-size:20px;line-height:1.25;letter-spacing:-.02em;text-wrap:balance}.section-desc{color:var(--text-muted);font-size:12px;margin-top:4px;text-wrap:pretty}.section-actions{margin-left:auto;display:flex;gap:8px}.printer-summary{display:block;margin-bottom:14px;font:11px/1.4 "IBM Plex Mono",monospace;color:var(--text-faint);font-variant-numeric:tabular-nums}
.empty{min-height:190px;display:grid;place-content:center;text-align:center;padding:28px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg)}.empty-mark{width:36px;height:36px;margin:0 auto 10px;display:grid;place-items:center;color:var(--text-faint)}.empty-mark svg{width:28px;height:28px}.empty h3{font-size:14px;font-weight:600}.empty p{color:var(--text-muted);font-size:12px;max-width:430px;margin:4px auto 12px;text-wrap:pretty}.p-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr));gap:16px}
.printer-card{--rail:transparent;--band:var(--surface-2);--fill:var(--state-print);--pill-bg:var(--surface-hi);--pill-fg:var(--text-muted);--pill-bd:var(--border);display:flex;flex-direction:column;min-height:210px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);box-shadow:inset 0 3px 0 var(--rail);overflow:hidden;transition:border-color var(--dur-quick),transform var(--dur-quick) var(--ease-out)}.printer-card:hover{border-color:var(--border-strong);transform:translateY(-1px)}.printer-card.printing{--rail:var(--state-print);--band:color-mix(in srgb,var(--state-print) 8%,var(--surface));--fill:var(--state-print);--pill-bg:color-mix(in srgb,var(--state-print) 14%,transparent);--pill-fg:var(--state-print);--pill-bd:color-mix(in srgb,var(--state-print) 30%,transparent)}.printer-card.paused{--rail:var(--state-warn);--pill-fg:var(--state-warn)}.printer-card.ok{--rail:var(--state-ok);--pill-fg:var(--state-ok)}.printer-card.error{--rail:var(--state-error);--pill-fg:var(--state-error)}.printer-card.offline{opacity:.68}.printer-card.discover{--rail:var(--accent)}
.pc-band{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:44px;padding:7px 10px 7px 13px;background:var(--band);border-bottom:1px solid var(--border)}.pc-band-id{min-width:0;display:flex;align-items:center;gap:9px}.pc-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;font-weight:650;letter-spacing:-.015em;color:var(--text-hi)}.pc-pill{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border:1px solid var(--pill-bd);border-radius:var(--r-full);background:var(--pill-bg);color:var(--pill-fg);font:600 10px/1 "IBM Plex Mono",monospace;letter-spacing:.05em;text-transform:uppercase;white-space:nowrap}.pc-pill-dot{width:6px;height:6px;border-radius:50%;background:currentColor}.pc-pill-dot.live{animation:pulse 1.6s ease-in-out infinite}
.pc-body{display:flex;flex:1;flex-direction:column;gap:8px;padding:10px 12px 11px}.pc-overview{display:grid;grid-template-columns:52px minmax(0,1fr);align-items:center;gap:10px}.pc-cover{width:52px;height:52px;display:grid;place-items:center;color:var(--text-faint)}.pc-cover svg{width:30px;height:30px}.pc-model{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-muted);font-size:12px;font-weight:600}.pc-meta{margin-top:4px;color:var(--text-faint);font:10px/1.4 "IBM Plex Mono",monospace;font-variant-numeric:tabular-nums}.pc-job{min-width:0;overflow:hidden;color:var(--text);font-size:12px;text-overflow:ellipsis;white-space:nowrap}.pc-progress{position:relative;height:16px;overflow:hidden;border-radius:var(--r-full);background:var(--surface-hi)}.pc-progress-fill{height:100%;border-radius:inherit;background:var(--fill)}.pc-progress-label{position:absolute;inset:0;display:grid;place-items:center;color:var(--text-hi);font:600 10px/1 "IBM Plex Mono",monospace}.pc-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:auto;padding-top:8px;border-top:1px solid var(--border)}.pc-foot-meta{color:var(--text-faint);font:10px/1.3 "IBM Plex Mono",monospace}.claim-btn{height:28px;padding:0 10px;border:1px solid var(--border-strong);border-radius:var(--r-sm);background:transparent;color:var(--text);font-size:11px}.claim-btn:hover:not(:disabled){background:var(--surface-hi)}.claim-btn:disabled{opacity:.45}.p-discover-hdr{grid-column:1/-1;margin-top:4px;color:var(--text-faint);font:500 10.5px/1.3 "IBM Plex Mono",monospace;letter-spacing:.08em;text-transform:uppercase}
.log-toolbar{display:flex;gap:8px;padding:24px 24px 14px}.search-wrap{position:relative;flex:1;max-width:460px}.search-wrap span{position:absolute;left:10px;top:7px;color:var(--text-faint)}.inp{width:100%;height:34px;background:var(--bg);border:1px solid var(--border-strong);border-radius:var(--r-sm);color:var(--text);padding:0 10px;font-size:13px;transition:border-color var(--dur-quick),box-shadow var(--dur-quick)}.inp:focus{border-color:var(--border-focus)}.search-wrap .inp{padding-left:30px}.filter-row{display:flex;gap:4px}.filter-btn{height:32px;border:0;background:transparent;color:var(--text-faint);border-radius:var(--r-sm);padding:0 10px;font-size:11px;font-weight:500}.filter-btn:hover{background:var(--surface-hi);color:var(--text)}.filter-btn.active{background:var(--accent-soft);color:var(--accent)}.log-box{flex:1;overflow:auto;margin:0 24px 24px;border:1px solid var(--border);border-radius:var(--r-lg);background:var(--surface);font:11px/1.7 "IBM Plex Mono","Cascadia Mono",monospace}.l{border-bottom:1px solid var(--border);padding:7px 12px;white-space:pre-wrap;word-break:break-word;color:var(--text-muted)}.l:last-child{border-bottom:0}.l.warn{color:var(--state-warn)}.l.err{color:var(--state-error)}.l.recent{background:var(--surface-2)}.log-empty{display:none;color:var(--text-faint);font-size:12px;padding:50px 24px;text-align:center}.log-empty.show{display:block}
.settings-grid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(280px,.75fr);gap:16px}.settings-card{background:linear-gradient(180deg,rgba(255,255,255,.025),transparent 40%),var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);overflow:hidden}.settings-card-head{padding:15px 16px;border-bottom:1px solid var(--border)}.settings-card-head h3{font-size:14px;font-weight:600}.settings-card-head p{font-size:11px;color:var(--text-muted);margin-top:3px}.settings-card-body{padding:16px}.field{margin-bottom:14px}.field:last-child{margin-bottom:0}.lbl{display:block;font-size:12px;font-weight:500;color:var(--text-muted);margin-bottom:5px}.inp-row{display:flex;gap:6px}.inp-row .inp{flex:1;min-width:0}.show-btn{height:34px;border:1px solid var(--border-strong);background:var(--surface);color:var(--text-muted);border-radius:var(--r-sm);padding:0 10px;font-size:11px}.show-btn:hover{background:var(--surface-hi);color:var(--text)}.text-switch{border:0;background:transparent;color:var(--accent);font-size:11px;padding:5px 0}.chk-row{display:flex;align-items:center;gap:9px;color:var(--text-muted);font-size:12px;cursor:pointer}.chk-row input{width:15px;height:15px;accent-color:var(--accent)}.settings-actions{display:flex;gap:8px;padding-top:14px;margin-top:14px;border-top:1px solid var(--border)}.about-list{display:grid;gap:10px}.about-row{display:flex;justify-content:space-between;gap:18px;font-size:12px}.about-row span:first-child{color:var(--text-muted)}.about-row span:last-child{font-family:"IBM Plex Mono",monospace;font-variant-numeric:tabular-nums}.hint{margin-top:14px;padding:10px 11px;border-radius:var(--r-md);background:var(--bg);color:var(--text-muted);font-size:11px;border:1px solid var(--border)}
::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--border-strong);border-radius:999px}
@media (max-width:760px){body{overflow:auto}.shell,.shell.sidebar-collapsed{height:auto;min-height:100%;grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}.sidebar{display:grid;grid-template-columns:1fr auto;border-right:0;border-bottom:1px solid var(--border);padding:8px}.brand{padding:0 6px}.brand-copy{display:flex!important}.nav-cta{grid-column:2;grid-row:1;width:40px;margin:4px 0;padding:0;justify-content:center}.nav-cta .nav-label{display:none!important}.nav{grid-column:1/-1;grid-row:2;grid-template-columns:repeat(4,1fr);margin-top:6px}.nav-btn{justify-content:center;padding:0 6px}.nav-btn .nav-icon{display:none}.nav-label{display:inline!important}.sidebar-spacer,.agent-status{display:none}.client-topbar{height:52px}.sidebar-toggle,.topbar-divider{display:none}.main{overflow:visible}.top-actions{display:none}.content{padding:20px 16px}.settings-grid{grid-template-columns:1fr}.section-head{align-items:stretch;flex-direction:column;margin-bottom:16px}.section-actions{margin:0}.log-toolbar{padding:20px 16px 12px;flex-wrap:wrap}.search-wrap{max-width:none;flex-basis:100%}.log-box{min-height:420px;margin:0 16px 20px}.view{overflow:visible}.p-grid{gap:12px}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<div class="shell" id="shell">
  <aside class="sidebar">
    <div class="brand">
      <svg class="brand-logo" viewBox="0 0 112 88" aria-label="Monofarm">
        <rect x="24" y="0" width="24" height="8" fill="currentColor"/><rect x="64" y="0" width="24" height="8" fill="currentColor"/>
        <rect x="16" y="8" width="80" height="16" fill="currentColor"/><rect x="0" y="24" width="112" height="16" fill="currentColor"/>
        <rect x="16" y="40" width="80" height="8" fill="currentColor"/><rect x="16" y="48" width="80" height="16" fill="currentColor"/>
        <rect x="32" y="48" width="16" height="16" fill="var(--bg-elevated)"/><rect x="64" y="48" width="16" height="16" fill="var(--bg-elevated)"/>
        <rect x="16" y="64" width="80" height="8" fill="currentColor"/><rect x="32" y="72" width="16" height="16" fill="currentColor"/><rect x="64" y="72" width="16" height="16" fill="currentColor"/>
      </svg>
      <div class="brand-copy"><span class="brand-wordmark">monofarm <span>Agent</span></span><span class="brand-meta" id="ver">v—</span></div>
    </div>
    <button class="nav-cta" onclick="refreshPrinters()" aria-label="Знайти принтер"><span class="nav-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></span><span class="nav-label">Знайти принтер</span></button>
    <nav class="nav" aria-label="Навігація агента">
      <button class="nav-btn active" data-view="printers" onclick="showView('printers')" aria-label="Принтери"><span class="nav-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9V3h12v6"/><rect x="4" y="9" width="16" height="9" rx="2"/><path d="M7 14h10v7H7zM17 12h.01"/></svg></span><span class="nav-label">Принтери</span></button>
      <button class="nav-btn" data-view="logs" onclick="showView('logs')" aria-label="Журнал"><span class="nav-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M5 6h14M5 12h14M5 18h10"/></svg></span><span class="nav-label">Журнал</span></button>
      <button class="nav-btn" data-view="settings" onclick="showView('settings')" aria-label="Налаштування"><span class="nav-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z"/></svg></span><span class="nav-label">Налаштування</span></button>
      <button class="nav-btn" onclick="openDash()" aria-label="Відкрити Monofarm"><span class="nav-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 5h5v5M10 14 19 5"/><path d="M19 13v6H5V5h6"/></svg></span><span class="nav-label">Відкрити Monofarm</span></button>
    </nav>
    <div class="sidebar-spacer"></div>
    <div class="agent-status">
      <span class="big-dot disconnected" id="dot"></span>
      <div class="status-copy"><span class="status-label" id="slabel">Не підключено</span><span class="status-desc" id="sdesc">Хмарний тунель неактивний</span></div>
    </div>
  </aside>
  <main class="main">
    <header class="client-topbar">
      <button class="sidebar-toggle" onclick="toggleSidebar()" aria-label="Згорнути бокову панель" title="Згорнути бокову панель"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M5 6h14M5 12h14M5 18h14"/></svg></button>
      <span class="topbar-divider"></span><span class="breadcrumb" id="breadcrumb">Принтери</span>
      <div class="client-actions" id="printer-actions"><button class="btn btn-secondary" id="btn-refresh" onclick="refreshPrinters()"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg><span id="btn-refresh-label">Оновити мережу</span></button></div>
    </header>
    <div class="top-actions"><span class="toast" id="toast"></span><span class="offline-pill" id="offline-pill">Локальний UI недоступний</span></div>
    <section class="view active" id="view-printers">
      <div class="content">
        <p class="printer-summary" id="printer-summary">Очікуємо дані від агента…</p>
        <div id="printers-empty" class="empty"><div><div class="empty-mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9V3h12v6"/><rect x="4" y="9" width="16" height="9" rx="2"/><path d="M7 14h10v7H7zM17 12h.01"/></svg></div><h3>Принтерів у мережі не знайдено</h3><p>Перевір, що принтер увімкнений і підключений до цієї мережі. Агент шукає Bambu Lab та Moonraker.</p><button class="btn btn-secondary" onclick="refreshPrinters()">Сканувати ще раз</button></div></div>
        <div class="p-grid" id="printers-list" style="display:none"></div>
      </div>
    </section>
    <section class="view" id="view-logs">
      <div class="log-toolbar">
        <label class="search-wrap"><span aria-hidden="true">⌕</span><input class="inp" id="log-search" placeholder="Пошук у журналі…" oninput="filterLogs()"></label>
        <div class="filter-row" aria-label="Рівень журналу"><button class="filter-btn active" data-level="all" onclick="setLogFilter('all',this)">Усі</button><button class="filter-btn" data-level="warn" onclick="setLogFilter('warn',this)">Увага</button><button class="filter-btn" data-level="err" onclick="setLogFilter('err',this)">Помилки</button></div>
        <button class="btn" onclick="clearLog()">Очистити</button>
      </div>
      <div class="log-box" id="log"></div><div class="log-empty" id="log-empty">Немає записів за цим фільтром.</div>
    </section>
    <section class="view" id="view-settings">
      <div class="content">
        <div class="section-head"><div class="section-copy"><h1 class="section-title">Налаштування</h1><p class="section-desc">Підключення до Monofarm, автозапуск і локальна версія агента.</p></div></div>
        <div class="settings-grid">
          <div class="settings-card">
            <div class="settings-card-head"><h3>Підключення до Monofarm</h3><p>Зберігається окрема AgentDevice identity, а не токен акаунта.</p></div>
            <div class="settings-card-body">
              <div class="field"><label class="lbl" for="inp-server">Server URL</label><input class="inp" id="inp-server" type="url" placeholder="https://api.monofarm.app" autocomplete="off"></div>
              <div id="form-token"><div class="field"><label class="lbl" for="inp-token">Одноразовий pairing code</label><div class="inp-row"><input class="inp" id="inp-token" type="password" placeholder="mf_pair_…" autocomplete="off"><button class="show-btn" onclick="toggleTok(this)">Показати</button></div></div><button class="text-switch" onclick="switchForm('login')">Створити pairing через admin email →</button></div>
              <div id="form-login" style="display:none"><div class="field"><label class="lbl" for="inp-email">Admin email</label><input class="inp" id="inp-email" type="email" placeholder="you@example.com" autocomplete="email"></div><div class="field"><label class="lbl" for="inp-pass">Пароль</label><input class="inp" id="inp-pass" type="password" placeholder="••••••••" autocomplete="current-password"></div><button class="text-switch" onclick="switchForm('token')">← Вставити pairing code</button></div>
              <div class="settings-actions"><button class="btn btn-primary" id="btn-connect" onclick="doConnect()">Підключити</button><button class="btn btn-danger" onclick="doDisconnect()">Відключити</button></div>
            </div>
          </div>
          <div class="settings-card">
            <div class="settings-card-head"><h3>Локальний агент</h3><p>Поведінка програми на цьому комп’ютері.</p></div>
            <div class="settings-card-body">
              <div class="about-list"><div class="about-row"><span>Версія</span><span id="about-ver">—</span></div><div class="about-row"><span>HTTP UI</span><span>:4747</span></div><div class="about-row"><span>WebSocket</span><span>:4748</span></div></div>
              <div class="settings-actions" style="display:block"><label class="chk-row"><input type="checkbox" id="inp-autostart"><span>Запускати разом із системою</span></label><button class="btn" id="btn-update" onclick="checkUpdate()" style="width:100%;margin-top:14px">↻ Перевірити оновлення</button></div>
              <div class="hint">Ця сторінка доступна лише на цьому комп’ютері. Керування файлами, чергою та аналітикою залишається у вебзастосунку Monofarm.</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</div>

<script>
const WS_PORT = """ + str(UI_WS_PORT) + r""";
let ws, reconnTimer, refreshTimer, toastTimer, logFilter = 'all', tokenConfigured = false;

const STATES = {
  connected:    ['З’єднано',       'Локальна мережа ↔ Monofarm'],
  connecting:   ['Підключення…',   'Встановлюємо захищений тунель'],
  disconnected: ['Не підключено',  'Хмарний тунель неактивний'],
  offline:      ['Агент офлайн',    'Локальний процес не відповідає'],
};

const VIEW_COPY = {
  printers: 'Принтери',
  logs: 'Журнал',
  settings: 'Налаштування',
};

const STATE_LABELS = {
  printing: 'Друкує', paused: 'Пауза', error: 'Помилка', idle: 'Очікує',
  operational: 'Готовий', offline: 'Офлайн', unknown: 'Невідомо',
};

function showView(view) {
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === 'view-' + view));
  document.querySelectorAll('.nav-btn').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  document.getElementById('breadcrumb').textContent = VIEW_COPY[view];
  document.getElementById('printer-actions').style.display = view === 'printers' ? '' : 'none';
  document.title = `${VIEW_COPY[view]} · Monofarm Agent`;
}

function toggleSidebar() {
  document.getElementById('shell').classList.toggle('sidebar-collapsed');
}

function connect() {
  clearTimeout(reconnTimer);
  try {
    ws = new WebSocket(`ws://${location.hostname}:${WS_PORT}`);
    ws.onopen = () => document.getElementById('offline-pill').classList.remove('show');
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.type === 'init') {
        const version = 'v' + (m.version || '?');
        document.getElementById('ver').textContent        = version;
        document.getElementById('about-ver').textContent  = version;
        document.getElementById('inp-server').value       = m.server || '';
        tokenConfigured = !!m.configured;
        document.getElementById('inp-token').value = '';
        document.getElementById('inp-token').placeholder = tokenConfigured ? 'AgentDevice уже підключено' : 'mf_pair_…';
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
        finishRefresh('Мережу оновлено');
      } else if (m.type === 'login_ok') {
        tokenConfigured = true;
        document.getElementById('inp-token').value = '';
        document.getElementById('inp-token').placeholder = 'AgentDevice уже підключено';
        document.getElementById('btn-connect').disabled = false;
        switchForm('token');
        showToast('Успішний вхід ✓');
      } else if (m.type === 'login_err') {
        document.getElementById('btn-connect').disabled = false;
        document.getElementById('btn-connect').textContent = 'Увійти';
        showToast('Помилка входу: ' + (m.error || 'невідомо'));
      } else if (m.type === 'claim_err') {
        document.querySelectorAll('.claim-btn').forEach(btn => { btn.disabled = false; btn.textContent = '+ Додати'; });
        showToast('Помилка: ' + (m.error || 'невідома'));
      } else if (m.type === 'refresh_err') {
        finishRefresh();
        showToast('Не вдалося оновити мережу: ' + (m.error || 'невідома помилка'), true);
      } else if (m.type === 'update_status') {
        const btn = document.getElementById('btn-update');
        btn.disabled = m.checking;
        btn.textContent = m.checking ? '↻ Перевіряємо…' : '↻ Перевірити оновлення';
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
  dot.className = 'big-dot ' + s;
  lbl.textContent = info[0];
  desc.textContent = info[1];
}

function addLog(line, isRecent) {
  const box = document.getElementById('log');
  const d = document.createElement('div');
  const lvl = /ERROR|CRITICAL/.test(line) ? 'err' : /WARNING|WARN/.test(line) ? 'warn' : 'info';
  d.className = 'l ' + lvl + (isRecent ? ' recent' : '');
  d.dataset.level = lvl;
  d.textContent = line;
  box.appendChild(d);
  if (isRecent) {
    setTimeout(() => d.classList.remove('recent'), 3000);
  }
  while (box.children.length > 600) box.removeChild(box.firstChild);
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  if (atBottom || isRecent) box.scrollTop = box.scrollHeight;
  filterLogs();
}

function clearLog() {
  document.getElementById('log').innerHTML = '';
  filterLogs();
}

function setLogFilter(level, button) {
  logFilter = level;
  document.querySelectorAll('.filter-btn').forEach(el => el.classList.toggle('active', el === button));
  filterLogs();
}

function filterLogs() {
  const query = document.getElementById('log-search').value.trim().toLowerCase();
  let visible = 0;
  document.querySelectorAll('#log .l').forEach(line => {
    const matchesLevel = logFilter === 'all' || line.dataset.level === logFilter;
    const matchesQuery = !query || line.textContent.toLowerCase().includes(query);
    line.style.display = matchesLevel && matchesQuery ? '' : 'none';
    if (matchesLevel && matchesQuery) visible++;
  });
  document.getElementById('log-empty').classList.toggle('show', visible === 0);
}

function send(obj) {
  if (!ws || ws.readyState !== 1) return false;
  ws.send(JSON.stringify(obj));
  return true;
}

let _formMode = 'token';
function switchForm(mode) {
  _formMode = mode;
  document.getElementById('form-token').style.display = mode === 'token' ? '' : 'none';
  document.getElementById('form-login').style.display = mode === 'login' ? '' : 'none';
  document.getElementById('btn-connect').textContent = mode === 'login' ? 'Увійти' : 'Підключити';
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
    const code = document.getElementById('inp-token').value.trim();
    if (!code && !tokenConfigured) { showToast('Вкажи одноразовий pairing code', true); return; }
    if (code) {
      send({type:'pair', server:s, pairing_code:code, autostart:a});
    } else {
      send({type:'connect', server:s, token:'', autostart:a});
    }
  }
}
function doDisconnect() { send({type:'disconnect'}); }
function openDash()     { send({type:'open_dashboard'}); }
function refreshPrinters() {
  const btn = document.getElementById('btn-refresh');
  const label = document.getElementById('btn-refresh-label');
  if (!send({type:'refresh_printers'})) { showToast('Локальний агент не відповідає', true); return; }
  btn.disabled = true;
  label.textContent = 'Скануємо…';
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => finishRefresh(), 12000);
}
function finishRefresh(message) {
  clearTimeout(refreshTimer);
  const btn = document.getElementById('btn-refresh');
  btn.disabled = false;
  document.getElementById('btn-refresh-label').textContent = 'Оновити мережу';
  if (message) showToast(message);
}
function checkUpdate()  {
  send({type:'check_update'});
  const btn = document.getElementById('btn-update');
  btn.disabled = true;
  btn.textContent = '↻ Перевіряємо…';
}

function toggleTok(btn) {
  const inp = document.getElementById('inp-token');
  const hide = inp.type === 'password';
  inp.type = hide ? 'text' : 'password';
  btn.textContent = hide ? 'Сховати' : 'Показати';
}

function showToast(msg, error = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.color = error ? 'var(--state-error)' : '';
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
  const btn = document.querySelector(`[data-claim-bambu="${CSS.escape(dev_id)}"]`);
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  send({type: 'claim_printer', dev_id});
}

function claimMoonraker(url, name) {
  const btn = document.querySelector(`[data-claim-moonraker="${CSS.escape(url)}"]`);
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  send({type: 'claim_moonraker', url, name});
}

function renderPrinters(list) {
  const grid    = document.getElementById('printers-list');
  const empty   = document.getElementById('printers-empty');
  const claimed    = (list || []).filter(p => p.claimed !== false);
  const unclaimed  = (list || []).filter(p => p.claimed === false);
  const printing = claimed.filter(p => p.state === 'printing').length;
  const online = claimed.filter(p => p.local_ok).length;
  const summary = [`${claimed.length} у фермі`, `${online} доступні локально`];
  if (printing) summary.push(`${printing} друкують`);
  if (unclaimed.length) summary.push(`${unclaimed.length} очікують додавання`);
  document.getElementById('printer-summary').textContent = summary.join(' · ');

  if (!claimed.length && !unclaimed.length) {
    grid.style.display  = 'none';
    empty.style.display = '';
    return;
  }
  grid.style.display  = '';
  empty.style.display = 'none';

  const claimedHtml = claimed.map(p => {
    const isBambu  = (p.kind || '').includes('bambu');
    const ip       = p.bambu_dev_ip || (p.moonraker_url ? p.moonraker_url.replace(/https?:\/\//, '').split(/[/?]/)[0] : '');
    const state    = p.state || 'unknown';
    const job      = cleanJob(p.job || '');
    const rawPct   = Number(p.progress_pct);
    const pct      = p.progress_pct != null && Number.isFinite(rawPct)
      ? Math.max(0, Math.min(100, rawPct)) : null;
    const tone = state === 'printing' || state === 'paused' || state === 'error'
      ? state : p.local_ok ? 'ok' : 'offline';
    const model = isBambu ? (p.bambu_model || p.model || 'Bambu Lab') : 'Klipper / Moonraker';
    return `<div class="printer-card ${tone}">
      <header class="pc-band">
        <div class="pc-band-id">
          <div class="pc-name" title="${esc(p.name || '')}">${esc(p.name || 'Принтер')}</div>
          <div class="pc-pill"><span class="pc-pill-dot ${state === 'printing' ? 'live' : ''}"></span>${esc(STATE_LABELS[state] || state)}</div>
        </div>
      </header>
      <div class="pc-body">
        <div class="pc-overview">
          <div class="pc-cover"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9V3h12v6"/><rect x="4" y="9" width="16" height="9" rx="2"/><path d="M7 14h10v7H7zM17 12h.01"/></svg></div>
          <div><div class="pc-model">${esc(model)}</div><div class="pc-meta">${esc(ip || (isBambu ? 'Bambu Cloud' : 'Адреса невідома'))}</div></div>
        </div>
        <div class="pc-job" title="${esc(job)}">${esc(job || 'Завдання не запущено')}</div>
        ${pct != null ? `<div class="pc-progress"><div class="pc-progress-fill" style="width:${pct}%"></div><span class="pc-progress-label">${Math.round(pct)}%</span></div>` : ''}
        <div class="pc-foot">
          <span class="pc-foot-meta">${p.local_ok ? 'Локально доступний' : 'Немає локального зв’язку'}</span>
          ${p.local_ms ? `<span class="pc-foot-meta">${p.local_ms} ms</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  const unclaimedHtml = unclaimed.length ? `
    <div class="p-discover-hdr">Виявлено в мережі · ще не додано</div>
    ${unclaimed.map(p => {
      if (p.kind === 'moonraker') {
        const ip = (p.url || '').replace(/https?:\/\//, '').split(/[/?]/)[0];
        return `<div class="printer-card discover">
          <header class="pc-band"><div class="pc-band-id"><div class="pc-name">${esc(p.name || 'Klipper')}</div><div class="pc-pill">Знайдено</div></div></header>
          <div class="pc-body">
            <div class="pc-overview"><div class="pc-cover"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9V3h12v6"/><rect x="4" y="9" width="16" height="9" rx="2"/><path d="M7 14h10v7H7zM17 12h.01"/></svg></div><div><div class="pc-model">Klipper / Moonraker</div><div class="pc-meta">${esc(ip)}</div></div></div>
            <div class="pc-foot"><span class="pc-foot-meta">Ще не у фермі</span><button class="claim-btn" data-claim-moonraker="${esc(p.url || '')}" data-name="${esc(p.name || 'Klipper Printer')}">+ Додати</button></div>
          </div>
        </div>`;
      }
      return `<div class="printer-card discover">
        <header class="pc-band"><div class="pc-band-id"><div class="pc-name">${esc(p.name || p.dev_id)}</div><div class="pc-pill">Знайдено</div></div></header>
        <div class="pc-body">
          <div class="pc-overview"><div class="pc-cover"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9V3h12v6"/><rect x="4" y="9" width="16" height="9" rx="2"/><path d="M7 14h10v7H7zM17 12h.01"/></svg></div><div><div class="pc-model">${esc(p.model || 'Bambu Lab')}</div><div class="pc-meta">${esc(p.dev_id)}</div></div></div>
          <div class="pc-foot"><span class="pc-foot-meta">Ще не у фермі</span><button class="claim-btn" data-claim-bambu="${esc(p.dev_id)}">+ Додати</button></div>
        </div>
      </div>`;
    }).join('')}
  ` : '';

  grid.innerHTML = claimedHtml + unclaimedHtml;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}

document.getElementById('printers-list').addEventListener('click', event => {
  const bambu = event.target.closest('[data-claim-bambu]');
  if (bambu) { claimPrinter(bambu.dataset.claimBambu); return; }
  const moonraker = event.target.closest('[data-claim-moonraker]');
  if (moonraker) claimMoonraker(moonraker.dataset.claimMoonraker, moonraker.dataset.name);
});

filterLogs();
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
    if not cfg["MONOFARM_TOKEN"] and not _has_device_identity(cfg):
        # First run — open the loopback UI so an admin can pair this device.
        threading.Timer(1.2, _open_ui).start()

    icon.run()


if __name__ == "__main__":
    main()
