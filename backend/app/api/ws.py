"""WebSocket endpoints — real-time org event stream.

/ws/printers — printer state, 3 s push loop, hash-diffed.
/ws/org      — lightweight org event bus; no polling, only broadcasts.

Message types sent by the server:
  {"type": "connected",        "org_id": int}
  {"type": "printers",         "data": [...]}          — from /ws/printers
  {"type": "warehouse_update", "entity": str}          — from mutation hooks

Messages accepted from client:
  (any text)  — keeps the connection alive, e.g. periodic pings
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from app.core.db import SessionLocal
from app.core.security import decode_token
from app.models.organization import Organization
from app.models.printer import Printer
from app.models.printer_group import PrinterGroup
from app.models.user import is_platform_admin
from app.services import moonraker
from app.services.ws_manager import PRINTER_EVENTS_CHANNEL, manager

log = logging.getLogger(__name__)

router = APIRouter(tags=["ws"])

_TICK = 5  # seconds between state snapshots
_SNAPSHOT_TTL = 4.0
_snapshot_cache: dict[int, tuple[float, str, list[dict]]] = {}
_snapshot_locks: dict[int, asyncio.Lock] = {}


def _build_snapshot(org_id: int) -> list[dict]:
    """Build printer list from cache only — no network calls."""
    from app.api.printers import _to_dto
    from app.models.printer_slot import PrinterSlot as _Slot

    with SessionLocal() as db:
        rows = (
            db.query(Printer)
            .filter(Printer.is_active.is_(True), Printer.organization_id == org_id)
            .all()
        )
        if not rows:
            return []

        all_groups = db.query(PrinterGroup).filter(PrinterGroup.organization_id == org_id).all()
        groups_by_id = {g.id: g.name for g in all_groups}
        groups_order = {g.id: g.sort_order for g in all_groups}

        from app.api.printers import _natural_key
        rows.sort(key=lambda p: (
            p.group_id is None,
            groups_order.get(p.group_id, 0) if p.group_id is not None else 0,
            p.sort_order,
            _natural_key(p.name),
        ))
        slot_rows = (
            db.query(_Slot)
            .filter(_Slot.printer_id.in_([r.id for r in rows]))
            .all()
        )
        slots_by_printer: dict[int, list[dict]] = {}
        for s in slot_rows:
            slots_by_printer.setdefault(s.printer_id, []).append({
                "slot_index": s.slot_index,
                "filament_id": s.filament_id,
                "material": s.material,
                "color": s.color,
                "hex_color": s.hex_color,
                "brand": s.brand,
                "grams_at_load": s.grams_at_load,
                "state": s.state.value,
                "unit_index": s.unit_index,
                "is_external": s.is_external,
            })

        out = []
        for row in rows:
            cached = (
                moonraker.get_cached_live_status(row.moonraker_url)
                if row.moonraker_url else None
            )
            pslots = slots_by_printer.get(row.id) or None
            out.append(
                _to_dto(row, db, groups_by_id, prefetched_live=cached, prefetched_slots=pslots)
                .model_dump(mode="json")
            )
        return out


async def _get_snapshot(org_id: int) -> tuple[list[dict], str]:
    now = time.monotonic()
    cached = _snapshot_cache.get(org_id)
    if cached and now - cached[0] < _SNAPSHOT_TTL:
        return cached[2], cached[1]

    lock = _snapshot_locks.setdefault(org_id, asyncio.Lock())
    async with lock:
        now = time.monotonic()
        cached = _snapshot_cache.get(org_id)
        if cached and now - cached[0] < _SNAPSHOT_TTL:
            return cached[2], cached[1]
        return await _build_and_cache_snapshot(org_id)


async def _build_and_cache_snapshot(org_id: int) -> tuple[list[dict], str]:
    data = await asyncio.to_thread(_build_snapshot, org_id)
    raw = json.dumps(data, default=str)
    digest = hashlib.md5(raw.encode()).hexdigest()
    _snapshot_cache[org_id] = (time.monotonic(), digest, data)
    return data, digest


async def broadcast_printer_snapshot(org_id: int) -> None:
    """Push a fresh printer snapshot after an out-of-process device event."""
    _snapshot_cache.pop(org_id, None)
    lock = _snapshot_locks.setdefault(org_id, asyncio.Lock())
    async with lock:
        data, _digest = await _build_and_cache_snapshot(org_id)
    await manager.broadcast(org_id, {"type": "printers", "data": data})


async def run_printer_event_listener() -> None:
    """Bridge worker-side MQTT changes into web-process WebSocket sessions."""
    from app.core.config import settings

    if not settings.REDIS_URL:
        return

    import redis.asyncio as aioredis

    while True:
        client = None
        pubsub = None
        try:
            client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
            pubsub = client.pubsub()
            await pubsub.subscribe(PRINTER_EVENTS_CHANNEL)
            log.info("printer event listener: subscribed")
            async for message in pubsub.listen():
                if message.get("type") != "message":
                    continue
                try:
                    event = json.loads(message["data"])
                    await broadcast_printer_snapshot(int(event["org_id"]))
                except asyncio.CancelledError:
                    raise
                except Exception:
                    log.exception("printer event failed: %s", message.get("data"))
        except asyncio.CancelledError:
            return
        except Exception:
            log.exception("printer event listener lost connection — retrying in 5s")
            await asyncio.sleep(5)
        finally:
            if pubsub is not None:
                await pubsub.aclose()
            if client is not None:
                await client.aclose()


@router.websocket("/ws/printers")
async def printer_stream(
    websocket: WebSocket,
    token: str | None = Query(default=None),
    impersonated_org_id: int | None = Query(default=None),
) -> None:
    # ── Auth ──────────────────────────────────────────────────────────────
    org_id = _auth_org(token, impersonated_org_id)
    if org_id is None:
        await websocket.close(code=1008)
        return

    # ── Connect ───────────────────────────────────────────────────────────
    await manager.connect(websocket, org_id)
    try:
        await websocket.send_json({"type": "connected", "org_id": org_id})

        last_hash = ""

        async def _push_loop() -> None:
            nonlocal last_hash
            while True:
                try:
                    data, h = await _get_snapshot(org_id)
                    if h != last_hash:
                        last_hash = h
                        await websocket.send_json({"type": "printers", "data": data})
                except Exception:
                    log.exception("ws printer tick error org=%s", org_id)
                await asyncio.sleep(_TICK)

        push_task = asyncio.create_task(_push_loop())
        try:
            while True:
                await websocket.receive_text()  # keeps connection alive, accepts pings
        except WebSocketDisconnect:
            pass
        finally:
            push_task.cancel()
    finally:
        await manager.disconnect(websocket, org_id)


def _auth_org(token: str | None, impersonated_org_id: int | None = None) -> int | None:
    """Decode token → org_id, or None if invalid."""
    payload = decode_token(token or "")
    if not payload:
        return None
    user_id_raw = payload.get("sub")
    if not user_id_raw:
        return None
    with SessionLocal() as db:
        from app.models.user import User
        user = db.get(User, int(user_id_raw))
        if not user or not user.is_active:
            return None
        if impersonated_org_id is not None:
            if not is_platform_admin(user):
                return None
            org = db.get(Organization, impersonated_org_id)
            return org.id if org else None
        if user.organization_id is None:
            return None
        return user.organization_id


@router.websocket("/ws/org")
async def org_event_stream(
    websocket: WebSocket,
    token: str | None = Query(default=None),
    impersonated_org_id: int | None = Query(default=None),
) -> None:
    """Lightweight org event bus — no state polling, only push on mutations."""
    org_id = _auth_org(token, impersonated_org_id)
    if org_id is None:
        await websocket.close(code=1008)
        return

    await manager.connect(websocket, org_id)
    try:
        await websocket.send_json({"type": "connected", "org_id": org_id})
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await manager.disconnect(websocket, org_id)


async def broadcast_warehouse(org_id: int, entity: str) -> None:
    """Broadcast a warehouse mutation event to all connected clients in the org."""
    await manager.broadcast(org_id, {"type": "warehouse_update", "entity": entity})


async def broadcast_queue(org_id: int, event: str, task_id: int | None = None, printer_id: int | None = None) -> None:
    """Broadcast a queue/task event so frontend can refresh in real time."""
    await manager.broadcast(org_id, {
        "type": "queue_update",
        "event": event,
        "task_id": task_id,
        "printer_id": printer_id,
    })
