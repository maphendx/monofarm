"""Agent Telegram endpoints — called by the local farm agent to serve bot commands.

GET  /api/agent/tg-config    — fetch org's decrypted token + cached username.
POST /api/agent/tg-command   — handle a bot command (/start, /план, /статус)
                               and return the reply text.
"""
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_org
from app.core.db import get_db
from app.models.organization import Organization
from app.models.user import User
from app.schemas.agent import AgentOkOut, TgCommandOut, TgCommandRequest, TgConfigOut, TgUsernameReport
from app.services.agent_auth import AgentPrincipal, require_agent_principal
from app.services.agent_routing import device_can_handle_org_services

router = APIRouter(prefix="/api/agent", tags=["agent-tg"])


def _require_org_service_device(db: Session, principal: AgentPrincipal) -> None:
    if not device_can_handle_org_services(db, principal.device):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Org-wide Telegram service requires one unscoped agent",
        )


def _tg_config_for_org(org: Organization) -> TgConfigOut:
    token: str | None = None
    if org.tg_bot_token:
        from app.services.encryption import decrypt

        try:
            token = decrypt(org.tg_bot_token)
        except Exception:
            token = None
    return TgConfigOut(token=token, username=org.tg_bot_username or None)


@router.get("/tg-config", response_model=TgConfigOut)
def tg_config(
    org: Organization = Depends(get_current_org),
) -> TgConfigOut:
    """Return the org's decrypted bot token and cached username.

    Agent calls this on every WS connect so it can start the bot
    even before the server pushes a TG_CONFIG tunnel message.
    """
    return _tg_config_for_org(org)


@router.get("/v2/tg-config", response_model=TgConfigOut)
def tg_config_v2(
    db: Session = Depends(get_db),
    principal: AgentPrincipal = Depends(require_agent_principal("status:write")),
) -> TgConfigOut:
    _require_org_service_device(db, principal)
    return _tg_config_for_org(principal.organization)


def _tg_report_username_for_org(
    payload: TgUsernameReport,
    org: Organization,
    db: Session,
) -> AgentOkOut:
    org.tg_bot_username = payload.username.lstrip("@")
    db.commit()
    return AgentOkOut()


@router.post("/tg-report-username", response_model=AgentOkOut)
def tg_report_username(
    payload: TgUsernameReport,
    org: Organization = Depends(get_current_org),
    db: Session = Depends(get_db),
) -> AgentOkOut:
    """Agent calls this after a successful getMe to cache the bot username for deep-link generation."""
    return _tg_report_username_for_org(payload, org, db)


@router.post("/v2/tg-report-username", response_model=AgentOkOut)
def tg_report_username_v2(
    payload: TgUsernameReport,
    db: Session = Depends(get_db),
    principal: AgentPrincipal = Depends(require_agent_principal("status:write")),
) -> AgentOkOut:
    _require_org_service_device(db, principal)
    return _tg_report_username_for_org(payload, principal.organization, db)


def _tg_command_for_org(
    payload: TgCommandRequest,
    org: Organization,
    db: Session,
) -> TgCommandOut:
    cmd = payload.command.lower().strip("/")
    chat_id = payload.chat_id

    if cmd == "start":
        return TgCommandOut(**_handle_start(db, org, chat_id, payload.args))
    if cmd in ("план", "plan"):
        return TgCommandOut(**_handle_plan(db, org, chat_id))
    if cmd in ("статус", "status"):
        return TgCommandOut(**_handle_status(db, org, chat_id))

    return TgCommandOut(text="Невідома команда.", parse_mode=None)


@router.post("/tg-command", response_model=TgCommandOut)
def tg_command(
    payload: TgCommandRequest,
    org: Organization = Depends(get_current_org),
    db: Session = Depends(get_db),
) -> TgCommandOut:
    """Handle a Telegram bot command from the local agent.

    Returns {"text": ..., "parse_mode": "Markdown" | null}.
    """
    return _tg_command_for_org(payload, org, db)


@router.post("/v2/tg-command", response_model=TgCommandOut)
def tg_command_v2(
    payload: TgCommandRequest,
    db: Session = Depends(get_db),
    principal: AgentPrincipal = Depends(require_agent_principal("status:write")),
) -> TgCommandOut:
    _require_org_service_device(db, principal)
    return _tg_command_for_org(payload, principal.organization, db)


# ── handlers ──────────────────────────────────────────────────────────────────

def _user_by_chat(db: Session, organization_id: int, chat_id: int) -> User | None:
    return (
        db.query(User)
        .filter(
            User.organization_id == organization_id,
            User.telegram_chat_id == chat_id,
        )
        .first()
    )


def _handle_start(db: Session, org: Organization, chat_id: int, args: list[str]) -> dict:
    if args:
        from datetime import datetime, timezone
        code = (args[0] or "").strip()
        user = (
            db.query(User)
            .filter(
                User.organization_id == org.id,
                User.telegram_link_code == code,
            )
            .first()
        )
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

    user = _user_by_chat(db, org.id, chat_id)
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
    user = _user_by_chat(db, org.id, chat_id)
    if not user:
        return {"text": "Не зареєстрований. Попроси адміна посилання.", "parse_mode": None}
    from app.services.daily_report import build_daily_plan_text
    text = build_daily_plan_text(db, user.organization_id, date.today())
    return {"text": text, "parse_mode": "Markdown"}


def _handle_status(db: Session, org: Organization, chat_id: int) -> dict:
    user = _user_by_chat(db, org.id, chat_id)
    if not user:
        return {"text": "Не зареєстрований.", "parse_mode": None}
    from app.services.daily_report import build_status_text
    text = build_status_text(db, org)
    return {"text": text, "parse_mode": "Markdown"}
