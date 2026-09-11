"""Canonical cloud WebSocket relay loop."""
from __future__ import annotations

import asyncio
import logging
import random
import sys

import websockets
from core.config import CONFIG_FILE, _load_alert_chat_ids, _load_config, _save_config
from core.state import runtime_state
from core.updates import check_for_update, update_loop
from printers import bambu
from transports import telegram
from transports.websocket import (
    disconnect,
    dispatch_message,
    parse_message,
    refresh_telegram_config,
    send_hello,
    start_printer_config_tasks,
)
from websockets import exceptions as websocket_exceptions

log = logging.getLogger("monofarm-agent")
RECONNECT_DELAY = 5
_RECONNECT_MAX = 60
_AUTH_REJECTION_CODES = frozenset({401, 403, 4001, 4002})


def _websocket_error_code(exc: BaseException) -> int | None:
    """Read handshake or close codes across websockets 12 through 17."""
    status_code = getattr(exc, "status_code", None)
    if isinstance(status_code, int):
        return status_code

    response = getattr(exc, "response", None)
    response_status = getattr(response, "status_code", None)
    if isinstance(response_status, int):
        return response_status

    received_close = getattr(exc, "rcvd", None)
    close_code = getattr(received_close, "code", None)
    if isinstance(close_code, int):
        return close_code

    legacy_close_code = getattr(exc, "code", None)
    return legacy_close_code if isinstance(legacy_close_code, int) else None


async def _pair_flow(server: str) -> str:
    """Open browser to monofarm Settings and wait for the user to click 'Connect Agent'.
    The frontend sends the JWT to our localhost callback; we save it and return it.
    """
    import socket as _sock
    import threading as _t
    import urllib.parse as _up
    import webbrowser as _wb
    from http.server import BaseHTTPRequestHandler, HTTPServer

    loop = asyncio.get_running_loop()
    token_fut: asyncio.Future[str] = loop.create_future()

    with _sock.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]

    class _H(BaseHTTPRequestHandler):
        def do_OPTIONS(self) -> None:
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.end_headers()

        def do_GET(self) -> None:
            qs  = _up.parse_qs(_up.urlparse(self.path).query)
            tok = qs.get("token", [""])[0]
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(b"ok")
            if tok and not token_fut.done():
                loop.call_soon_threadsafe(token_fut.set_result, tok)

        def log_message(self, *_) -> None:
            pass

    srv = HTTPServer(("127.0.0.1", port), _H)
    _t.Thread(target=srv.serve_forever, daemon=True).start()

    cfg      = _load_config()
    fe_url   = cfg.get("MONOFARM_FRONTEND") or server.replace(":8000", ":3000")
    pair_url = f"{fe_url}/settings?agent_pair={port}"
    log.info("Opening browser to pair agent: %s", pair_url)
    _wb.open(pair_url)
    log.info("Waiting for approval in browser (120s)…")

    try:
        token = await asyncio.wait_for(token_fut, timeout=120)
    except asyncio.TimeoutError:
        srv.shutdown()
        log.error("Pairing timed out. Run with --token to skip.")
        sys.exit(1)

    srv.shutdown()
    _save_config(server, token)
    log.info("Token saved to %s — future runs need no arguments.", CONFIG_FILE)
    return token

async def run(
    server: str,
    token: str,
    *,
    agent_version: str,
    on_state=None,
    run_updates: bool = True,
) -> None:
    """Single canonical relay loop — shared by the CLI agent and the tray host.

    on_state(state) fires with "connecting" | "connected" | "disconnected" so a
    GUI host (the tray) can reflect connection status. run_updates=False lets a
    host disable the built-in auto-updater if it manages updates itself.
    """
    runtime_state.version = agent_version
    runtime_state.server = server
    runtime_state.main_loop = asyncio.get_running_loop()
    telegram.configure(server, token, _load_alert_chat_ids())

    def _emit(state: str) -> None:
        if on_state:
            try:
                on_state(state)
            except Exception:
                log.debug("Agent state callback failed", exc_info=True)

    ws_url = (
        server.replace("https://", "wss://").replace("http://", "ws://")
        + f"/api/agent/connect?token={token}"
    )
    log.info("monofarm-agent v%s connecting to %s …", agent_version, server)
    bambu.ensure_bambu_mqtt_dependency()
    if runtime_state.update_task and not runtime_state.update_task.done():
        runtime_state.update_task.cancel()
        runtime_state.update_task = None
    if run_updates:
        await check_for_update(server, agent_version)
        runtime_state.update_task = asyncio.create_task(update_loop(server, agent_version))

    backoff = RECONNECT_DELAY
    while True:
        try:
            _emit("connecting")
            async with websockets.connect(
                ws_url,
                ping_interval=20,
                # Large uploads can temporarily starve a WAN relay. Do not
                # kill an otherwise active tunnel after a short 10s pause.
                ping_timeout=120,
                open_timeout=15,
                max_size=None,  # allow large messages (base64 chunks)
            ) as ws:
                log.info("Connected to monofarm cloud ✓  (waiting for requests…)")
                runtime_state.cloud_connected = True
                backoff = RECONNECT_DELAY  # reset backoff on a successful connect
                _emit("connected")
                await send_hello(ws, agent_version)
                background_tasks = start_printer_config_tasks(ws, server, token)
                await refresh_telegram_config(server, token)

                try:
                    async for message in ws:
                        request = parse_message(message)
                        if request is not None:
                            await dispatch_message(ws, request, agent_version)
                finally:
                    disconnect(background_tasks)

        except asyncio.CancelledError:
            _emit("disconnected")
            raise
        except (OSError, websocket_exceptions.WebSocketException) as e:
            error_code = _websocket_error_code(e)
            if error_code in _AUTH_REJECTION_CODES:
                log.error("Authentication failed (code %s). Check your token.", error_code)
                _emit("disconnected")
                return  # stop the loop without killing a GUI host process
            log.warning("Disconnected: %s. Retrying in %ss…", e, backoff)
        except Exception:
            log.exception("Unexpected relay error")

        _emit("disconnected")
        await asyncio.sleep(backoff + random.uniform(0, backoff * 0.3))
        backoff = min(backoff * 2, _RECONNECT_MAX)
