"""Telegram bot shims — the actual PTB Application runs in the local farm agent.

Public API (unchanged surface for callers):
    send_message(chat_id, org_id, text, parse_mode) → delegates to tunnel.send_telegram
    get_bot_username(db, org_id)                    → reads org.tg_bot_username
    generate_link_code(db, user, ttl_hours)         → pure DB, no PTB dependency
"""
import logging
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.models.user import User

log = logging.getLogger(__name__)


async def send_message(
    chat_id: int,
    org_id: int,
    text: str,
    parse_mode: str | None = "Markdown",
) -> bool:
    from app.services import tunnel
    return await tunnel.send_telegram(org_id, chat_id, text, parse_mode)


def get_bot_username(db: Session, org_id: int) -> str | None:
    from app.models.organization import Organization
    org = db.get(Organization, org_id)
    return (org.tg_bot_username or None) if org else None


def generate_link_code(db: Session, user: User, ttl_hours: int = 24) -> str:
    code = secrets.token_urlsafe(16)
    user.telegram_link_code = code
    user.telegram_link_expires_at = datetime.now(timezone.utc) + timedelta(hours=ttl_hours)
    db.commit()
    return code
