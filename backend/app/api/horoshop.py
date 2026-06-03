from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles
from app.core.config import settings as app_settings
from app.core.db import SessionLocal, get_db
from app.models.organization import Organization
from app.models.user import User, UserRole
from app.models.warehouse import HoroshopSyncEvent
from app.services import horoshop
from app.services.encryption import encrypt

log = logging.getLogger("monofarm.horoshop")

router = APIRouter(prefix="/horoshop", tags=["horoshop"])


class HoroshopSettingsOut(BaseModel):
    domain: str
    login: str
    verify_ssl: bool
    configured: bool
    webhook_url: str
    subscribed_events: dict[str, int]
    last_sync_at: datetime | None
    orders_total: int
    errors_total: int
    last_event_status: str | None
    last_event_message: str | None


class HoroshopSettingsUpdate(BaseModel):
    domain: str | None = None
    login: str | None = None
    password: str | None = None
    verify_ssl: bool | None = None
    reset_webhook_secret: bool = False


class HoroshopSyncRequest(BaseModel):
    from_date: datetime | None = None
    to_date: datetime | None = None
    order_ids: list[str] | None = None


def _webhook_url(org: Organization) -> str:
    secret = horoshop.webhook_secret(org)
    return f"{app_settings.FARM_PUBLIC_URL}/api/horoshop/webhook/{org.slug}/{secret}"


def _settings_out(org: Organization, db: Session) -> HoroshopSettingsOut:
    stats = horoshop.sync_stats(org, db)
    return HoroshopSettingsOut(
        domain=org.horoshop_domain or "",
        login=org.horoshop_login or "",
        verify_ssl=bool(org.horoshop_verify_ssl),
        configured=horoshop.configured(org),
        webhook_url=_webhook_url(org),
        subscribed_events=org.horoshop_hook_ids or {},
        last_sync_at=org.horoshop_last_sync_at,
        **stats,
    )


def _background_process_event(event_id: int) -> None:
    with SessionLocal() as db:
        try:
            horoshop.process_event(event_id, db)
        except Exception:
            log.exception("Horoshop webhook event %s failed", event_id)


@router.get("/settings", response_model=HoroshopSettingsOut)
def get_settings(
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _: User = Depends(require_roles(UserRole.admin)),
) -> HoroshopSettingsOut:
    if not org.horoshop_webhook_secret:
        horoshop.webhook_secret(org)
        db.commit()
        db.refresh(org)
    return _settings_out(org, db)


@router.put("/settings", response_model=HoroshopSettingsOut)
def update_settings(
    payload: HoroshopSettingsUpdate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _: User = Depends(require_roles(UserRole.admin)),
) -> HoroshopSettingsOut:
    if payload.domain is not None:
        org.horoshop_domain = horoshop.normalize_domain(payload.domain)
    if payload.login is not None:
        org.horoshop_login = payload.login.strip()
    if payload.password is not None:
        org.horoshop_password = encrypt(payload.password.strip()) if payload.password.strip() else ""
    if payload.verify_ssl is not None:
        org.horoshop_verify_ssl = payload.verify_ssl
    if payload.reset_webhook_secret or not org.horoshop_webhook_secret:
        org.horoshop_webhook_secret = ""
        horoshop.webhook_secret(org)
        org.horoshop_hook_ids = {}
    db.commit()
    db.refresh(org)
    return _settings_out(org, db)


@router.post("/test")
def test_connection(
    org: Organization = Depends(get_current_org),
    _: User = Depends(require_roles(UserRole.admin)),
) -> dict[str, Any]:
    try:
        return horoshop.test_connection(org)
    except horoshop.HoroshopError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/subscribe", response_model=HoroshopSettingsOut)
def subscribe_webhooks(
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _: User = Depends(require_roles(UserRole.admin)),
) -> HoroshopSettingsOut:
    if not horoshop.configured(org):
        raise HTTPException(status_code=400, detail="Спочатку збережіть домен, логін і пароль Хорошопа")
    target = _webhook_url(org)
    hook_ids = dict(org.horoshop_hook_ids or {})
    try:
        for event in horoshop.webhook_events():
            if event in hook_ids:
                continue
            hook_ids[event] = horoshop.subscribe_hook(org, event, target)
    except horoshop.HoroshopError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    org.horoshop_hook_ids = hook_ids
    db.commit()
    db.refresh(org)
    return _settings_out(org, db)


@router.post("/sync")
def sync_now(
    payload: HoroshopSyncRequest | None = None,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict[str, Any]:
    try:
        if payload and payload.order_ids:
            return horoshop.sync_orders(org, db, ids=payload.order_ids)
        if payload and (payload.from_date or payload.to_date):
            return horoshop.sync_orders(org, db, from_dt=payload.from_date, to_dt=payload.to_date, max_pages=10)
        return horoshop.sync_recent(org, db)
    except horoshop.HoroshopError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/events")
def list_events(
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _: User = Depends(require_roles(UserRole.admin)),
) -> list[dict[str, Any]]:
    rows = (
        db.query(HoroshopSyncEvent)
        .filter_by(organization_id=org.id)
        .order_by(HoroshopSyncEvent.created_at.desc())
        .limit(20)
        .all()
    )
    return [
        {
            "id": row.id,
            "event_type": row.event_type,
            "external_order_id": row.external_order_id,
            "status": row.status,
            "message": row.message,
            "created_at": row.created_at,
            "processed_at": row.processed_at,
        }
        for row in rows
    ]


@router.api_route("/webhook/{org_slug}/{secret}", methods=["POST", "DELETE"], status_code=status.HTTP_200_OK)
async def webhook(
    org_slug: str,
    secret: str,
    request: Request,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    org = db.query(Organization).filter_by(slug=org_slug).first()
    if not org:
        log.warning("Horoshop webhook: unknown org slug %r", org_slug)
        return {"status": "ignored"}
    if not org.horoshop_webhook_secret or secret != org.horoshop_webhook_secret:
        raise HTTPException(status_code=401, detail="Invalid webhook secret")

    if request.method == "DELETE":
        return {"status": "ok"}

    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid JSON body") from exc

    event_type = str(payload.get("event") or payload.get("type") or "webhook")
    order_ids = horoshop.extract_order_ids(payload)
    event = HoroshopSyncEvent(
        organization_id=org.id,
        event_type=event_type,
        external_order_id=order_ids[0] if order_ids else None,
        payload=payload,
        status="pending",
        created_at=datetime.now(timezone.utc),
    )
    db.add(event)
    db.commit()
    db.refresh(event)
    background_tasks.add_task(_background_process_event, event.id)
    return {"status": "queued", "event_id": event.id}
