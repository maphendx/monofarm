"""Telegram notification helpers for printer alerts.

These helpers send direct bot API messages for event-driven alerts.
Command handling still runs through the local farm agent.
"""
from __future__ import annotations

import logging

import requests
from sqlalchemy.orm import Session

from app.services.encryption import decrypt
from app.models.organization import Organization
from app.models.user import User

log = logging.getLogger(__name__)


def _linked_chat_ids(db: Session, org_id: int) -> list[int]:
    rows = (
        db.query(User.telegram_chat_id)
        .filter(
            User.organization_id == org_id,
            User.is_active.is_(True),
            User.telegram_chat_id.isnot(None),
        )
        .all()
    )
    return [int(row[0]) for row in rows if row and row[0] is not None]


def send_org_notification(db: Session, org_id: int, text: str) -> int:
    """Send a plain-text Telegram message to every linked active user in org."""
    org = db.get(Organization, org_id)
    if not org or not org.tg_bot_token:
        return 0

    try:
        token = decrypt(org.tg_bot_token)
    except Exception as exc:
        log.warning("Telegram alert skipped for org %s: token decrypt failed: %s", org_id, exc)
        return 0

    chat_ids = _linked_chat_ids(db, org_id)
    if not chat_ids:
        log.info("Telegram alert skipped for org %s: no linked users", org_id)
        return 0

    sent = 0
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload_base = {"text": text, "disable_web_page_preview": True}
    for chat_id in chat_ids:
        payload = {**payload_base, "chat_id": chat_id}
        try:
            resp = requests.post(url, json=payload, timeout=10)
            resp.raise_for_status()
            sent += 1
        except Exception as exc:
            log.warning("Telegram alert failed org=%s chat=%s: %s", org_id, chat_id, exc)
    return sent


def send_print_event_notification(
    db: Session,
    org_id: int,
    *,
    event: str,
    printer_name: str,
    file_name: str | None = None,
    reason: str | None = None,
    dedupe_key: str | None = None,
) -> int:
    """Send a printer lifecycle notification, suppressing duplicate deliveries."""
    from app.services.cache import cache_get, cache_set
    from datetime import datetime, timezone
    from app.core.config import settings

    key = f"tg:print-event:{org_id}:{dedupe_key or event}:{printer_name}:{file_name or '-'}"
    if cache_get(key):
        return 0

    if event == "started":
        title = "▶ Print started"
    elif event == "completed":
        title = "✅ Print completed"
    elif event == "failed":
        title = "🛑 Print failed"
    elif event == "cancelled":
        title = "⏹ Print cancelled"
    else:
        title = "🖨️ Print update"

    lines = [title, f"Printer: {printer_name}"]
    if file_name:
        lines.append(f"File: {file_name}")
    if reason:
        lines.append(f"Reason: {reason}")
    if settings.FARM_PUBLIC_URL:
        lines.append(f"{settings.FARM_PUBLIC_URL}/printers")

    sent = send_org_notification(db, org_id, "\n".join(lines))
    if sent:
        cache_set(key, {"sent_at": datetime.now(timezone.utc).isoformat()}, 300)
    return sent
