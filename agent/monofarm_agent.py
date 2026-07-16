#!/usr/bin/env python3
"""monofarm-agent — local network tunnel for Moonraker printers and cameras.

Runs on a Raspberry Pi or any PC on the same network as your printers.
Makes an outbound WebSocket connection to monofarm cloud so the server
can reach local Moonraker instances and camera streams without port forwarding.

Wire protocol:
  Regular:  Server→Agent  {"id":"…","method":"GET","url":"…","body":null}
            Agent→Server  {"id":"…","status":200,"body":{…},"error":null}

  Streaming: Server→Agent  {"id":"…","method":"STREAM","url":"…"}
             Agent→Server  {"id":"…","type":"stream_start","status":200}
             Agent→Server  {"id":"…","type":"chunk","data":"<base64>"}  (repeated)
             Agent→Server  {"id":"…","type":"stream_end"}

Usage:
    python monofarm_agent.py --server https://api.monofarm.app --token YOUR_JWT_TOKEN
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import collections
import hashlib
import html as _htmlmod
import io
import json
import os
import random
import socket
import ssl
import logging
import sys
import tempfile
import threading
import urllib.parse as _urlparse_mod
from pathlib import Path

AGENT_VERSION = "0.8.11"
UPDATE_INTERVAL = 6 * 3600  # check every 6 hours
MOONRAKER_UPLOAD_HEARTBEAT_INTERVAL = 5.0

# Bambu FTPS (:990): connect fast, but tolerate long per-write stalls — A1
# SD-card flushes block the data socket well beyond the handshake timeout.
BAMBU_FTPS_CONNECT_TIMEOUT = 15
BAMBU_FTPS_IO_TIMEOUT = 120

try:
    import httpx
    import websockets
    import websockets.exceptions
except ImportError:
    print("Missing dependencies. Run: pip install websockets httpx")
    sys.exit(1)

try:
    from telegram import Update
    from telegram.ext import Application, CommandHandler, ContextTypes, MessageHandler, filters as tg_filters
    _TG_AVAILABLE = True
except ImportError:
    _TG_AVAILABLE = False


log = logging.getLogger("monofarm-agent")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")

# Ring buffer with recent log lines — served by the local web UI and the
# AGENT_LOGS tunnel method (our equivalent of SimplyPrint's telemetry: the
# farm operator and the SaaS can both read agent logs without SSH).
_LOG_BUFFER: "collections.deque[str]" = collections.deque(maxlen=500)


class _LogBufferHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        try:
            _LOG_BUFFER.append(self.format(record))
        except Exception:
            pass


_log_buffer_handler = _LogBufferHandler()
_log_buffer_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s: %(message)s"))
logging.getLogger().addHandler(_log_buffer_handler)

# Runtime state surfaced in the web UI
_cloud_connected = False
_moonraker_upload_buffers: dict[str, dict] = {}
_current_server = ""
_main_loop: "asyncio.AbstractEventLoop | None" = None
_update_task: "asyncio.Task | None" = None  # single auto-update loop, owned by run()

WEB_PORT_DEFAULT = 8723  # local setup UI; set MONOFARM_WEB_PORT=0 to disable

RECONNECT_DELAY = 5    # initial seconds between reconnect attempts
_RECONNECT_MAX  = 60   # cap for exponential reconnect backoff
REQUEST_TIMEOUT = 10   # seconds per regular proxied request
STREAM_CHUNK    = 32768  # bytes per chunk for streaming

CONFIG_DIR  = Path.home() / ".monofarm-agent"
CONFIG_FILE = CONFIG_DIR / ".env"

# ── Telegram bot state (per-agent, started after receiving token from SaaS) ───

_tg_app: "Application | None" = None
_tg_token: str | None = None
_tg_lock = asyncio.Lock()
_tg_server: str = ""
_tg_jwt: str = ""


async def _tg_cmd_handler(update: "Update", _ctx: "ContextTypes.DEFAULT_TYPE") -> None:
    """Generic handler: forwards the command to SaaS and replies with the result."""
    if not update.message or not update.effective_chat:
        return
    chat_id = update.effective_chat.id
    text    = update.message.text or ""
    # Parse command and args (handles /start abc, /план, /статус)
    parts   = text.split()
    raw_cmd = parts[0].lstrip("/").split("@")[0].lower() if parts else ""
    args    = parts[1:] if len(parts) > 1 else []
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{_tg_server}/api/agent/tg-command",
                json={"command": raw_cmd, "chat_id": chat_id, "args": args},
                headers={"Authorization": f"Bearer {_tg_jwt}"},
            )
            resp.raise_for_status()
            data = resp.json()
            reply = data.get("text") or ""
            parse_mode = data.get("parse_mode")
    except Exception as exc:
        log.warning("tg-command %s failed: %s", raw_cmd, exc)
        reply = "Помилка звʼязку з сервером. Спробуй ще раз."
        parse_mode = None
    if reply:
        await update.message.reply_text(reply, parse_mode=parse_mode)


async def _tg_start(token: str) -> None:
    """Build and start the PTB Application, then report the bot username back to SaaS."""
    global _tg_app, _tg_token
    if not _TG_AVAILABLE:
        log.warning("python-telegram-bot not installed — Telegram bot disabled")
        return
    app = Application.builder().token(token).build()
    # Local-only commands (register a chat for failure alerts) — handled on the
    # agent, never forwarded to the SaaS.
    app.add_handler(CommandHandler("alerts_here", _tg_alerts_here))
    app.add_handler(CommandHandler("alerts_off", _tg_alerts_off))
    app.add_handler(MessageHandler(tg_filters.Regex(r"^/тривоги_тут(@\w+)?(\s|$)"), _tg_alerts_here))
    app.add_handler(MessageHandler(tg_filters.Regex(r"^/тривоги_вимкнути(@\w+)?(\s|$)"), _tg_alerts_off))
    app.add_handler(CommandHandler("start", _tg_cmd_handler))
    app.add_handler(MessageHandler(tg_filters.Regex(r"^/план(@\w+)?(\s|$)"), _tg_cmd_handler))
    app.add_handler(MessageHandler(tg_filters.Regex(r"^/статус(@\w+)?(\s|$)"), _tg_cmd_handler))
    await app.initialize()
    me = await app.bot.get_me()
    await app.start()
    if app.updater:
        await app.updater.start_polling(drop_pending_updates=True)
    _tg_app   = app
    _tg_token = token
    log.info("Telegram bot @%s online", me.username)
    # Report username back to SaaS so it can cache it for deep-link generation
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                f"{_tg_server}/api/agent/tg-report-username",
                json={"username": me.username},
                headers={"Authorization": f"Bearer {_tg_jwt}"},
            )
    except Exception as exc:
        log.debug("Failed to report bot username to SaaS: %s", exc)


async def _tg_stop() -> None:
    global _tg_app, _tg_token
    if _tg_app is None:
        return
    app = _tg_app
    _tg_app   = None
    _tg_token = None
    try:
        if app.updater:
            await app.updater.stop()
        await app.stop()
        await app.shutdown()
    except Exception as exc:
        log.debug("Telegram bot stop error: %s", exc)
    log.info("Telegram bot stopped")


async def _tg_reconfigure(new_token: str | None) -> None:
    async with _tg_lock:
        if new_token == _tg_token:
            return
        await _tg_stop()
        if new_token:
            try:
                await _tg_start(new_token)
            except Exception as exc:
                log.error("Failed to start Telegram bot: %s", exc)


# ── Printer failure/stop alerts (detected + sent fully on the agent) ──────────
#
# The server never sees alert content. Detection taps the same state the agent
# already forwards (Moonraker full_state / Bambu reports); the photo is grabbed
# locally from the printer camera; recipients are group chats configured LOCALLY
# (via /тривоги_тут in the chat, or the agent web UI).

# Alert recipients (Telegram chat IDs). Loaded from config at startup.
_alert_chat_ids: list[int] = []
# printer_key -> last alerted (state, error_code). Cleared when the printer recovers.
_alert_last: dict[str, tuple[str, str]] = {}
# printer_keys we've seen at least once — suppresses alerts for a printer's
# pre-existing bad state right after the agent (re)starts.
_alert_seen: set[str] = set()
# Guards the alert state above — mutated from both the event loop (Moonraker)
# and paho MQTT callback threads (Bambu).
_alert_lock = threading.Lock()
# Bambu LAN reports are deltas — merge per device before classifying.
_bambu_print_state: dict[str, dict] = {}
# moonraker_url -> friendly printer name (from MOONRAKER_SUBSCRIBE).
_moonraker_names: dict[str, str] = {}

_HEALTHY_STATES = {"idle", "printing", "operational", "unknown", "prepare", "slicing"}
_BAD_STATES = {"error", "paused", "cancelled"}
_STATE_LABELS = {
    "error": "збій",
    "paused": "зупинка / пауза",
    "cancelled": "друк скасовано",
}

# Bambu HMS module + curated message tables (mirror of backend bambu.py). The
# big 4998-entry English DB is intentionally NOT bundled — the curated Ukrainian
# table covers the common cases; rarer codes fall back to "module + code".
_HMS_MODULES: dict[int, str] = {
    0x0100: "Тулхед", 0x0200: "Екструдер", 0x0300: "Стіл", 0x0500: "Рух/мотори",
    0x0600: "Привід осі", 0x0700: "AMS", 0x0800: "Зовнішня котушка",
    0x0900: "Датчик філаменту", 0x0A00: "Буфер", 0x0C00: "Сопло/хотенд",
    0x0D00: "Камера", 0x0F00: "Плата MC", 0x1000: "Живлення", 0x1100: "Вентилятор",
    0x1200: "XCam/Огляд шарів", 0x1400: "Гіроскоп", 0x2000: "Мережа", 0x3000: "AP Board",
}
_HMS_MESSAGES: dict[str, str] = {
    "0C00_0100_0001_0001": "Температура сопла нижча за норму",
    "0C00_0100_0002_0001": "Перегрів сопла",
    "0C00_0200_0001_0001": "Помилка датчика температури сопла",
    "0C00_0200_0002_0001": "Датчик температури сопла відключено",
    "0C00_0300_0001_0001": "Заминка філаменту в хотенді",
    "0C00_0300_0002_0001": "Філамент не подається в хотенд",
    "0C00_0400_0001_0001": "Збій вентилятора хотенду",
    "0C00_0400_0002_0001": "Збій вентилятора обдуву деталі",
    "0300_0100_0001_0001": "Помилка датчика температури столу",
    "0300_0100_0001_0002": "NTC температура столу аномальна",
    "0300_0100_0002_0001": "Стіл нагрівається занадто повільно",
    "0300_0100_0002_0002": "Стіл не досягає цільової температури",
    "0300_0200_0001_0001": "Перегрів столу",
    "0500_0100_0001_0001": "Збій мотора осі X (stall)",
    "0500_0100_0002_0001": "Збій мотора осі Y (stall)",
    "0500_0100_0003_0001": "Збій мотора осі Z (stall)",
    "0500_0100_0004_0001": "Збій мотора подачі філаменту",
    "0500_0200_0001_0001": "Зіткнення по осі X",
    "0500_0200_0002_0001": "Зіткнення по осі Y",
    "0500_0300_0001_0001": "Помилка калібрування осі Z",
    "0500_0300_0002_0001": "Помилка mesh калібрування столу",
    "0700_0300_0001_0001": "AMS: помилка подачі філаменту",
    "0700_0300_0002_0001": "AMS: заминка/застрявання філаменту",
    "0700_0400_0001_0001": "AMS: помилка намотки",
    "0700_0500_0001_0001": "AMS: помилка температури",
    "0700_0600_0001_0001": "AMS: немає філаменту",
    "0700_7000_0002_0001": "AMS: не вдалося подати філамент в тулхед",
    "0700_7000_0002_0002": "AMS: не вдалося подати філамент в тулхед (можлива заминка)",
    "0700_7000_0003_0001": "AMS: не вдалося втягнути філамент назад",
    "0700_1700_0001_0003": "AMS слот 1: немає філаменту",
    "0700_1700_0002_0003": "AMS слот 2: немає філаменту",
    "0700_1700_0003_0003": "AMS слот 3: немає філаменту",
    "0700_1700_0004_0003": "AMS слот 4: немає філаменту",
    "1000_0100_0001_0001": "Проблема з живленням",
    "1000_0200_0001_0001": "Напруга виходу за межі норми",
    "2000_0100_0001_0001": "Проблема з мережею",
    "2000_0100_0002_0001": "Втрата підключення до хмари",
}


def _hms_code_key(h: dict) -> str:
    attr = h.get("attr", 0) or 0
    code = h.get("code", 0) or 0
    return (
        f"{attr >> 16 & 0xFFFF:04X}_{attr & 0xFFFF:04X}"
        f"_{code >> 16 & 0xFFFF:04X}_{code & 0xFFFF:04X}"
    )


def _hms_describe_local(h: dict) -> str:
    if h.get("msg"):
        return str(h["msg"])
    key = _hms_code_key(h)
    if key in _HMS_MESSAGES:
        return _HMS_MESSAGES[key]
    attr = h.get("attr", 0) or 0
    module = _HMS_MODULES.get(attr >> 16 & 0xFFFF)
    return f"{module}: HMS {key}" if module else f"HMS {key}"


def _classify_moonraker(print_stats: dict) -> tuple[str, str, str]:
    """(state, error_text, error_code) from a Moonraker print_stats object.

    Klipper has no numeric error code, so the "code" is a short stable hash of
    the message — enough to identify and dedup the incident.
    """
    raw = (print_stats.get("state") or "").lower()
    state = {
        "standby": "idle", "ready": "idle", "printing": "printing",
        "pausing": "pausing", "paused": "paused", "resuming": "resuming",
        "cancelling": "cancelling", "canceling": "cancelling",
        "complete": "idle", "completed": "idle",
        "cancelled": "cancelled", "canceled": "cancelled", "error": "error",
    }.get(raw, raw or "unknown")
    msg = (print_stats.get("message") or "").strip()
    error_text = msg[:300]
    error_code = hashlib.sha1(msg.encode("utf-8")).hexdigest()[:8] if msg else ""
    return state, error_text, error_code


def _classify_bambu(print_data: dict) -> tuple[str, str, str]:
    """(state, error_text, error_code) from a merged Bambu print report."""
    raw = (print_data.get("gcode_state") or "").upper()
    state = {
        "IDLE": "idle", "PREPARE": "printing", "SLICING": "printing",
        "RUNNING": "printing", "PAUSE": "paused", "FINISH": "idle",
        "FAILED": "error",
    }.get(raw, "unknown")

    texts: list[str] = []
    codes: list[str] = []
    hms_list = print_data.get("hms")
    if isinstance(hms_list, list):
        for h in hms_list:
            if isinstance(h, dict):
                texts.append(_hms_describe_local(h))
                codes.append(_hms_code_key(h))
    error_text = " | ".join(t for t in texts if t)

    print_error = print_data.get("print_error")
    if isinstance(print_error, int) and print_error != 0:
        codes.append(f"{print_error:#010x}")
        if not error_text:
            error_text = _describe_print_error_local(print_error)

    return state, error_text, " ".join(codes)


def _describe_print_error_local(err_code: int) -> str:
    if err_code == 0x0500C010:
        return "Помилка MicroSD: карта пам’яті не читається або не записується — перевір/заміни MicroSD-карту на принтері (0x0500c010)"
    return f"Помилка друку: {err_code:#010x}"


def _alert_should_fire(printer_key: str, state: str, error_code: str) -> bool:
    """Decide whether this state change is a new incident worth alerting.

    Fast, synchronous, called on every status message — only the rare True
    return triggers the async snapshot + send.
    """
    with _alert_lock:
        bad = state in _BAD_STATES or bool(error_code)
        first_seen = printer_key not in _alert_seen
        _alert_seen.add(printer_key)

        if state in _HEALTHY_STATES and not error_code:
            _alert_last.pop(printer_key, None)  # recovered → re-arm
            return False
        if not bad:
            return False  # transient (pausing/resuming/cancelling) — wait for terminal

        sig = (state, error_code)
        if _alert_last.get(printer_key) == sig:
            return False  # already alerted this exact incident
        _alert_last[printer_key] = sig
        return not first_seen  # suppress a printer's pre-existing state at startup


def _build_alert_caption(name: str, state: str, error_text: str, error_code: str) -> str:
    label = _STATE_LABELS.get(state)
    if not label:
        label = "збій" if (error_code or error_text) else state
    lines = [f"⚠️ <b>{_htmlmod.escape(name)}</b> — {label}"]
    if error_text:
        lines.append(_htmlmod.escape(error_text[:300]))
    if error_code:
        lines.append(f"<code>{_htmlmod.escape(error_code)}</code>")
    return "\n".join(lines)


async def _bambu_grab_frame(ip: str, access_code: str, timeout: float = 12.0) -> bytes | None:
    """Grab a single JPEG frame from a Bambu camera (binary TLS protocol, :6000)."""
    import struct as _struct

    auth = bytearray(80)
    _struct.pack_into("<I", auth, 0, 0x40)
    _struct.pack_into("<I", auth, 4, 0x3000)
    auth[16:20] = b"bblp"
    pw = access_code.encode()
    auth[48:48 + len(pw)] = pw

    writer = None
    try:
        async def _open():
            return await asyncio.open_connection(
                ip, 6000, ssl=_bambu_ssl_context(ip), server_hostname=ip,
            )
        try:
            reader, writer = await asyncio.wait_for(_open(), timeout=timeout)
        except ssl.SSLError as exc:
            _bambu_mark_tls_failure(ip, exc)
            reader, writer = await asyncio.wait_for(_open(), timeout=timeout)
        writer.write(bytes(auth))
        await writer.drain()

        async def read_exact(n: int) -> bytes:
            buf = b""
            while len(buf) < n:
                chunk = await asyncio.wait_for(reader.read(n - len(buf)), timeout=timeout)
                if not chunk:
                    raise ConnectionError("stream closed")
                buf += chunk
            return buf

        header = await read_exact(16)
        size = _struct.unpack("<I", header[0:4])[0]
        if size == 0 or size > 10_000_000:
            return None
        return await read_exact(size)
    except Exception as exc:
        log.debug("bambu frame grab failed %s: %s", ip, exc)
        return None
    finally:
        if writer:
            try:
                writer.close()
            except Exception:
                pass


async def _moonraker_grab_snapshot(moonraker_url: str, timeout: float = 8.0) -> bytes | None:
    """Grab a still JPEG from a Moonraker printer's webcam (best-effort)."""
    parsed = _urlparse_mod.urlparse(moonraker_url)
    host = parsed.hostname or "localhost"
    base = f"{parsed.scheme or 'http'}://{host}:{parsed.port or 7125}"

    candidates: list[str] = []
    try:
        async with httpx.AsyncClient(timeout=timeout, verify=False) as client:  # noqa: S501
            r = await client.get(f"{base}/server/webcams/list")
            if r.status_code == 200:
                for cam in ((r.json().get("result") or {}).get("webcams") or []):
                    snap = (cam.get("snapshot_url") or "").strip()
                    if not snap:
                        continue
                    if snap.startswith("http"):
                        candidates.append(snap)
                    else:
                        candidates.append(f"http://{host}{snap if snap.startswith('/') else '/' + snap}")
    except Exception:
        pass
    candidates += [f"http://{host}/webcam/?action=snapshot", f"http://{host}:8080/?action=snapshot"]

    async with httpx.AsyncClient(timeout=timeout, verify=False) as client:  # noqa: S501
        for url in candidates:
            try:
                r = await client.get(url)
            except Exception:
                continue
            if r.status_code == 200 and r.content and r.headers.get("content-type", "").startswith("image"):
                return r.content
    return None


async def _send_alert(caption: str, jpeg: bytes | None) -> None:
    if not _tg_app or not _alert_chat_ids:
        return
    for chat_id in list(_alert_chat_ids):
        try:
            if jpeg:
                await _tg_app.bot.send_photo(
                    chat_id=chat_id, photo=io.BytesIO(jpeg), caption=caption, parse_mode="HTML",
                )
            else:
                await _tg_app.bot.send_message(chat_id=chat_id, text=caption, parse_mode="HTML")
        except Exception as exc:
            log.warning("alert send to %s failed: %s", chat_id, exc)


async def _dispatch_alert(
    name: str, state: str, error_text: str, error_code: str,
    snapshot_kind: str, snapshot_args: dict,
) -> None:
    """Grab a camera snapshot and push the alert. Photo is optional (graceful)."""
    if not _tg_app or not _alert_chat_ids:
        return
    jpeg: bytes | None = None
    try:
        if snapshot_kind == "bambu":
            jpeg = await _bambu_grab_frame(**snapshot_args)
        else:
            jpeg = await _moonraker_grab_snapshot(**snapshot_args)
    except Exception as exc:
        log.debug("alert snapshot failed: %s", exc)
    await _send_alert(_build_alert_caption(name, state, error_text, error_code), jpeg)


# ── Local Telegram alert-chat registration (handled on the agent, never the SaaS) ──

async def _tg_alerts_here(update: "Update", _ctx: "ContextTypes.DEFAULT_TYPE") -> None:
    if not update.message or not update.effective_chat:
        return
    chat_id = update.effective_chat.id
    if chat_id not in _alert_chat_ids:
        _alert_chat_ids.append(chat_id)
        _save_alert_chat_ids(_alert_chat_ids)
        log.info("Alert chat registered: %s", chat_id)
    await update.message.reply_text(
        "✅ Цей чат отримуватиме алерти про збої і зупинки принтерів "
        "(текст помилки, код і фото з камери).\nВимкнути: /тривоги_вимкнути"
    )


async def _tg_alerts_off(update: "Update", _ctx: "ContextTypes.DEFAULT_TYPE") -> None:
    if not update.message or not update.effective_chat:
        return
    chat_id = update.effective_chat.id
    if chat_id in _alert_chat_ids:
        _alert_chat_ids.remove(chat_id)
        _save_alert_chat_ids(_alert_chat_ids)
        log.info("Alert chat removed: %s", chat_id)
    await update.message.reply_text("🔕 Цей чат більше не отримуватиме алерти.")


# ── Moonraker WebSocket subscriptions ────────────────────────────────────────

# URL → asyncio.Task mapping for active Moonraker WS subscription loops
_moonraker_sub_tasks: dict[str, "asyncio.Task[None]"] = {}

# Objects to subscribe to — mirrors backend LIVE_STATUS_OBJECTS
_MOONRAKER_OBJECTS = {
    "print_stats": None,
    "display_status": None,
    "virtual_sdcard": None,
    "extruder": None,
    "heater_bed": None,
    # U1: loaded spool colors/materials (filament_exist, filament_color_rgba, …)
    "print_task_config": None,
}

# dev_id → asyncio task/config for Bambu LAN-only MQTT subscriptions.
_bambu_lan_sub_tasks: dict[str, "asyncio.Task[None]"] = {}
_bambu_lan_sub_configs: dict[str, tuple[str, str]] = {}
_BAMBU_LAN_CONFIG_INTERVAL = 15
# dev_id → connected paho client from the monitor loop. Commands publish through
# this connection when alive (printers limit concurrent MQTT clients — P1/A1
# firmware tolerates very few, so we reuse the monitor connection like SimplyPrint).
_bambu_lan_live_clients: dict[str, object] = {}
# Spec: P1 series must not receive pushall more often than every 5 minutes.
_BAMBU_PUSHALL_INTERVAL = 300

# Bambu Lab root CA (public, ships with Bambu Studio/SimplyPrint; valid to 2032).
# Printer leaf certs (MQTT :8883, FTPS :990, camera :6000) chain to this CA with
# CN = printer serial — we verify the chain but skip hostname checks (we dial IPs).
_BAMBU_CA_PEM = """-----BEGIN CERTIFICATE-----
MIIDZTCCAk2gAwIBAgIUV1FckwXElyek1onFnQ9kL7Bk4N8wDQYJKoZIhvcNAQEL
BQAwQjELMAkGA1UEBhMCQ04xIjAgBgNVBAoMGUJCTCBUZWNobm9sb2dpZXMgQ28u
LCBMdGQxDzANBgNVBAMMBkJCTCBDQTAeFw0yMjA0MDQwMzQyMTFaFw0zMjA0MDEw
MzQyMTFaMEIxCzAJBgNVBAYTAkNOMSIwIAYDVQQKDBlCQkwgVGVjaG5vbG9naWVz
IENvLiwgTHRkMQ8wDQYDVQQDDAZCQkwgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IB
DwAwggEKAoIBAQDL3pnDdxGOk5Z6vugiT4dpM0ju+3Xatxz09UY7mbj4tkIdby4H
oeEdiYSZjc5LJngJuCHwtEbBJt1BriRdSVrF6M9D2UaBDyamEo0dxwSaVxZiDVWC
eeCPdELpFZdEhSNTaT4O7zgvcnFsfHMa/0vMAkvE7i0qp3mjEzYLfz60axcDoJLk
p7n6xKXI+cJbA4IlToFjpSldPmC+ynOo7YAOsXt7AYKY6Glz0BwUVzSJxU+/+VFy
/QrmYGNwlrQtdREHeRi0SNK32x1+bOndfJP0sojuIrDjKsdCLye5CSZIvqnbowwW
1jRwZgTBR29Zp2nzCoxJYcU9TSQp/4KZuWNVAgMBAAGjUzBRMB0GA1UdDgQWBBSP
NEJo3GdOj8QinsV8SeWr3US+HjAfBgNVHSMEGDAWgBSPNEJo3GdOj8QinsV8SeWr
3US+HjAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQABlBIT5ZeG
fgcK1LOh1CN9sTzxMCLbtTPFF1NGGA13mApu6j1h5YELbSKcUqfXzMnVeAb06Htu
3CoCoe+wj7LONTFO++vBm2/if6Jt/DUw1CAEcNyqeh6ES0NX8LJRVSe0qdTxPJuA
BdOoo96iX89rRPoxeed1cpq5hZwbeka3+CJGV76itWp35Up5rmmUqrlyQOr/Wax6
itosIzG0MfhgUzU51A2P/hSnD3NDMXv+wUY/AvqgIL7u7fbDKnku1GzEKIkfH8hm
Rs6d8SCU89xyrwzQ0PR853irHas3WrHVqab3P+qNwR0YirL0Qk7Xt/q3O1griNg2
Blbjg3obpHo9
-----END CERTIFICATE-----
"""

# Targets where BBL-CA verification failed — fall back to unverified TLS
# (matches pre-0.6.0 behaviour, so no printer can regress to "offline").
_bambu_tls_insecure: set[str] = set()
# ip → consecutive verified-connect timeouts; ≥2 flips the target to insecure
# (paho's async loop hides handshake errors, a timeout is all we observe).
_bambu_tls_timeouts: dict[str, int] = {}


def _bambu_ssl_context(ip: str) -> ssl.SSLContext:
    """TLS context for Bambu LAN services: pinned BBL CA, hostname checks off."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    if ip in _bambu_tls_insecure:
        ctx.verify_mode = ssl.CERT_NONE
        return ctx
    ctx.verify_mode = ssl.CERT_REQUIRED
    ctx.load_verify_locations(cadata=_BAMBU_CA_PEM)
    if hasattr(ssl, "VERIFY_X509_STRICT"):
        # Python 3.13+: printer leaf certs predate the strict X.509 rules
        ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
    return ctx


def _bambu_mark_tls_failure(ip: str, exc: Exception) -> None:
    """Demote a target to unverified TLS after an SSL error or repeated timeouts."""
    if ip in _bambu_tls_insecure:
        return
    if isinstance(exc, ssl.SSLError) or "SSL" in str(exc) or "certificate" in str(exc).lower():
        log.warning("Bambu TLS verify failed for %s — falling back to unverified", ip)
        _bambu_tls_insecure.add(ip)
        return
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError, RuntimeError)):
        _bambu_tls_timeouts[ip] = _bambu_tls_timeouts.get(ip, 0) + 1
        if _bambu_tls_timeouts[ip] >= 2:
            log.info("Bambu connect kept timing out for %s — retrying with unverified TLS", ip)
            _bambu_tls_insecure.add(ip)


async def _u1_camera_keepalive(mr_ws, moonraker_url: str) -> None:
    """Keep the stock U1 camera monitor updating its JPEG file.

    Stock U1 firmware stops refreshing /server/files/camera/monitor.jpg when
    nothing has recently asked it to start the LAN camera monitor. Reusing the
    already-open Moonraker websocket avoids another connection per printer.
    """
    payload = json.dumps({
        "jsonrpc": "2.0",
        "method": "camera.start_monitor",
        "params": {"domain": "lan", "interval": 0},
        # Stock U1 Moonraker converts req_id to int before dispatching camera
        # commands; a string id is rejected with HTTP/WebSocket error 400.
        "id": 9001,
    })
    while True:
        try:
            await mr_ws.send(payload)
        except Exception:
            return
        await asyncio.sleep(10)


async def _moonraker_ws_loop(cloud_ws, moonraker_url: str, printer_kind: str | None = None) -> None:
    """Maintain a persistent Moonraker WS subscription and push STATUS_PUSH to cloud.

    Moonraker sends the full state in the subscribe response, then incremental
    diffs via notify_status_update. We merge diffs into a full-state dict and
    always forward the complete snapshot so the backend can parse it directly.
    """
    import urllib.parse as _urlparse

    parsed = _urlparse.urlparse(moonraker_url)
    host = parsed.hostname or "localhost"
    port = parsed.port or 7125
    ws_url = f"ws://{host}:{port}/websocket"

    subscribe_msg = json.dumps({
        "jsonrpc": "2.0",
        "method": "printer.objects.subscribe",
        "params": {"objects": _MOONRAKER_OBJECTS},
        "id": 1,
    })

    while True:
        full_state: dict = {}
        try:
            async with websockets.connect(
                ws_url, ping_interval=20, ping_timeout=10, open_timeout=10
            ) as mr_ws:
                log.info("MOONRAKER_SUBSCRIBE: connected %s", ws_url)
                camera_task = (
                    asyncio.create_task(_u1_camera_keepalive(mr_ws, moonraker_url))
                    if printer_kind == "snapmaker_u1" else None
                )
                await mr_ws.send(subscribe_msg)
                try:
                    async for message in mr_ws:
                        try:
                            data = json.loads(message)
                        except Exception:
                            continue

                        # Subscribe result — Moonraker returns full current state
                        if data.get("id") == 1 and "result" in data:
                            full_state = (data["result"] or {}).get("status") or {}

                        # Incremental diff — merge into accumulated full state
                        elif data.get("method") == "notify_status_update":
                            params = data.get("params", [])
                            if params and isinstance(params[0], dict):
                                for key, val in params[0].items():
                                    existing = full_state.get(key)
                                    if isinstance(existing, dict) and isinstance(val, dict):
                                        full_state[key] = {**existing, **val}
                                    else:
                                        full_state[key] = val
                        else:
                            continue

                        if not full_state:
                            continue
                        try:
                            await cloud_ws.send(json.dumps({
                                "type": "STATUS_PUSH",
                                "url": moonraker_url,
                                "status": full_state,
                            }))
                        except Exception as e:
                            log.debug("STATUS_PUSH send failed, stopping loop: %s", e)
                            return  # cloud WS gone — task will be cancelled on reconnect

                        # Local failure/stop detection (off the forwarding path).
                        _state, _etext, _ecode = _classify_moonraker(full_state.get("print_stats") or {})
                        if _alert_should_fire(f"mr:{moonraker_url}", _state, _ecode):
                            asyncio.create_task(_dispatch_alert(
                                _moonraker_names.get(moonraker_url) or host or moonraker_url,
                                _state, _etext, _ecode, "moonraker",
                                {"moonraker_url": moonraker_url},
                            ))
                finally:
                    if camera_task:
                        camera_task.cancel()
                        await asyncio.gather(camera_task, return_exceptions=True)

        except asyncio.CancelledError:
            log.debug("MOONRAKER_SUBSCRIBE: task cancelled for %s", moonraker_url)
            return
        except (OSError, websockets.exceptions.WebSocketException) as e:
            log.debug("MOONRAKER_SUBSCRIBE: %s disconnected (%s) — retrying in 5s", moonraker_url, e)
        except Exception as e:
            log.warning("MOONRAKER_SUBSCRIBE: unexpected error for %s: %s — retrying", moonraker_url, e)

        await asyncio.sleep(5)


async def handle_moonraker_subscribe(cloud_ws, req: dict) -> None:
    """Start (or restart) a Moonraker WS subscription for the given printer URL."""
    req_id = req.get("id")
    url = req.get("url", "").rstrip("/")
    if not url:
        await cloud_ws.send(json.dumps({
            "id": req_id, "status": 400, "body": None, "error": "missing url",
        }))
        return

    name = (req.get("name") or "").strip()
    if name:
        _moonraker_names[url] = name

    existing = _moonraker_sub_tasks.pop(url, None)
    if existing and not existing.done():
        existing.cancel()

    task = asyncio.create_task(_moonraker_ws_loop(cloud_ws, url, req.get("kind")))
    _moonraker_sub_tasks[url] = task

    await cloud_ws.send(json.dumps({
        "id": req_id, "status": 200, "body": {"ok": True}, "error": None,
    }))


def _cancel_all_subscriptions() -> None:
    for task in list(_moonraker_sub_tasks.values()):
        task.cancel()
    _moonraker_sub_tasks.clear()


def _mqtt_rc_value(rc) -> int:
    try:
        return int(rc)
    except Exception:
        return int(getattr(rc, "value", 0) or 0)


def ensure_bambu_mqtt_dependency() -> None:
    """Best-effort self-heal for agents auto-updated from pre-LAN-MQTT builds."""
    try:
        import paho.mqtt.client  # noqa: F401
        return
    except ImportError:
        pass

    try:
        import subprocess
        log.info("Installing paho-mqtt for Bambu LAN support…")
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "--quiet", "paho-mqtt"],
            check=False,
            timeout=60,
        )
    except Exception as exc:
        log.debug("paho-mqtt install skipped: %s", exc)


def _mqtt_connect_hint(rc: int) -> str:
    """Map a paho connect rc to an actionable message for the farm operator."""
    if rc in (4, 5):  # bad credentials / not authorized
        return (
            f"connect rc={rc}: принтер відхилив доступ — перевір LAN Access Code; "
            "на прошивці X1/P1 ≥01.07 або A1 ≥01.03 увімкни LAN Only Mode + Developer Mode на принтері"
        )
    return f"connect rc={rc}"


def _bambu_publish_via_live_client(dev_id: str, payload: dict) -> bool:
    """Publish through the persistent monitor connection if it is alive (QoS 1)."""
    client = _bambu_lan_live_clients.get(dev_id)
    if client is None or not getattr(client, "is_connected", lambda: False)():
        return False
    info = client.publish(
        f"device/{dev_id}/request",
        json.dumps(payload, separators=(",", ":")),
        qos=1,
    )
    info.wait_for_publish(timeout=10)
    if not info.is_published():
        raise RuntimeError("publish timeout (live client)")
    return True


def _bambu_mqtt_publish_blocking(dev_id: str, ip: str, access_code: str, payload: dict) -> None:
    """Publish one Bambu LAN MQTT command from a worker thread.

    Prefers the persistent monitor connection (printers limit concurrent MQTT
    clients); falls back to a one-shot connection when no monitor is running.
    """
    try:
        import paho.mqtt.client as mqtt
    except ImportError as exc:
        raise RuntimeError("paho-mqtt is required for Bambu LAN MQTT") from exc

    if _bambu_publish_via_live_client(dev_id, payload):
        return

    connected = threading.Event()
    errors: list[str] = []

    def _on_connect(client, userdata, flags, reason_code, properties=None):
        rc = _mqtt_rc_value(reason_code)
        if rc != 0:
            errors.append(_mqtt_connect_hint(rc))
        connected.set()

    client = mqtt.Client(
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
        protocol=mqtt.MQTTv311,
        client_id=f"monofarm-agent-cmd-{dev_id}",
    )
    client.username_pw_set("bblp", access_code)
    client.tls_set_context(_bambu_ssl_context(ip))
    client.on_connect = _on_connect

    try:
        try:
            client.connect(ip, 8883, 60)
        except ssl.SSLError as exc:
            _bambu_mark_tls_failure(ip, exc)
            client.tls_set_context(_bambu_ssl_context(ip))
            client.connect(ip, 8883, 60)
        client.loop_start()
        if not connected.wait(10):
            raise RuntimeError("connect timeout")
        if errors:
            raise RuntimeError(errors[-1])
        info = client.publish(
            f"device/{dev_id}/request",
            json.dumps(payload, separators=(",", ":")),
            qos=1,
        )
        info.wait_for_publish(timeout=10)
        if not info.is_published():
            raise RuntimeError("publish timeout")
    finally:
        try:
            client.loop_stop()
            client.disconnect()
        except Exception:
            pass


async def handle_bambu_mqtt(ws, req: dict) -> None:
    """Publish a Bambu LAN MQTT command on behalf of the cloud backend."""
    req_id = req.get("id")
    dev_id = (req.get("dev_id") or "").strip()
    ip = (req.get("ip") or "").strip()
    access_code = (req.get("access_code") or "").strip()
    payload = req.get("payload") or {}
    try:
        if not dev_id or not ip or not access_code or not isinstance(payload, dict):
            raise ValueError("missing dev_id/ip/access_code/payload")
        await asyncio.to_thread(_bambu_mqtt_publish_blocking, dev_id, ip, access_code, payload)
        result = {"id": req_id, "status": 200, "body": {"ok": True}, "error": None}
    except Exception as exc:
        log.warning("BAMBU_MQTT error %s@%s: %s", dev_id, ip, exc)
        result = {"id": req_id, "status": 502, "body": None, "error": str(exc)}
    try:
        await ws.send(json.dumps(result))
    except websockets.exceptions.ConnectionClosed as exc:
        log.warning("BAMBU_MQTT response dropped after cloud disconnect: %s", exc)


async def _bambu_lan_mqtt_loop(cloud_ws, printer: dict) -> None:
    """Maintain a direct LAN MQTT subscription and push reports to SaaS."""
    try:
        import paho.mqtt.client as mqtt
    except ImportError:
        log.warning("Bambu LAN monitor disabled: install paho-mqtt")
        return

    dev_id = (printer.get("dev_id") or "").strip()
    ip = (printer.get("ip") or "").strip()
    access_code = (printer.get("access_code") or "").strip()
    name = printer.get("name") or dev_id
    if not dev_id or not ip or not access_code:
        return

    pushall_msg = json.dumps(
        {"pushing": {"command": "pushall", "sequence_id": "0", "version": 1, "push_target": 1}},
        separators=(",", ":"),
    )

    while True:
        connected = asyncio.Event()
        connect_errors: list[str] = []
        loop = asyncio.get_running_loop()
        client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            protocol=mqtt.MQTTv311,
            client_id=f"monofarm-agent-lan-{dev_id}",
        )
        client.username_pw_set("bblp", access_code)
        client.tls_set_context(_bambu_ssl_context(ip))

        def _on_connect(client, userdata, flags, reason_code, properties=None):
            rc = _mqtt_rc_value(reason_code)
            if rc != 0:
                log.warning("BAMBU_LAN_SUB connect failed %s (%s): rc=%s", name, ip, rc)
                connect_errors.append(f"connect rc={rc}")
                loop.call_soon_threadsafe(connected.set)
                return
            log.info("BAMBU_LAN_SUB connected %s (%s)", name, ip)
            client.subscribe(f"device/{dev_id}/report")
            client.publish(f"device/{dev_id}/request", pushall_msg)
            _bambu_lan_live_clients[dev_id] = client
            loop.call_soon_threadsafe(connected.set)

        def _on_disconnect(client, userdata, disconnect_flags, reason_code, properties=None):
            rc = _mqtt_rc_value(reason_code)
            if rc != 0:
                log.warning("BAMBU_LAN_SUB disconnected %s (%s): rc=%s", name, ip, rc)

        def _on_message(client, userdata, msg):
            try:
                payload = json.loads(msg.payload)
            except Exception:
                return
            asyncio.run_coroutine_threadsafe(
                cloud_ws.send(json.dumps({
                    "type": "BAMBU_STATUS_PUSH",
                    "dev_id": dev_id,
                    "payload": payload,
                })),
                loop,
            )
            # Local failure/stop detection. Reports are deltas — merge first.
            pd = payload.get("print")
            if isinstance(pd, dict):
                merged = {**_bambu_print_state.get(dev_id, {}), **pd}
                _bambu_print_state[dev_id] = merged
                _state, _etext, _ecode = _classify_bambu(merged)
                if _alert_should_fire(f"bambu:{dev_id}", _state, _ecode):
                    asyncio.run_coroutine_threadsafe(
                        _dispatch_alert(
                            name, _state, _etext, _ecode, "bambu",
                            {"ip": ip, "access_code": access_code},
                        ),
                        loop,
                    )

        client.on_connect = _on_connect
        client.on_disconnect = _on_disconnect
        client.on_message = _on_message

        try:
            client.connect_async(ip, 8883, 60)
            client.loop_start()
            await asyncio.wait_for(connected.wait(), timeout=12)
            if connect_errors:
                raise RuntimeError(connect_errors[-1])
            _bambu_tls_timeouts.pop(ip, None)
            while True:
                # P1/A1 send delta reports only — a throttled pushall keeps the
                # merged server-side state from drifting (spec: max 1 per 5 min).
                await asyncio.sleep(_BAMBU_PUSHALL_INTERVAL)
                if client.is_connected():
                    client.publish(f"device/{dev_id}/request", pushall_msg)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            _bambu_mark_tls_failure(ip, exc)
            log.warning("BAMBU_LAN_SUB error %s (%s): %s — retrying", name, ip, exc)
        finally:
            if _bambu_lan_live_clients.get(dev_id) is client:
                _bambu_lan_live_clients.pop(dev_id, None)
            try:
                client.loop_stop()
                client.disconnect()
            except Exception:
                pass
        await asyncio.sleep(5)


async def _sync_bambu_lan_subscriptions(cloud_ws, printers: list[dict]) -> None:
    wanted: dict[str, dict] = {
        p["dev_id"]: p
        for p in printers
        if p.get("dev_id") and p.get("ip") and p.get("access_code")
    }

    for dev_id in list(_bambu_lan_sub_tasks):
        if dev_id not in wanted:
            _bambu_lan_sub_tasks.pop(dev_id).cancel()
            _bambu_lan_sub_configs.pop(dev_id, None)

    for dev_id, printer in wanted.items():
        cfg = (printer["ip"], printer["access_code"])
        task = _bambu_lan_sub_tasks.get(dev_id)
        if task is not None and not task.done() and _bambu_lan_sub_configs.get(dev_id) == cfg:
            continue
        if task is not None:
            task.cancel()
        _bambu_lan_sub_configs[dev_id] = cfg
        _bambu_lan_sub_tasks[dev_id] = asyncio.create_task(_bambu_lan_mqtt_loop(cloud_ws, printer))


def _cancel_all_bambu_lan_subscriptions() -> None:
    for task in list(_bambu_lan_sub_tasks.values()):
        task.cancel()
    _bambu_lan_sub_tasks.clear()
    _bambu_lan_sub_configs.clear()


async def _bambu_lan_config_loop(cloud_ws, server: str, token: str) -> None:
    headers = {"Authorization": f"Bearer {token}"}
    last_discover = 0.0
    while True:
        try:
            now = asyncio.get_running_loop().time()
            async with httpx.AsyncClient(timeout=10) as client:
                if now - last_discover >= 60:
                    try:
                        await client.get(f"{server}/api/printers/bambu-discover", headers=headers)
                        last_discover = now
                    except Exception as exc:
                        log.debug("Bambu LAN discovery refresh failed: %s", exc)
                resp = await client.get(f"{server}/api/agent/bambu-lan-config", headers=headers)
            if resp.status_code == 200:
                printers = (resp.json() or {}).get("printers") or []
                await _sync_bambu_lan_subscriptions(cloud_ws, printers)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.debug("Bambu LAN config refresh failed: %s", exc)
        await asyncio.sleep(_BAMBU_LAN_CONFIG_INTERVAL)


def _load_config() -> dict[str, str]:
    cfg = {"MONOFARM_SERVER": "https://api.monofarm.app", "MONOFARM_FRONTEND": "https://monofarm.app", "MONOFARM_TOKEN": ""}
    if CONFIG_FILE.exists():
        for line in CONFIG_FILE.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.startswith("#"):
                k, _, v = line.partition("=")
                cfg[k.strip()] = v.strip()
    return cfg


def _write_config(cfg: dict[str, str]) -> None:
    """Atomically persist config (temp + os.replace) so a crash can't truncate it."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    data = "".join(f"{k}={v}\n" for k, v in cfg.items() if v != "")
    tmp = CONFIG_DIR / ".env.tmp"
    tmp.write_text(data, encoding="utf-8")
    try:
        tmp.chmod(0o600)
    except Exception:
        pass
    os.replace(tmp, CONFIG_FILE)


def _save_config(server: str, token: str) -> None:
    cfg = _load_config()
    cfg["MONOFARM_SERVER"] = server
    cfg["MONOFARM_TOKEN"] = token
    _write_config(cfg)


def _load_alert_chat_ids() -> list[int]:
    out: list[int] = []
    for part in (_load_config().get("ALERT_CHAT_IDS", "") or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            out.append(int(part))
        except ValueError:
            pass
    return out


def _save_alert_chat_ids(ids: list[int]) -> None:
    cfg = _load_config()
    cfg["ALERT_CHAT_IDS"] = ",".join(str(i) for i in ids)
    _write_config(cfg)


# ── Local web UI (stdlib only — no Flask, works on a headless Pi) ────────────
#
# Same role as the SimplyPrint client's local web interface: open
# http://<agent-host>:8723 from any machine on the farm LAN to check status,
# scan for printers, pair with the cloud and read logs. Trusted-LAN model,
# like SimplyPrint's: the UI never displays the saved token.


def _schedule_restart(delay: float = 0.7) -> None:
    """Restart the agent process shortly after the HTTP response is sent."""
    def _do() -> None:
        log.info("Restarting agent (web UI request)…")
        os.execv(sys.executable, [sys.executable] + sys.argv)
    loop = _main_loop
    if loop is not None:
        loop.call_soon_threadsafe(lambda: loop.call_later(delay, _do))
    else:
        threading.Timer(delay, _do).start()


def _web_state() -> dict:
    bambu = []
    for dev_id, task in _bambu_lan_sub_tasks.items():
        client = _bambu_lan_live_clients.get(dev_id)
        connected = bool(client is not None and getattr(client, "is_connected", lambda: False)())
        ip = _bambu_lan_sub_configs.get(dev_id, ("", ""))[0]
        bambu.append({"dev_id": dev_id, "ip": ip, "connected": connected, "alive": not task.done()})
    moonraker = [{"url": url, "alive": not task.done()} for url, task in _moonraker_sub_tasks.items()]
    return {
        "version": AGENT_VERSION,
        "server": _current_server or _load_config().get("MONOFARM_SERVER", ""),
        "cloud_connected": _cloud_connected,
        "has_token": bool(_load_config().get("MONOFARM_TOKEN")),
        "tg_running": _tg_app is not None,
        "bambu": bambu,
        "moonraker": moonraker,
        "alert_chat_ids": list(_alert_chat_ids),
    }


def _h(value: object) -> str:
    return _htmlmod.escape(str(value), quote=True)


_WEB_CSS = """
body{background:#101216;color:#e6e8eb;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;
     margin:0;padding:24px;max-width:760px;margin-inline:auto}
h1{font-size:18px;margin:0 0 4px} h2{font-size:14px;margin:20px 0 8px;color:#9aa1ab}
a{color:#7ab8ff} .muted{color:#9aa1ab}
.card{background:#171a20;border:1px solid #262b33;border-radius:10px;padding:14px 16px;margin:10px 0}
.chip{display:inline-block;padding:1px 10px;border-radius:999px;font-size:12px;font-weight:600}
.ok{background:#11331f;color:#5fd38a} .bad{background:#3a1a1a;color:#ff8c8c} .idle{background:#252a33;color:#9aa1ab}
table{width:100%;border-collapse:collapse} td,th{text-align:left;padding:4px 8px;border-bottom:1px solid #20252d;font-size:13px}
input{background:#0d0f13;color:#e6e8eb;border:1px solid #2a3039;border-radius:8px;padding:7px 10px;width:100%;box-sizing:border-box}
button{background:#2563eb;color:#fff;border:0;border-radius:8px;padding:7px 14px;font-weight:600;cursor:pointer}
button.ghost{background:#252a33} form.inline{display:inline}
pre{background:#0d0f13;border:1px solid #20252d;border-radius:8px;padding:10px;font-size:12px;
    overflow-x:auto;white-space:pre-wrap;word-break:break-all;max-height:480px;overflow-y:auto}
label{display:block;margin:8px 0 3px;font-size:12px;color:#9aa1ab}
"""


def _web_page(title: str, body: str, refresh: int | None = None) -> bytes:
    meta = f'<meta http-equiv="refresh" content="{refresh}">' if refresh else ""
    return (
        f"<!doctype html><html><head><meta charset='utf-8'>{meta}"
        f"<meta name='viewport' content='width=device-width,initial-scale=1'>"
        f"<title>{_h(title)}</title><style>{_WEB_CSS}</style></head>"
        f"<body><h1>monofarm-agent <span class='muted'>v{_h(AGENT_VERSION)}</span></h1>"
        f"{body}</body></html>"
    ).encode("utf-8")


def _render_dashboard() -> bytes:
    st = _web_state()
    cloud_chip = (
        "<span class='chip ok'>підключено</span>" if st["cloud_connected"]
        else "<span class='chip bad'>немає зв'язку</span>"
    )
    tg_chip = "<span class='chip ok'>працює</span>" if st["tg_running"] else "<span class='chip idle'>вимкнено</span>"
    token_chip = "<span class='chip ok'>збережено</span>" if st["has_token"] else "<span class='chip bad'>немає</span>"

    bambu_rows = "".join(
        f"<tr><td>{_h(p['dev_id'])}</td><td>{_h(p['ip'])}</td>"
        f"<td>{'<span class=chip ok>online</span>' if p['connected'] else '<span class=chip idle>reconnect…</span>'}</td></tr>"
        for p in st["bambu"]
    ) or "<tr><td colspan=3 class=muted>немає LAN-принтерів (додаються в monofarm Settings)</td></tr>"

    mr_rows = "".join(
        f"<tr><td>{_h(m['url'])}</td>"
        f"<td>{'<span class=chip ok>підписка</span>' if m['alive'] else '<span class=chip idle>reconnect…</span>'}</td></tr>"
        for m in st["moonraker"]
    ) or "<tr><td colspan=2 class=muted>немає Moonraker-принтерів</td></tr>"

    logs_tail = "\n".join(list(_LOG_BUFFER)[-25:])

    body = f"""
<div class='card'>
  <table>
    <tr><td>Хмара ({_h(st['server'])})</td><td>{cloud_chip}</td></tr>
    <tr><td>Токен</td><td>{token_chip}</td></tr>
    <tr><td>Telegram-бот</td><td>{tg_chip}</td></tr>
  </table>
  <div style='margin-top:10px'>
    <form class='inline' method='post' action='/update'><button class='ghost'>Перевірити оновлення</button></form>
    <form class='inline' method='post' action='/restart'><button class='ghost'>Перезапустити</button></form>
  </div>
</div>
<h2>Bambu LAN принтери</h2>
<div class='card'><table><tr><th>Серійник</th><th>IP</th><th>MQTT</th></tr>{bambu_rows}</table>
  <form method='post' action='/scan' style='margin-top:10px'><button>Сканувати мережу (SSDP)</button></form>
</div>
<h2>Moonraker принтери</h2>
<div class='card'><table>{mr_rows}</table></div>
<h2>Алерти про збої (Telegram)</h2>
<div class='card'>
  <p class='muted'>Додай бота у груповий чат і напиши там <code>/тривоги_тут</code> —
  цей чат отримуватиме фото + текст + код помилки при збоях і зупинках. Або вкажи chat_id вручну:</p>
  <form method='post' action='/alerts'>
    <label>Chat IDs (через кому)</label>
    <input name='chat_ids' value='{_h(",".join(str(i) for i in st["alert_chat_ids"]))}'>
    <div style='margin-top:10px'><button>Зберегти</button></div>
  </form>
</div>
<h2>Підключення до monofarm</h2>
<div class='card'>
  <form method='post' action='/pair'>
    <label>Server URL</label><input name='server' value='{_h(st['server'])}'>
    <label>Token (JWT — лиши порожнім, щоб не змінювати)</label><input name='token' type='password' autocomplete='off'>
    <div style='margin-top:10px'><button>Зберегти й перезапустити</button></div>
  </form>
</div>
<h2>Журнал <a href='/logs' style='font-weight:400;font-size:12px'>повний →</a></h2>
<pre>{_h(logs_tail)}</pre>
"""
    return _web_page("monofarm-agent", body, refresh=5)


def _render_scan() -> bytes:
    try:
        devices = _bambu_ssdp_scan(4.0)
    except Exception as e:
        return _web_page("Сканування", f"<div class='card'>Помилка сканування: {_h(e)}</div><a href='/'>← назад</a>")
    rows = "".join(
        f"<tr><td>{_h(d['dev_id'])}</td><td>{_h(d['ip'])}</td><td>{_h(d['name'])}</td><td>{_h(d['model'])}</td></tr>"
        for d in devices
    ) or "<tr><td colspan=4 class=muted>нічого не знайдено — переконайся, що принтери в LAN-режимі й у цій же мережі</td></tr>"
    body = (
        f"<h2>Знайдені принтери</h2><div class='card'><table>"
        f"<tr><th>Серійник</th><th>IP</th><th>Назва</th><th>Модель</th></tr>{rows}</table></div>"
        f"<p class='muted'>Додай принтер у monofarm → Settings, вказавши IP та Access Code з екрана принтера.</p>"
        f"<a href='/'>← назад</a>"
    )
    return _web_page("Сканування", body)


def _start_web_ui(port: int) -> None:
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class _Handler(BaseHTTPRequestHandler):
        def _send(self, payload: bytes, code: int = 200, ctype: str = "text/html; charset=utf-8") -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def _redirect(self, location: str = "/") -> None:
            self.send_response(303)
            self.send_header("Location", location)
            self.end_headers()

        def _form(self) -> dict[str, str]:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length).decode("utf-8", errors="ignore") if length else ""
            return {k: v[0] for k, v in _urlparse_mod.parse_qs(raw).items()}

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/" or self.path.startswith("/?"):
                self._send(_render_dashboard())
            elif self.path == "/logs":
                body = f"<a href='/'>← назад</a><pre>{_h(chr(10).join(_LOG_BUFFER))}</pre>"
                self._send(_web_page("Журнал", body, refresh=3))
            elif self.path == "/healthz":
                self._send(json.dumps(_web_state()).encode(), ctype="application/json")
            else:
                self._send(b"not found", code=404, ctype="text/plain")

        def do_POST(self) -> None:  # noqa: N802
            if self.path == "/scan":
                self._send(_render_scan())
            elif self.path == "/pair":
                form = self._form()
                cfg = _load_config()
                server = (form.get("server") or cfg.get("MONOFARM_SERVER") or "").strip().rstrip("/")
                token = (form.get("token") or "").strip() or cfg.get("MONOFARM_TOKEN", "")
                _save_config(server, token)
                self._send(_web_page("Збережено", "<div class='card'>Налаштування збережено — агент перезапускається…</div><a href='/'>← на головну</a>"))
                _schedule_restart()
            elif self.path == "/update":
                loop = _main_loop
                if loop is not None and _current_server:
                    asyncio.run_coroutine_threadsafe(check_for_update(_current_server), loop)
                self._redirect("/")
            elif self.path == "/restart":
                self._send(_web_page("Перезапуск", "<div class='card'>Агент перезапускається…</div><a href='/'>← на головну</a>"))
                _schedule_restart()
            elif self.path == "/alerts":
                global _alert_chat_ids
                form = self._form()
                ids: list[int] = []
                for part in (form.get("chat_ids") or "").split(","):
                    part = part.strip()
                    if not part:
                        continue
                    try:
                        ids.append(int(part))
                    except ValueError:
                        pass
                _alert_chat_ids = ids
                _save_alert_chat_ids(ids)
                self._redirect("/")
            else:
                self._send(b"not found", code=404, ctype="text/plain")

        def log_message(self, *_args) -> None:
            pass  # keep the agent log clean of HTTP access noise

    try:
        httpd = ThreadingHTTPServer(("0.0.0.0", port), _Handler)
    except OSError as e:
        log.warning("Web UI not started on :%s (%s)", port, e)
        return
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    log.info("Web UI: http://localhost:%s (доступний у локальній мережі)", port)


async def check_for_update(server: str) -> None:
    """Download and apply a new agent version, then restart.

    Frozen (PyInstaller .exe): download and hot-swap the running .exe on Windows.
    Source (venv / dev): rewrite the .py files and re-exec the interpreter.
    """
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            resp = await client.get(f"{server}/api/agent/version")
            if resp.status_code != 200:
                return
            remote = resp.json().get("version", "")
            if not remote or remote == AGENT_VERSION:
                return
            log.info("Update available: %s → %s. Downloading…", AGENT_VERSION, remote)
            if getattr(sys, "frozen", False):
                await _apply_frozen_update(client, server, remote)
            else:
                await _apply_source_update(client, server, remote)
    except Exception as e:
        log.debug("Update check skipped: %s", e)


async def _apply_source_update(client: "httpx.AsyncClient", server: str, remote: str) -> None:
    """venv/dev path: rewrite .py files beside us and re-exec the interpreter."""
    here = Path(__file__).resolve().parent
    for fname in ("monofarm_agent.py", "monofarm_tray.py"):
        target = here / fname
        if fname == "monofarm_agent.py" or target.exists():
            r = await client.get(f"{server}/agent/{fname}")
            if r.status_code == 200:
                target.write_bytes(r.content)
    try:
        import subprocess
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "--quiet", "paho-mqtt"],
            check=False, timeout=60,
        )
    except Exception as dep_exc:
        log.debug("Dependency refresh skipped: %s", dep_exc)
    log.info("Updated to %s. Restarting…", remote)
    os.execv(sys.executable, [sys.executable] + sys.argv)


async def _apply_frozen_update(client: "httpx.AsyncClient", server: str, remote: str) -> None:
    """Windows .exe self-update: download the new exe, hot-swap it, relaunch.

    Windows allows renaming a running .exe, so we move the live exe aside, drop
    the new one in its place, spawn it, and exit. The stale *.old.exe is removed
    on the next launch by _cleanup_old_exe().
    """
    exe = Path(sys.executable).resolve()
    new = exe.parent / (exe.stem + ".new.exe")
    old = exe.parent / (exe.stem + ".old.exe")
    r = await client.get(f"{server}/agent/monofarm-agent.exe")
    r.raise_for_status()
    new.write_bytes(r.content)
    try:
        old.unlink(missing_ok=True)
    except Exception:
        pass
    os.replace(exe, old)   # move the running exe aside (allowed on Windows)
    os.replace(new, exe)   # put the new exe in place
    log.info("Updated to %s. Relaunching…", remote)
    import subprocess
    subprocess.Popen([str(exe)], close_fds=True)
    os._exit(0)


def _cleanup_old_exe() -> None:
    """Delete the leftover *.old.exe from a previous frozen self-update."""
    if not getattr(sys, "frozen", False):
        return
    try:
        exe = Path(sys.executable).resolve()
        (exe.parent / (exe.stem + ".old.exe")).unlink(missing_ok=True)
    except Exception:
        pass


async def _update_loop(server: str) -> None:
    while True:
        await asyncio.sleep(UPDATE_INTERVAL)
        await check_for_update(server)


async def handle_request(ws, req: dict) -> None:
    """Proxy a single HTTP request/response."""
    req_id = req.get("id")
    url    = req.get("url", "")
    method = req.get("method", "GET").upper()
    body   = req.get("body")

    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT, verify=False) as client:  # noqa: S501
            resp = await client.request(method, url, json=body)
            content_type = resp.headers.get("content-type", "")
            if "json" in content_type or resp.content.startswith(b"{") or resp.content.startswith(b"["):
                try:
                    resp_body = resp.json()
                    result = {"id": req_id, "status": resp.status_code, "body": resp_body, "error": None}
                except Exception:
                    result = {"id": req_id, "status": resp.status_code, "body": {"raw": resp.text}, "error": None}
            else:
                # Binary response (e.g. JPEG image) — base64 encode
                result = {
                    "id": req_id,
                    "status": resp.status_code,
                    "body": None,
                    "binary": base64.b64encode(resp.content).decode(),
                    "content_type": content_type,
                    "error": None,
                }
    except httpx.TimeoutException:
        log.warning("Timeout proxying %s %s", method, url)
        result = {"id": req_id, "status": 504, "body": None, "error": "timeout"}
    except Exception as e:
        log.warning("Error proxying %s %s: %s", method, url, e)
        result = {"id": req_id, "status": 502, "body": None, "error": str(e)}

    await ws.send(json.dumps(result))


def _parse_bambu_ssdp(data: bytes, sender_ip: str) -> dict | None:
    """Parse one Bambu SSDP NOTIFY/M-SEARCH response into a device dict."""
    try:
        text = data.decode("utf-8", errors="ignore")
    except Exception:
        return None
    if "bambulab" not in text.lower() and "USN" not in text:
        return None
    headers: dict[str, str] = {}
    for line in text.split("\r\n")[1:]:
        if ":" in line:
            key, _, value = line.partition(":")
            headers[key.strip().lower()] = value.strip()
    serial = headers.get("usn", "")
    if not serial:
        return None
    ip = headers.get("location", "") or sender_ip
    # Location can be a bare IP or a URL — normalize to the host part
    if "//" in ip:
        ip = ip.split("//", 1)[1].split("/", 1)[0].split(":", 1)[0]
    return {
        "dev_id": serial,
        "ip": ip or sender_ip,
        "name": headers.get("devname.bambu.com", ""),
        "model": headers.get("devmodel.bambu.com", ""),
    }


def _bambu_ssdp_scan(timeout: float = 4.0) -> list[dict]:
    """Discover Bambu printers via SSDP (what Bambu Studio and SimplyPrint use).

    Passive: printers broadcast NOTIFY to UDP :2021 every few seconds in LAN mode.
    Active: M-SEARCH to 239.255.255.250:1990 — printers unicast-reply to us.
    """
    import time

    results: dict[str, dict] = {}
    msearch = (
        "M-SEARCH * HTTP/1.1\r\n"
        "HOST: 239.255.255.250:1990\r\n"
        'MAN: "ssdp:discover"\r\n'
        "MX: 3\r\n"
        "ST: urn:bambulab-com:device:3dprinter:1\r\n"
        "\r\n"
    ).encode()

    sockets: list[socket.socket] = []
    try:
        tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        tx.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        tx.bind(("", 0))
        tx.settimeout(0.3)
        for target in ("239.255.255.250", "255.255.255.255"):
            for port in (1990, 2021):
                try:
                    tx.sendto(msearch, (target, port))
                except Exception:
                    pass
        sockets.append(tx)

        try:
            rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            rx.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            if hasattr(socket, "SO_REUSEPORT"):  # share :2021 with Bambu Studio
                rx.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
            rx.bind(("", 2021))
            try:
                mreq = socket.inet_aton("239.255.255.250") + socket.inet_aton("0.0.0.0")
                rx.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
            except Exception:
                pass
            rx.settimeout(0.3)
            sockets.append(rx)
        except Exception as e:
            log.debug("SSDP passive listen unavailable (%s) — active scan only", e)

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for sock in sockets:
                try:
                    data, addr = sock.recvfrom(8192)
                except (socket.timeout, BlockingIOError):
                    continue
                except Exception:
                    continue
                device = _parse_bambu_ssdp(data, addr[0])
                if device:
                    results[device["dev_id"]] = device
    finally:
        for sock in sockets:
            try:
                sock.close()
            except Exception:
                pass
    return list(results.values())


async def handle_discover_bambu(ws, req: dict) -> None:
    """Run Bambu SSDP discovery on the agent machine (local farm network)."""
    req_id = req.get("id")
    try:
        devices = await asyncio.to_thread(_bambu_ssdp_scan, 4.0)
    except Exception as e:
        log.warning("Bambu discover error: %s", e)
        devices = []

    await ws.send(json.dumps({
        "id": req_id,
        "status": 200,
        "body": {"devices": devices},
        "error": None,
    }))


async def _discover_via_mdns() -> list[dict]:
    """Try mDNS/Zeroconf for _moonraker._tcp.local. services (2s window).

    Returns [] if zeroconf is not installed or no devices respond.
    """
    try:
        import zeroconf as _zc
    except ImportError:
        return []

    found: dict[str, dict] = {}

    class _Listener:
        def add_service(self, zc: "_zc.Zeroconf", type_: str, name: str) -> None:
            info = zc.get_service_info(type_, name)
            if not info:
                return
            for addr in info.parsed_addresses():
                port = info.port or 7125
                url = f"http://{addr}:{port}"
                hostname = (info.server or "").rstrip(".")
                found[url] = {"url": url, "name": hostname or addr}

        def remove_service(self, *_) -> None:
            pass

        def update_service(self, *_) -> None:
            pass

    def _scan() -> list[dict]:
        import time
        zc = _zc.Zeroconf()
        listener = _Listener()
        _zc.ServiceBrowser(zc, "_moonraker._tcp.local.", listener)
        time.sleep(2.0)
        zc.close()
        return list(found.values())

    try:
        return await asyncio.wait_for(asyncio.to_thread(_scan), timeout=5.0)
    except Exception:
        return []


async def handle_discover_moonraker(ws, req: dict) -> None:
    """Scan the local network for Moonraker instances.

    Strategy: mDNS first (fast, ~2s), then /24 TCP port scan for any host
    not already found via mDNS. Results are merged and deduplicated.
    """
    import ipaddress

    req_id = req.get("id")

    # ── Step 1: mDNS (zeroconf) ───────────────────────────────────────────────
    mdns_results = await _discover_via_mdns()
    mdns_urls = {r["url"].rstrip("/") for r in mdns_results}
    results: list[dict] = list(mdns_results)

    # ── Step 2: /24 TCP scan ──────────────────────────────────────────────────
    subnets: set[str] = set()
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None):
            addr = info[4][0]
            if addr.startswith("192.168.") or addr.startswith("10.") or addr.startswith("172."):
                net = ipaddress.IPv4Network(f"{addr}/24", strict=False)
                subnets.add(str(net))
    except Exception:
        pass
    if not subnets:
        subnets.add("192.168.1.0/24")

    async def _probe(ip: str) -> dict | None:
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(ip, 7125), timeout=0.3
            )
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
            url = f"http://{ip}:7125"
            if url.rstrip("/") in mdns_urls:
                return None  # already found via mDNS
            try:
                async with httpx.AsyncClient(timeout=2.0) as client:
                    r = await client.get(f"{url}/printer/info")
                    if r.status_code == 200:
                        data = r.json().get("result", {})
                        return {"url": url, "name": data.get("hostname") or ip}
            except Exception:
                return {"url": url, "name": ip}
        except Exception:
            return None

    tasks = []
    for subnet in subnets:
        try:
            net = ipaddress.IPv4Network(subnet)
            for host in net.hosts():
                tasks.append(_probe(str(host)))
        except Exception:
            pass

    probed = await asyncio.gather(*tasks)
    for r in probed:
        if r is not None:
            results.append(r)

    import json as _json
    await ws.send(_json.dumps({
        "id": req_id,
        "status": 200,
        "body": {"devices": results},
        "error": None,
    }))


async def handle_stream(ws, req: dict) -> None:
    """Proxy a streaming HTTP response (e.g. MJPEG from go2rtc) chunk by chunk."""
    req_id = req.get("id")
    url    = req.get("url", "")

    try:
        async with httpx.AsyncClient(timeout=None, verify=False) as client:  # noqa: S501
            async with client.stream("GET", url) as resp:
                await ws.send(json.dumps({
                    "id": req_id,
                    "type": "stream_start",
                    "status": resp.status_code,
                    "content_type": resp.headers.get("content-type", ""),
                }))
                async for chunk in resp.aiter_bytes(STREAM_CHUNK):
                    await ws.send(json.dumps({
                        "id": req_id,
                        "type": "chunk",
                        "data": base64.b64encode(chunk).decode(),
                    }))
    except Exception as e:
        log.warning("Stream error %s: %s", url, e)
    finally:
        try:
            await ws.send(json.dumps({"id": req_id, "type": "stream_end"}))
        except Exception:
            pass


async def handle_bambu_camera(ws, req: dict) -> None:
    """Stream Bambu A1/P1 camera via native binary TLS protocol on port 6000.

    Protocol: github.com/Doridian/OpenBambuAPI/blob/main/video.md
    Uses asyncio streams (non-blocking) so the WebSocket loop stays responsive.
    """
    import struct as _struct
    req_id      = req.get("id")
    ip          = (req.get("ip") or "").strip()
    access_code = (req.get("access_code") or "").strip()
    port        = 6000

    auth = bytearray(80)
    _struct.pack_into('<I', auth,  0, 0x40)
    _struct.pack_into('<I', auth,  4, 0x3000)
    auth[16:20] = b'bblp'
    pw = access_code.encode()
    auth[48:48+len(pw)] = pw

    log.info("BAMBU_CAMERA: connecting to %s:%s", ip, port)
    await ws.send(json.dumps({"id": req_id, "type": "stream_start", "status": 200,
                              "content_type": "multipart/x-mixed-replace; boundary=frame"}))
    reader = writer = None
    try:
        try:
            reader, writer = await asyncio.open_connection(
                ip, port, ssl=_bambu_ssl_context(ip), server_hostname=ip,
            )
        except ssl.SSLError as exc:
            _bambu_mark_tls_failure(ip, exc)
            reader, writer = await asyncio.open_connection(
                ip, port, ssl=_bambu_ssl_context(ip), server_hostname=ip,
            )
        log.info("BAMBU_CAMERA: TLS connected, sending auth")
        writer.write(bytes(auth))
        await writer.drain()

        async def read_exact(n: int) -> bytes:
            buf = b""
            while len(buf) < n:
                chunk = await asyncio.wait_for(reader.read(n - len(buf)), timeout=30)
                if not chunk:
                    raise ConnectionError("Stream closed")
                buf += chunk
            return buf

        while True:
            header       = await read_exact(16)
            payload_size = _struct.unpack('<I', header[0:4])[0]
            if payload_size == 0 or payload_size > 10_000_000:
                continue  # skip invalid frames
            jpeg        = await read_exact(payload_size)
            mjpeg_chunk = b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpeg + b"\r\n"
            await ws.send(json.dumps({
                "id": req_id, "type": "chunk",
                "data": base64.b64encode(mjpeg_chunk).decode(),
            }))
    except Exception as e:
        log.warning("Bambu camera error %s: %s", ip, e)
    finally:
        if writer:
            try:
                writer.close()
            except Exception:
                pass
        try:
            await ws.send(json.dumps({"id": req_id, "type": "stream_end"}))
        except Exception:
            pass


async def handle_ffmpeg_stream(ws, req: dict) -> None:
    """Stream Bambu RTSPS camera via local FFmpeg — same approach as SimplyPrint Pi hub.

    Runs FFmpeg on the agent machine (farm PC / Pi), which is on the same LAN
    as the printer. Sends MJPEG frames back as base64 chunks.
    """
    import shutil
    req_id = req.get("id")
    rtsps_url = req.get("url", "")

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        await ws.send(json.dumps({
            "id": req_id, "type": "stream_end",
            "error": "ffmpeg not found on agent machine",
        }))
        return

    cmd = [
        ffmpeg, "-loglevel", "quiet",
        "-rtsp_transport", "tcp", "-tls_verify", "0",
        "-i", rtsps_url,
        "-vf", "fps=5",
        "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "3",
        "pipe:1",
    ]

    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await ws.send(json.dumps({
            "id": req_id, "type": "stream_start",
            "status": 200, "content_type": "multipart/x-mixed-replace; boundary=frame",
        }))
        buf = b""
        while True:
            chunk = await proc.stdout.read(65536)
            if not chunk:
                break
            buf += chunk
            # Extract complete JPEG frames
            while True:
                start = buf.find(b"\xff\xd8")
                if start < 0:
                    break
                end = buf.find(b"\xff\xd9", start + 2)
                if end < 0:
                    break
                frame = buf[start:end + 2]
                buf = buf[end + 2:]
                mjpeg_chunk = (
                    b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + frame + b"\r\n"
                )
                await ws.send(json.dumps({
                    "id": req_id, "type": "chunk",
                    "data": base64.b64encode(mjpeg_chunk).decode(),
                }))
    except Exception as e:
        log.warning("FFmpeg stream error: %s", e)
    finally:
        if proc:
            try:
                proc.kill()
                await proc.wait()
            except Exception:
                pass
        try:
            await ws.send(json.dumps({"id": req_id, "type": "stream_end"}))
        except Exception:
            pass


async def handle_bambu_upload(ws, req: dict) -> None:
    """Upload a .3mf file to a Bambu printer via LAN FTPS (:990).

    File source: either `url` (presigned R2 — agent downloads directly, preferred
    to avoid +33% base64 overhead) or `data_b64` (fallback for local-disk backends).

    Uploads into `cache/` by default. A1/A1 mini project_file jobs must be
    uploaded to the SD root and launched as file:///sdcard/<name>, so the
    backend can request `target_dir=sdcard`. Returns the path actually used so
    the backend can build the matching `project_file` URL.
    """
    import ftplib
    import ssl as _ssl
    import time

    class _ImplicitFTP_TLS(ftplib.FTP_TLS):
        """Bambu printers serve IMPLICIT FTPS on :990 — the socket must be TLS
        from the first byte. Stdlib FTP_TLS does EXPLICIT AUTH-TLS (connects in
        plaintext, waits for a "220" greeting), which hangs until timeout against
        :990. Wrapping the socket on assignment makes the command channel
        implicit; prot_p() still covers the data channel via the base class."""
        @property
        def sock(self):
            return self._sock

        @sock.setter
        def sock(self, value):
            if value is not None and not isinstance(value, _ssl.SSLSocket):
                value = self.context.wrap_socket(value)
            self._sock = value

        def storbinary(self, cmd, fp, blocksize=8192, callback=None, rest=None):
            # Bambu firmware never sends a TLS close_notify on the data channel,
            # so stdlib's conn.unwrap() after the transfer blocks until timeout.
            # The 226 on the command channel (voidresp) already confirms the
            # upload, so send the bytes and skip the unwrap.
            self.voidcmd("TYPE I")
            conn = self.transfercmd(cmd, rest)
            try:
                while buf := fp.read(blocksize):
                    conn.sendall(buf)
                    if callback:
                        callback(buf)
            finally:
                conn.close()
            return self.voidresp()

    req_id      = req.get("id")
    ip          = (req.get("ip") or "").strip()
    access_code = (req.get("access_code") or "").strip()
    filename    = req.get("filename", "model.3mf")
    target_dir  = (req.get("target_dir") or "cache").strip().lower()
    url         = req.get("url")
    data_b64    = req.get("data_b64", "")
    temp_path: Path | None = None
    progress = {"phase": "downloading", "sent": 0, "total": 0}
    progress_task: asyncio.Task | None = None

    async def _report_progress() -> None:
        last: tuple[str, int, int] | None = None
        last_sent_at = 0.0
        while True:
            current = (progress["phase"], progress["sent"], progress["total"])
            now = time.monotonic()
            if current != last or now - last_sent_at >= 5.0:
                try:
                    await ws.send(json.dumps({
                        "id": req_id,
                        "type": "upload_progress",
                        "phase": current[0],
                        "sent": current[1],
                        "total": current[2],
                        "heartbeat": current == last,
                    }))
                    last = current
                    last_sent_at = now
                except Exception:
                    return
            await asyncio.sleep(1.0)

    try:
        with tempfile.NamedTemporaryFile(suffix=".3mf", delete=False) as tmp:
            temp_path = Path(tmp.name)
        progress_task = asyncio.create_task(_report_progress())

        if url:
            async with httpx.AsyncClient(timeout=httpx.Timeout(180, connect=30), verify=False) as client:  # noqa: S501
                async with client.stream("GET", url) as resp:
                    resp.raise_for_status()
                    progress["total"] = int(resp.headers.get("content-length") or 0)
                    with temp_path.open("wb") as file_obj:
                        async for chunk in resp.aiter_bytes(1024 * 1024):
                            file_obj.write(chunk)
                            progress["sent"] += len(chunk)
        else:
            file_bytes = base64.b64decode(data_b64)
            progress["total"] = len(file_bytes)
            temp_path.write_bytes(file_bytes)
        progress["phase"] = "uploading"
        progress["sent"] = 0

        def _ftp_connect() -> "ftplib.FTP_TLS":
            ftp = _ImplicitFTP_TLS(context=_bambu_ssl_context(ip))
            ftp.connect(ip, 990, timeout=BAMBU_FTPS_CONNECT_TIMEOUT)
            ftp.login(user="bblp", passwd=access_code)
            # ftplib reuses self.timeout for every data connection: keep the
            # short timeout for the TCP+TLS handshake, then relax it so an SD
            # write stall mid-transfer doesn't kill the upload
            # ("The write operation timed out").
            ftp.timeout = BAMBU_FTPS_IO_TIMEOUT
            ftp.sock.settimeout(BAMBU_FTPS_IO_TIMEOUT)
            return ftp

        def _ftp_upload() -> str:
            try:
                ftp = _ftp_connect()
            except _ssl.SSLError as exc:
                _bambu_mark_tls_failure(ip, exc)
                ftp = _ftp_connect()
            ftp.prot_p()
            remote_path = filename
            if target_dir != "sdcard":
                try:
                    try:
                        ftp.cwd("cache")
                    except ftplib.error_perm:
                        ftp.mkd("cache")
                        ftp.cwd("cache")
                    remote_path = f"cache/{filename}"
                except ftplib.all_errors:
                    pass  # old firmware without cache dir: upload to SD root
            with temp_path.open("rb") as file_obj:
                ftp.storbinary(
                    f"STOR {filename}",
                    file_obj,
                    blocksize=64 * 1024,
                    callback=lambda chunk: progress.__setitem__("sent", progress["sent"] + len(chunk)),
                )
            try:
                ftp.quit()
            except ftplib.all_errors:
                pass
            return remote_path

        # Run blocking FTP in a thread so asyncio event loop stays alive
        # (handles WS keepalive pings during upload)
        remote_path = await asyncio.to_thread(_ftp_upload)
        progress["sent"] = progress["total"]
        try:
            await ws.send(json.dumps({
                "id": req_id,
                "type": "upload_progress",
                "phase": "uploading",
                "sent": progress["sent"],
                "total": progress["total"],
            }))
        except Exception:
            pass

        result = {
            "id": req_id, "status": 200,
            "body": {"filename": filename, "path": remote_path}, "error": None,
        }
    except Exception as e:
        log.warning("BAMBU_UPLOAD error %s: %s", ip, e)
        result = {"id": req_id, "status": 502, "body": None, "error": str(e)}
    finally:
        if progress_task:
            progress_task.cancel()
            try:
                await progress_task
            except asyncio.CancelledError:
                pass
        if temp_path:
            temp_path.unlink(missing_ok=True)

    await ws.send(json.dumps(result))


def apply_moonraker_print_options(file_bytes: bytes, options: dict) -> bytes:
    """Apply U1 print options after the Agent downloads the file directly."""
    import re

    content = file_bytes.decode("utf-8", errors="ignore")
    out = content
    if options.get("auto_bed_leveling") is False:
        out = re.sub(
            r"^(BED_MESH_CALIBRATE\b.*)$",
            r"; SKIPPED \1",
            out,
            flags=re.MULTILINE,
        )
    if options.get("timelapse") is False:
        out = re.sub(
            r"^(TIMELAPSE_(?:START|TAKE_FRAME)\b.*)$",
            r"; SKIPPED \1",
            out,
            flags=re.MULTILINE,
        )
    if options.get("ai_detection") is False:
        out = re.sub(
            r"^((?:DEFECT_DETECTION_(?:START|DETECT(?:_BED)?)|DETECT_BED_PLATE)\b.*)$",
            r"; SKIPPED \1",
            out,
            flags=re.MULTILINE,
        )

    raw_used_slots = options.get("used_slots")
    used_slots = (
        {int(slot) for slot in raw_used_slots}
        if raw_used_slots is not None
        else None
    )
    raw_calibrate_slots = options.get("calibrate_slots")
    calibrate_slots = (
        {int(slot) for slot in raw_calibrate_slots}
        if raw_calibrate_slots is not None
        else None
    )
    if used_slots is not None:
        out = re.sub(
            r"^SM_PRINT_(?:EXTRUDER_PREHEAT|AUTO_FEED)\s+EXTRUDER=(\d+).*$",
            lambda match: (
                match.group(0)
                if int(match.group(1)) in used_slots
                else "; SKIPPED " + match.group(0)
            ),
            out,
            flags=re.MULTILINE,
        )

    effective_slots: set[int] | None = None
    if calibrate_slots is not None and used_slots is not None:
        effective_slots = calibrate_slots & used_slots
    elif calibrate_slots is not None:
        effective_slots = calibrate_slots
    elif used_slots is not None:
        effective_slots = used_slots
    if effective_slots is not None:
        out = re.sub(
            r"^SM_PRINT_FLOW_CALIBRATE\s+EXTRUDER=(\d+).*$",
            lambda match: (
                match.group(0)
                if int(match.group(1)) in effective_slots
                else "; SKIPPED " + match.group(0)
            ),
            out,
            flags=re.MULTILINE,
        )
    return file_bytes if out == content else out.encode("utf-8")


async def handle_moonraker_upload(ws, req: dict) -> None:
    """Upload a gcode/3mf file to Moonraker via multipart POST.

    Cloud backend sends bytes as base64; agent does the actual LAN upload.
    """
    import time

    req_id      = req.get("id")
    url         = req.get("url", "")         # bare Moonraker base URL
    filename    = req.get("filename", "file.gcode")
    data_b64    = req.get("data_b64", "")
    data_bytes  = req.get("_data_bytes")
    download_url = req.get("download_url", "")
    start_print = req.get("start_print", False)
    upload_timeout = max(300.0, min(3600.0, float(req.get("upload_timeout", 300.0))))

    try:
        if isinstance(data_bytes, bytes):
            file_bytes = data_bytes
        elif download_url:
            # Cloud sent a presigned URL — pull the file directly (much faster
            # than base64 chunks through the tunnel). Heartbeat progress keeps
            # the cloud stall-guard alive during a slow download.
            parts: list[bytes] = []
            last_beat = time.monotonic()
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(upload_timeout, connect=30.0)
            ) as dl:
                async with dl.stream("GET", download_url) as resp_dl:
                    resp_dl.raise_for_status()
                    total_dl = int(resp_dl.headers.get("content-length") or 0)
                    async for part in resp_dl.aiter_bytes(1024 * 1024):
                        parts.append(part)
                        now = time.monotonic()
                        if now - last_beat >= 2.0:
                            await ws.send(json.dumps({
                                "id": req_id,
                                "type": "upload_progress",
                                "sent": 0,
                                "total": total_dl,
                            }))
                            last_beat = now
            file_bytes = b"".join(parts)
        else:
            file_bytes = base64.b64decode(data_b64)
        print_options = req.get("print_options")
        if isinstance(print_options, dict):
            file_bytes = apply_moonraker_print_options(file_bytes, print_options)
        boundary = "----monofarm-upload-" + hashlib.sha256(req_id.encode()).hexdigest()[:16]
        prefix = (
            f"--{boundary}\r\n"
            "Content-Disposition: form-data; name=\"root\"\r\n\r\n"
            "gcodes\r\n"
            f"--{boundary}\r\n"
            "Content-Disposition: form-data; name=\"print\"\r\n\r\n"
            f"{'true' if start_print else 'false'}\r\n"
            f"--{boundary}\r\n"
            f"Content-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n"
            "Content-Type: application/octet-stream\r\n\r\n"
        ).encode()
        suffix = f"\r\n--{boundary}--\r\n".encode()
        total = len(prefix) + len(file_bytes) + len(suffix)
        chunk_size = 256 * 1024
        upload_sent = 0

        async def upload_heartbeat() -> None:
            while True:
                await asyncio.sleep(MOONRAKER_UPLOAD_HEARTBEAT_INTERVAL)
                await ws.send(json.dumps({
                    "id": req_id,
                    "type": "upload_progress",
                    "sent": upload_sent,
                    "total": len(file_bytes),
                    "heartbeat": True,
                }))

        async def multipart_body():
            nonlocal upload_sent
            yield prefix
            sent = 0
            last_report = -1
            # Report on time as well as percent: the cloud stall-guard needs a
            # heartbeat even when 5% of a big file takes minutes on slow WiFi.
            last_report_at = time.monotonic()
            for offset in range(0, len(file_bytes), chunk_size):
                chunk = file_bytes[offset:offset + chunk_size]
                sent += len(chunk)
                upload_sent = sent
                progress = round(sent * 100 / max(len(file_bytes), 1))
                now = time.monotonic()
                if progress == 100 or progress - last_report >= 5 or now - last_report_at >= 2.0:
                    await ws.send(json.dumps({
                        "id": req_id,
                        "type": "upload_progress",
                        "sent": sent,
                        "total": len(file_bytes),
                    }))
                    last_report = progress
                    last_report_at = now
                yield chunk
            yield suffix

        heartbeat_task = asyncio.create_task(upload_heartbeat())
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(upload_timeout, connect=30.0, pool=30.0),
                verify=False,
            ) as client:  # noqa: S501
                resp = await client.post(
                    f"{url}/server/files/upload",
                    content=multipart_body(),
                    headers={
                        "Content-Type": f"multipart/form-data; boundary={boundary}",
                        "Content-Length": str(total),
                    },
                )
        finally:
            heartbeat_task.cancel()
            try:
                await heartbeat_task
            except asyncio.CancelledError:
                pass
        result = {
            "id": req_id,
            "status": resp.status_code,
            "body": resp.json() if resp.content else {},
            "error": None if resp.status_code < 400 else resp.text,
        }
    except Exception as e:
        log.warning("MOONRAKER_UPLOAD error %s: %s", url, e)
        result = {"id": req_id, "status": 502, "body": None, "error": str(e)}

    try:
        await ws.send(json.dumps(result))
    except websockets.exceptions.ConnectionClosed as exc:
        log.warning("MOONRAKER_UPLOAD response dropped after cloud disconnect: %s", exc)


async def handle_moonraker_upload_chunk(ws, req: dict) -> None:
    """Collect a chunked cloud upload and start the LAN upload on the final chunk."""
    req_id = req.get("id")
    if not req_id:
        return
    state = _moonraker_upload_buffers.get(req_id)
    if state is None:
        await ws.send(json.dumps({"id": req_id, "status": 400, "error": "upload metadata missing"}))
        return

    try:
        offset = int(req.get("offset", -1))
        data = base64.b64decode(req.get("data_b64", ""))
        expected = int(state["next_offset"])
        if offset != expected:
            raise ValueError(f"unexpected upload chunk offset {offset}, expected {expected}")
        state["data"].extend(data)
        state["next_offset"] = expected + len(data)
        if not req.get("final"):
            return
        if state["next_offset"] != int(state["total_bytes"]):
            raise ValueError("incomplete upload")
        upload_req = dict(state["meta"])
        upload_req["_data_bytes"] = bytes(state["data"])
        _moonraker_upload_buffers.pop(req_id, None)
        asyncio.create_task(handle_moonraker_upload(ws, upload_req))
    except Exception as e:
        _moonraker_upload_buffers.pop(req_id, None)
        log.warning("MOONRAKER_UPLOAD chunk error: %s", e)
        await ws.send(json.dumps({"id": req_id, "status": 400, "error": str(e)}))


async def handle_agent_logs(ws, req: dict) -> None:
    """Return recent agent log lines to the SaaS (remote diagnostics)."""
    await ws.send(json.dumps({
        "id": req.get("id"),
        "status": 200,
        "body": {"version": AGENT_VERSION, "lines": list(_LOG_BUFFER)[-200:]},
        "error": None,
    }))


async def handle_print_zpl(ws, req: dict) -> None:
    """Send raw ZPL to a network printer via TCP port 9100 (or custom port)."""
    req_id = req.get("id")
    body   = req.get("body") or {}
    ip     = body.get("ip", "")
    port   = int(body.get("port", 9100))
    zpl    = body.get("zpl", "")
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(ip, port), timeout=5
        )
        writer.write(zpl.encode())
        await writer.drain()
        writer.close()
        await writer.wait_closed()
        result = {"id": req_id, "status": 200, "body": {"ok": True}, "error": None}
        log.info("PRINT_ZPL: sent %d bytes to %s:%s", len(zpl), ip, port)
    except Exception as e:
        log.warning("PRINT_ZPL error %s:%s: %s", ip, port, e)
        result = {"id": req_id, "status": 502, "body": None, "error": str(e)}
    await ws.send(json.dumps(result))


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


async def run(server: str, token: str, *, on_state=None, run_updates: bool = True) -> None:
    """Single canonical relay loop — shared by the CLI agent and the tray host.

    on_state(state) fires with "connecting" | "connected" | "disconnected" so a
    GUI host (the tray) can reflect connection status. run_updates=False lets a
    host disable the built-in auto-updater if it manages updates itself.
    """
    global _tg_server, _tg_jwt, _main_loop, _current_server, _cloud_connected, _alert_chat_ids, _update_task
    _tg_server = server
    _tg_jwt    = token
    _main_loop = asyncio.get_running_loop()
    _current_server = server
    _alert_chat_ids = _load_alert_chat_ids()

    def _emit(state: str) -> None:
        if on_state:
            try:
                on_state(state)
            except Exception:
                pass

    ws_url = (
        server.replace("https://", "wss://").replace("http://", "ws://")
        + f"/api/agent/connect?token={token}"
    )
    log.info("monofarm-agent v%s connecting to %s …", AGENT_VERSION, server)
    ensure_bambu_mqtt_dependency()
    if _update_task and not _update_task.done():
        _update_task.cancel()  # avoid a duplicate updater if run() is re-invoked
        _update_task = None
    if run_updates:
        await check_for_update(server)
        _update_task = asyncio.create_task(_update_loop(server))

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
                _cloud_connected = True
                backoff = RECONNECT_DELAY  # reset backoff on a successful connect
                _emit("connected")
                await ws.send(json.dumps({
                    "type": "AGENT_HELLO",
                    "version": AGENT_VERSION,
                    "capabilities": [
                        "moonraker_upload_chunks",
                        "moonraker_upload_url",
                        "moonraker_upload_local_transform",
                    ],
                }))
                bambu_lan_task = asyncio.create_task(_bambu_lan_config_loop(ws, server, token))

                # Fetch TG config on every connect (token may have changed while disconnected)
                try:
                    async with httpx.AsyncClient(timeout=10) as client:
                        r = await client.get(
                            f"{server}/api/agent/tg-config",
                            headers={"Authorization": f"Bearer {token}"},
                        )
                        if r.status_code == 200:
                            tg_cfg = r.json()
                            asyncio.create_task(_tg_reconfigure(tg_cfg.get("token") or None))
                except Exception as exc:
                    log.debug("Could not fetch tg-config: %s", exc)

                try:
                    async for message in ws:
                        try:
                            req = json.loads(message)
                        except json.JSONDecodeError:
                            log.warning("Received invalid JSON from server")
                            continue

                        msg_type = req.get("type", "")
                        if msg_type == "TG_CONFIG":
                            asyncio.create_task(_tg_reconfigure(req.get("token") or None))
                            continue
                        if msg_type == "TG_SEND":
                            if _tg_app:
                                async def _send(r=req) -> None:
                                    try:
                                        await _tg_app.bot.send_message(
                                            chat_id=r["chat_id"],
                                            text=r["text"],
                                            parse_mode=r.get("parse_mode"),
                                        )
                                    except Exception as exc:
                                        log.warning("TG_SEND failed: %s", exc)
                                asyncio.create_task(_send())
                            else:
                                log.warning("TG_SEND received but bot not running")
                            continue

                        method = req.get("method", "GET").upper()
                        if method == "MOONRAKER_SUBSCRIBE":
                            asyncio.create_task(handle_moonraker_subscribe(ws, req))
                        elif method == "BAMBU_CAMERA":
                            asyncio.create_task(handle_bambu_camera(ws, req))
                        elif method == "FFMPEG_STREAM":
                            asyncio.create_task(handle_ffmpeg_stream(ws, req))
                        elif method == "DISCOVER_BAMBU":
                            asyncio.create_task(handle_discover_bambu(ws, req))
                        elif method == "DISCOVER_MOONRAKER":
                            asyncio.create_task(handle_discover_moonraker(ws, req))
                        elif method == "BAMBU_UPLOAD":
                            asyncio.create_task(handle_bambu_upload(ws, req))
                        elif method == "BAMBU_MQTT":
                            asyncio.create_task(handle_bambu_mqtt(ws, req))
                        elif method == "MOONRAKER_UPLOAD":
                            if req.get("chunked"):
                                _moonraker_upload_buffers[req["id"]] = {
                                    "meta": req,
                                    "data": bytearray(),
                                    "next_offset": 0,
                                    "total_bytes": int(req.get("total_bytes", 0)),
                                }
                            else:
                                asyncio.create_task(handle_moonraker_upload(ws, req))
                        elif method == "MOONRAKER_UPLOAD_CHUNK":
                            await handle_moonraker_upload_chunk(ws, req)
                        elif method == "PRINT_ZPL":
                            asyncio.create_task(handle_print_zpl(ws, req))
                        elif method == "AGENT_LOGS":
                            asyncio.create_task(handle_agent_logs(ws, req))
                        elif method == "STREAM":
                            asyncio.create_task(handle_stream(ws, req))
                        else:
                            asyncio.create_task(handle_request(ws, req))
                finally:
                    # Cloud WS dropped — cancel all Moonraker WS subscriptions
                    _cloud_connected = False
                    _cancel_all_subscriptions()
                    _cancel_all_bambu_lan_subscriptions()
                    _moonraker_upload_buffers.clear()
                    bambu_lan_task.cancel()

        except asyncio.CancelledError:
            _emit("disconnected")
            raise
        except websockets.exceptions.InvalidStatusCode as e:
            if e.status_code in (4001, 4002):
                log.error("Authentication failed (code %s). Check your token.", e.status_code)
                _emit("disconnected")
                return  # stop the loop without killing a GUI host process
            log.warning("Server rejected connection (%s). Retrying in %ss…", e.status_code, backoff)
        except (OSError, websockets.exceptions.WebSocketException) as e:
            log.warning("Disconnected: %s. Retrying in %ss…", e, backoff)
        except Exception as e:
            log.exception("Unexpected error: %s", e)

        _emit("disconnected")
        await asyncio.sleep(backoff + random.uniform(0, backoff * 0.3))
        backoff = min(backoff * 2, _RECONNECT_MAX)


_instance_lock_handle = None  # kept alive for the process lifetime to hold the lock


def acquire_single_instance() -> bool:
    """Return True if we got the lock; False if another agent is already running.

    Prevents two agents fighting over the same printers' MQTT/Telegram connections.
    """
    global _instance_lock_handle
    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        fh = open(CONFIG_DIR / "agent.lock", "w")  # noqa: SIM115
        if os.name == "nt":
            import msvcrt
            try:
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError:
                fh.close()
                return False
        else:
            import fcntl
            try:
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                fh.close()
                return False
        fh.write(str(os.getpid()))
        fh.flush()
        _instance_lock_handle = fh
        return True
    except Exception:
        return True  # never block startup on a lock-file error


def setup_file_logging() -> None:
    """Add a rotating file log at ~/.monofarm-agent/agent.log (bounded size)."""
    try:
        from logging.handlers import RotatingFileHandler
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        fh = RotatingFileHandler(
            CONFIG_DIR / "agent.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8",
        )
        fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s: %(message)s"))
        logging.getLogger().addHandler(fh)
    except Exception:
        pass


def main() -> None:
    parser = argparse.ArgumentParser(
        description="monofarm local agent — tunnels Moonraker and camera access to the cloud",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python monofarm_agent.py                                    # pair via browser (first run)
  python monofarm_agent.py --server http://192.168.1.10:8000 # custom server, pair via browser
  python monofarm_agent.py --token eyJ...                    # skip pairing, use token directly

On first run without --token the browser opens to monofarm Settings automatically.
Token is saved to ~/.monofarm-agent/.env — subsequent runs need no arguments.
        """,
    )
    parser.add_argument("--server", default=None,
                        help="monofarm server URL (default: from saved config or https://api.monofarm.app)")
    parser.add_argument("--token", default=None,
                        help="JWT token — omit to use saved config or pair via browser")
    args = parser.parse_args()

    _cleanup_old_exe()
    setup_file_logging()
    if not acquire_single_instance():
        log.error("Another monofarm-agent is already running — exiting.")
        sys.exit(0)

    cfg    = _load_config()
    server = args.server or cfg["MONOFARM_SERVER"]
    token  = args.token  or cfg["MONOFARM_TOKEN"]

    # Local setup/status UI (SimplyPrint-style). MONOFARM_WEB_PORT=0 disables.
    try:
        web_port = int(os.environ.get("MONOFARM_WEB_PORT") or cfg.get("MONOFARM_WEB_PORT") or WEB_PORT_DEFAULT)
    except ValueError:
        web_port = WEB_PORT_DEFAULT
    if web_port > 0:
        _start_web_ui(web_port)

    async def _run() -> None:
        nonlocal token
        if not token:
            token = await _pair_flow(server)
        await run(server, token)

    async def _run_with_cleanup() -> None:
        try:
            await _run()
        finally:
            await _tg_stop()

    try:
        asyncio.run(_run_with_cleanup())
    except KeyboardInterrupt:
        log.info("Agent stopped.")


if __name__ == "__main__":
    main()
