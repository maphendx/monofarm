"""Telegram bot — runs inside the FastAPI process, uses long-polling.

Public API:
    init()               — start bot polling. No-op if TG_BOT_TOKEN not set.
    shutdown()           — graceful stop.
    send_message()       — send a message to a chat_id (used by scheduler).
    generate_link_code() — issue a one-time code; admin sends user a deep link.
    get_bot_username()   — for building deep links in the UI.
    is_running()         — for diagnostics.
"""
import logging
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session
from telegram import Update
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from app.core.config import settings
from app.core.db import SessionLocal
from app.models.organization import Organization
from app.models.user import User


log = logging.getLogger(__name__)

_app: Application | None = None
_bot_username: str | None = None


# ── bot handlers ────────────────────────────────────────────────────────────

def _user_by_chat(db: Session, chat_id: int) -> User | None:
    return db.query(User).filter(User.telegram_chat_id == chat_id).first()


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.message or not update.effective_chat:
        return
    chat_id = update.effective_chat.id

    with SessionLocal() as db:
        # /start <code> — link account
        if context.args:
            code = (context.args[0] or "").strip()
            user = db.query(User).filter(User.telegram_link_code == code).first()
            if not user:
                await update.message.reply_text("Невірний код. Попроси адміна надіслати нове посилання.")
                return
            if user.telegram_link_expires_at and user.telegram_link_expires_at < datetime.now(timezone.utc):
                await update.message.reply_text("Посилання прострочене. Попроси адміна нове.")
                return
            user.telegram_chat_id = chat_id
            user.telegram_link_code = None
            user.telegram_link_expires_at = None
            db.commit()
            name = user.name or user.email
            await update.message.reply_text(
                f"✅ Готово, {name}!\n\n"
                "Тут будуть приходити:\n"
                "• ранкові плани о 09:00\n"
                "• алерти про принтери\n\n"
                "Команди: /план — план на сьогодні, /статус — стан принтерів."
            )
            return

        # /start without code
        user = _user_by_chat(db, chat_id)
        if user:
            name = user.name or user.email
            await update.message.reply_text(
                f"Вітаю, {name}.\n"
                "Команди: /план, /статус."
            )
        else:
            await update.message.reply_text(
                "Цей чат не привʼязаний до акаунта monofarm.\n"
                "Попроси адміна надіслати тобі персональне посилання."
            )


async def cmd_plan(update: Update, _ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.message or not update.effective_chat:
        return
    chat_id = update.effective_chat.id
    from app.services.daily_report import build_daily_plan_text  # avoid cycle

    with SessionLocal() as db:
        user = _user_by_chat(db, chat_id)
        if not user:
            await update.message.reply_text("Не зареєстрований. Попроси адміна посилання.")
            return
        text = build_daily_plan_text(db, user.organization_id)
    await update.message.reply_text(text, parse_mode="Markdown")


async def cmd_status(update: Update, _ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.message or not update.effective_chat:
        return
    chat_id = update.effective_chat.id
    from app.services.daily_report import build_status_text

    with SessionLocal() as db:
        user = _user_by_chat(db, chat_id)
        if not user:
            await update.message.reply_text("Не зареєстрований.")
            return
        org = db.get(Organization, user.organization_id)
        if not org:
            await update.message.reply_text("Організацію не знайдено.")
            return
        text = build_status_text(db, org)
    await update.message.reply_text(text, parse_mode="Markdown")


# ── lifecycle ───────────────────────────────────────────────────────────────

async def init() -> None:
    global _app, _bot_username
    if not settings.TG_BOT_TOKEN:
        log.info("TG_BOT_TOKEN not set — skipping telegram bot startup")
        return
    _app = Application.builder().token(settings.TG_BOT_TOKEN).build()

    _app.add_handler(CommandHandler("start", cmd_start))
    # Cyrillic command names — PTB CommandHandler rejects them, use regex MessageHandler.
    _app.add_handler(MessageHandler(filters.Regex(r"^/план(@\w+)?(\s|$)"), cmd_plan))
    _app.add_handler(MessageHandler(filters.Regex(r"^/статус(@\w+)?(\s|$)"), cmd_status))

    await _app.initialize()
    me = await _app.bot.get_me()
    _bot_username = me.username
    await _app.start()
    if _app.updater is not None:
        await _app.updater.start_polling(drop_pending_updates=True)
    log.info("Telegram bot @%s online", _bot_username)


async def shutdown() -> None:
    global _app, _bot_username
    if _app is None:
        return
    try:
        if _app.updater is not None:
            await _app.updater.stop()
        await _app.stop()
        await _app.shutdown()
    finally:
        _app = None
        _bot_username = None


def is_running() -> bool:
    return _app is not None


def get_bot_username() -> str | None:
    return _bot_username


# ── outgoing ────────────────────────────────────────────────────────────────

async def send_message(chat_id: int, text: str, parse_mode: str | None = "Markdown") -> bool:
    if _app is None:
        log.warning("Telegram bot not running, cannot send to %s", chat_id)
        return False
    try:
        await _app.bot.send_message(chat_id=chat_id, text=text, parse_mode=parse_mode)
        return True
    except Exception:
        log.exception("Telegram send to %s failed", chat_id)
        return False


# ── magic-link codes ────────────────────────────────────────────────────────

def generate_link_code(db: Session, user: User, ttl_hours: int = 24) -> str:
    code = secrets.token_urlsafe(16)
    user.telegram_link_code = code
    user.telegram_link_expires_at = datetime.now(timezone.utc) + timedelta(hours=ttl_hours)
    db.commit()
    return code
