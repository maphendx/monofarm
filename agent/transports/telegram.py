"""Local Telegram bot and printer failure alerts."""
from __future__ import annotations

import asyncio
import hashlib
import html as _htmlmod
import io
import logging
import threading

import httpx

from core.config import _save_alert_chat_ids

try:
    from telegram import Update
    from telegram.ext import Application, CommandHandler, ContextTypes, MessageHandler, filters as tg_filters
    _TG_AVAILABLE = True
except ImportError:
    _TG_AVAILABLE = False

log = logging.getLogger("monofarm-agent")
_tg_app: "Application | None" = None
_tg_token: str | None = None
_tg_lock = asyncio.Lock()
_tg_server = ""
_tg_jwt = ""
_alert_chat_ids: list[int] = []
_alert_last: dict[str, tuple[str, str]] = {}
_alert_seen: set[str] = set()
_alert_lock = threading.Lock()
_bambu_print_state: dict[str, dict] = {}
_HEALTHY_STATES = {"idle", "printing", "operational", "unknown", "prepare", "slicing"}
_BAD_STATES = {"error", "paused", "cancelled"}
_STATE_LABELS = {
    "error": "збій",
    "paused": "зупинка / пауза",
    "cancelled": "друк скасовано",
}


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
        return not first_seen

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


async def dispatch_alert(
    name: str,
    state: str,
    error_text: str,
    error_code: str,
    snapshot_kind: str,
    snapshot_args: dict,
) -> None:
    """Capture a printer-local snapshot and send the alert through Telegram."""
    if not _tg_app or not _alert_chat_ids:
        return
    jpeg: bytes | None = None
    try:
        if snapshot_kind == "bambu":
            from printers.bambu import _bambu_grab_frame

            jpeg = await _bambu_grab_frame(**snapshot_args)
        else:
            from printers.moonraker import _moonraker_grab_snapshot

            jpeg = await _moonraker_grab_snapshot(**snapshot_args)
    except Exception as exc:
        log.debug("alert snapshot failed: %s", exc)
    await _send_alert(_build_alert_caption(name, state, error_text, error_code), jpeg)

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


def configure(server: str, token: str, alert_chat_ids: list[int]) -> None:
    global _tg_server, _tg_jwt
    _tg_server = server
    _tg_jwt = token
    _alert_chat_ids[:] = alert_chat_ids


def is_running() -> bool:
    return _tg_app is not None


def get_alert_chat_ids() -> list[int]:
    return list(_alert_chat_ids)


def set_alert_chat_ids(chat_ids: list[int]) -> None:
    _alert_chat_ids[:] = chat_ids
    _save_alert_chat_ids(_alert_chat_ids)


async def send_cloud_message(message: dict) -> None:
    if _tg_app is None:
        log.warning("TG_SEND received but bot not running")
        return
    try:
        await _tg_app.bot.send_message(
            chat_id=message["chat_id"],
            text=message["text"],
            parse_mode=message.get("parse_mode"),
        )
    except Exception as exc:
        log.warning("TG_SEND failed: %s", exc)


def classify_bambu_report(dev_id: str, delta: dict) -> tuple[str, str, str]:
    merged = {**_bambu_print_state.get(dev_id, {}), **delta}
    _bambu_print_state[dev_id] = merged
    return _classify_bambu(merged)


# Public service names used by printer transports and the runtime dispatcher.
alert_should_fire = _alert_should_fire
classify_bambu = _classify_bambu
classify_moonraker = _classify_moonraker
reconfigure = _tg_reconfigure
stop = _tg_stop
