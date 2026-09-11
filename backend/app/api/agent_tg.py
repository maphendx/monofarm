"""Agent Telegram endpoints — called by the local farm agent to serve bot commands.

GET  /api/agent/tg-config    — fetch org's decrypted token + cached username.
POST /api/agent/tg-command   — handle a bot command (/start, /план, /статус)
                               and return the reply text.
"""
from datetime import date

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles
from app.core.db import get_db
from app.models.organization import Organization
from app.models.user import User, UserRole

router = APIRouter(prefix="/api/agent", tags=["agent-tg"], dependencies=[Depends(require_roles(UserRole.admin))])


class TgCommandRequest(BaseModel):
    command: str          # "start" | "plan" | "status"
    chat_id: int
    args: list[str] = []


class TgUsernameReport(BaseModel):
    username: str


@router.get("/tg-config")
def tg_config(
    org: Organization = Depends(get_current_org),
) -> dict:
    """Return the org's decrypted bot token and cached username.

    Agent calls this on every WS connect so it can start the bot
    even before the server pushes a TG_CONFIG tunnel message.
    """
    token: str | None = None
    if org.tg_bot_token:
        from app.services.encryption import decrypt
        try:
            token = decrypt(org.tg_bot_token)
        except Exception:
            token = None
    return {
        "token": token,
        "username": org.tg_bot_username or None,
    }


@router.post("/tg-report-username")
def tg_report_username(
    payload: TgUsernameReport,
    org: Organization = Depends(get_current_org),
    db: Session = Depends(get_db),
) -> dict:
    """Agent calls this after a successful getMe to cache the bot username for deep-link generation."""
    org.tg_bot_username = payload.username.lstrip("@")
    db.commit()
    return {"ok": True}


@router.post("/tg-command")
def tg_command(
    payload: TgCommandRequest,
    org: Organization = Depends(get_current_org),
    db: Session = Depends(get_db),
) -> dict:
    """Handle a Telegram bot command from the local agent.

    Returns {"text": ..., "parse_mode": "Markdown" | null}.
    """
    cmd      = payload.command.lower().strip("/")
    chat_id  = payload.chat_id

    if cmd == "start":
        return _handle_start(db, org, chat_id, payload.args)
    if cmd in ("план", "plan"):
        return _handle_plan(db, org, chat_id)
    if cmd in ("статус", "status"):
        return _handle_status(db, org, chat_id)

    return {"text": "Невідома команда.", "parse_mode": None}


# ── handlers ──────────────────────────────────────────────────────────────────

def _user_by_chat(db: Session, chat_id: int, org_id: int) -> User | None:
    return db.query(User).filter(User.telegram_chat_id == chat_id, User.organization_id == org_id, User.is_active.is_(True)).first()


def _handle_start(db: Session, org: Organization, chat_id: int, args: list[str]) -> dict:
    if args:
        from datetime import datetime, timezone
        code = (args[0] or "").strip()
        user = db.query(User).filter(User.telegram_link_code == code, User.organization_id == org.id, User.is_active.is_(True)).first()
        if not user:
            return {"text": "Невірний код. Попроси адміна надіслати нове посилання.", "parse_mode": None}
        if user.telegram_link_expires_at and user.telegram_link_expires_at < datetime.now(timezone.utc):
            return {"text": "Посилання прострочене. Попроси адміна нове.", "parse_mode": None}
        user.telegram_chat_id = chat_id
        user.telegram_link_code = None
        user.telegram_link_expires_at = None
        db.commit()
        name = user.name or user.email
        return {
            "text": (
                f"✅ Готово, {name}!\n\n"
                "Тут будуть приходити:\n"
                "• ранкові плани о 09:00\n"
                "• алерти про принтери\n\n"
                "Команди: /план — план на сьогодні, /статус — стан принтерів."
            ),
            "parse_mode": None,
        }

    user = _user_by_chat(db, chat_id, org.id)
    if user:
        name = user.name or user.email
        text = f"Вітаю, {name}.\nКоманди: /план, /статус."
    else:
        text = (
            "Цей чат не привʼязаний до акаунта monofarm.\n"
            "Попроси адміна надіслати тобі персональне посилання."
        )
    return {"text": text, "parse_mode": None}


def _handle_plan(db: Session, org: Organization, chat_id: int) -> dict:
    user = _user_by_chat(db, chat_id, org.id)
    if not user:
        return {"text": "Не зареєстрований. Попроси адміна посилання.", "parse_mode": None}
    from app.services.daily_report import build_daily_plan_text
    text = build_daily_plan_text(db, user.organization_id, date.today())
    return {"text": text, "parse_mode": "Markdown"}


def _handle_status(db: Session, org: Organization, chat_id: int) -> dict:
    user = _user_by_chat(db, chat_id, org.id)
    if not user:
        return {"text": "Не зареєстрований.", "parse_mode": None}
    from app.services.daily_report import build_status_text
    text = build_status_text(db, org)
    return {"text": text, "parse_mode": "Markdown"}
