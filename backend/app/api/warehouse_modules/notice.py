"""Organization warehouse notice and server-sent event endpoints."""
import asyncio
from datetime import datetime, timedelta


from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles, require_warehouse_full
from app.core.db import get_db
from app.models.organization import Organization
from app.models.user import User, UserRole
from app.schemas.warehouse import (
    WarehouseNoticeOut, WarehouseNoticeUpdate,
)

public_router = APIRouter(tags=["warehouse"])

_WAREHOUSE_NOTICE_KEY = "warehouse_notice"
_WAREHOUSE_NOTICE_SUBSCRIBERS: dict[int, set[asyncio.Queue[WarehouseNoticeOut]]] = {}

# All routes that require Starter plan or above (full warehouse access).
# Free plan can only access /products and /categories.
full_router = APIRouter(dependencies=[Depends(require_warehouse_full)])

# ── Warehouse notice ──────────────────────────────────────────────────────────

def _parse_notice_dt(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.removesuffix("Z"))
    except ValueError:
        return None


def _warehouse_notice_out(org: Organization) -> WarehouseNoticeOut:
    settings = org.tag_settings or {}
    raw = settings.get(_WAREHOUSE_NOTICE_KEY) if isinstance(settings, dict) else None
    if not isinstance(raw, dict):
        return WarehouseNoticeOut()
    text = str(raw.get("text") or "").strip()
    expires_at = raw.get("expires_at") if isinstance(raw.get("expires_at"), str) else None
    expires_at_dt = _parse_notice_dt(expires_at)
    active = bool(text) and (expires_at_dt is None or expires_at_dt > datetime.utcnow())
    if not active:
        text = ""
    return WarehouseNoticeOut(
        text=text,
        updated_at=raw.get("updated_at") if isinstance(raw.get("updated_at"), str) else None,
        expires_at=expires_at,
        active=active,
    )


@public_router.get("/notice", response_model=WarehouseNoticeOut)
def get_warehouse_notice(
    org: Organization = Depends(get_current_org),
) -> WarehouseNoticeOut:
    return _warehouse_notice_out(org)


def _publish_warehouse_notice(org_id: int, notice: WarehouseNoticeOut) -> None:
    subscribers = _WAREHOUSE_NOTICE_SUBSCRIBERS.get(org_id)
    if not subscribers:
        return
    for queue in list(subscribers):
        if queue.full():
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        queue.put_nowait(notice)


@public_router.get("/notice/stream")
async def stream_warehouse_notice(
    request: Request,
    org: Organization = Depends(get_current_org),
) -> StreamingResponse:
    queue: asyncio.Queue[WarehouseNoticeOut] = asyncio.Queue(maxsize=5)
    subscribers = _WAREHOUSE_NOTICE_SUBSCRIBERS.setdefault(org.id, set())
    subscribers.add(queue)
    await queue.put(_warehouse_notice_out(org))

    async def events():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    notice = await asyncio.wait_for(queue.get(), timeout=15)
                    yield f"data: {notice.model_dump_json()}\n\n"
                except asyncio.TimeoutError:
                    yield "event: ping\ndata: {}\n\n"
        finally:
            subscribers.discard(queue)
            if not subscribers:
                _WAREHOUSE_NOTICE_SUBSCRIBERS.pop(org.id, None)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@public_router.put("/notice", response_model=WarehouseNoticeOut)
async def update_warehouse_notice(
    payload: WarehouseNoticeUpdate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _: User = Depends(require_roles(UserRole.admin)),
) -> WarehouseNoticeOut:
    text = payload.text.strip()
    settings = dict(org.tag_settings or {})

    if text:
        expires_at = None
        if payload.ttl_seconds is not None:
            expires_at = (
                datetime.utcnow() + timedelta(seconds=payload.ttl_seconds)
            ).isoformat(timespec="seconds") + "Z"
        settings[_WAREHOUSE_NOTICE_KEY] = {
            "text": text,
            "updated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "expires_at": expires_at,
        }
    else:
        settings.pop(_WAREHOUSE_NOTICE_KEY, None)

    org.tag_settings = settings
    db.add(org)
    db.commit()
    db.refresh(org)
    notice = _warehouse_notice_out(org)
    _publish_warehouse_notice(org.id, notice)
    return notice

