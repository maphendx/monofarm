"""WebSocket tunnel manager for monofarm-agent connections.

Each organization can have one active agent connection.
The agent runs on the client's local network and proxies HTTP requests
(and streams) to Moonraker/go2rtc on behalf of the cloud server.

Wire protocol:
  Regular request/response:
    Server→Agent: {"id":"<uuid>","method":"GET","url":"…","body":null}
    Agent→Server: {"id":"<uuid>","status":200,"body":{…},"error":null}

  Streaming (MJPEG camera etc.):
    Server→Agent: {"id":"<uuid>","method":"STREAM","url":"…"}
    Agent→Server: {"id":"<uuid>","type":"stream_start","status":200,"content_type":"…"}
    Agent→Server: {"id":"<uuid>","type":"chunk","data":"<base64>"}  (repeated)
    Agent→Server: {"id":"<uuid>","type":"stream_end"}
"""
from __future__ import annotations

import asyncio
import base64
import inspect
import json
import logging
import time
import uuid
from collections.abc import AsyncGenerator
from typing import Any, Awaitable, Callable
from uuid import UUID

from fastapi import WebSocket

from app.models.bambu_cloud_job import BambuCloudJobStatus

log = logging.getLogger(__name__)


class AgentMessageRejected(RuntimeError):
    def __init__(self, reason: str, *, close_code: int = 4003) -> None:
        super().__init__(reason)
        self.close_code = close_code


_STATUS_MESSAGE_TYPES = frozenset(
    {"STATUS_PUSH", "BAMBU_STATUS_PUSH", "TG_BOT_USERNAME", "TG_CLAIM_LINK"}
)

# org_id → active WebSocket
_tunnels: dict[int, WebSocket] = {}
# org_id → (protocol-v2 device id, exact WebSocket). Legacy sockets never
# populate this map, so durable commands cannot be assigned through a v1
# connection merely because an organization-level tunnel exists.
_device_tunnels: dict[int, tuple[UUID, WebSocket]] = {}
_agent_capabilities: dict[int, set[str]] = {}
# Reconnects replace, rather than accumulate, delayed setup work. Without this
# guard a flapping agent can start the same 200-job history scan many times.
_subscription_tasks: dict[int, asyncio.Task[None]] = {}
_backfill_tasks: dict[int, asyncio.Task[None]] = {}
# request_id → Future  (regular request/response)
_pending: dict[str, asyncio.Future] = {}
# request_id → org_id — lets unregister() fail only its own org's requests
_pending_org: dict[str, int] = {}
_pending_upload_progress: dict[str, Callable[[dict[str, Any]], Awaitable[None] | None]] = {}
# request_id → Queue  (streaming)
_pending_streams: dict[str, asyncio.Queue] = {}
# request_id → org_id — used to end only the disconnected tenant's streams
_pending_stream_org: dict[str, int] = {}

# Camera producers can outpace browsers.  Keep only a short window so a slow
# consumer sees the newest frames without growing the worker's memory forever.
STREAM_QUEUE_MAX = 8

# Uploads are bounded by a stall guard, not total time: a slow printer link
# (U1 WiFi can drop to ~30 KB/s) may legitimately need many minutes per file.
UPLOAD_STALL_TIMEOUT = 180.0  # seconds without an agent progress message → dead upload
_UPLOAD_POLL = 5.0


def _put_stream_item(q: asyncio.Queue, item: bytes | None) -> None:
    """Queue a stream item, evicting the oldest buffered frame if necessary."""
    while q.full():
        try:
            q.get_nowait()
        except asyncio.QueueEmpty:
            break
    q.put_nowait(item)


async def _cancel_stream(ws: WebSocket, req_id: str) -> None:
    """Best-effort cancellation for the matching producer on the farm agent."""
    try:
        await ws.send_text(json.dumps({"id": req_id, "method": "STREAM_CANCEL"}))
    except Exception:
        log.debug("Failed to cancel agent stream %s", req_id)


def has_tunnel(org_id: int) -> bool:
    return org_id in _tunnels


def connected_device_id(org_id: int) -> UUID | None:
    """Return the v2 identity bound to the organization's current socket."""
    current = _tunnels.get(org_id)
    registered = _device_tunnels.get(org_id)
    if current is None or registered is None or registered[1] is not current:
        return None
    return registered[0]


def is_device_connected(org_id: int, device_id: UUID) -> bool:
    return connected_device_id(org_id) == device_id


def _moonraker_cache_key(org_id: int, moonraker_url: str) -> str:
    """Process-local key for one tenant's LAN printer address."""
    return f"org:{org_id}:{moonraker_url}"


def _moonraker_redis_key(org_id: int, bucket: str, moonraker_url: str) -> str:
    """Shared-cache key that cannot collide across identical customer LANs."""
    return f"mr:org:{org_id}:{bucket}:{moonraker_url}"


# ── Telegram helpers ──────────────────────────────────────────────────────────

async def send_tg_config(org_id: int, token: str | None) -> None:
    """Push a new bot token to the agent (fire-and-forget). token=None means disable."""
    ws = _tunnels.get(org_id)
    if not ws:
        return
    try:
        await ws.send_text(json.dumps({"type": "TG_CONFIG", "token": token or ""}))
    except Exception:
        log.debug("send_tg_config: failed to send to org %s", org_id)


async def send_telegram(
    org_id: int, chat_id: int, text: str, parse_mode: str | None = "Markdown"
) -> bool:
    """Send a Telegram message via the org's local agent bot (fire-and-forget)."""
    ws = _tunnels.get(org_id)
    if not ws:
        log.warning("send_telegram: no agent connected for org %s", org_id)
        return False
    try:
        await ws.send_text(json.dumps({
            "type": "TG_SEND",
            "chat_id": chat_id,
            "text": text,
            "parse_mode": parse_mode,
        }))
        return True
    except Exception:
        log.warning("send_telegram: failed to send to org %s chat %s", org_id, chat_id)
        return False


async def register(
    org_id: int,
    ws: WebSocket,
    *,
    device_id: UUID | None = None,
) -> bool:
    current = _tunnels.get(org_id)
    registered_device = _device_tunnels.get(org_id)
    if current is not None:
        if current is ws and (
            (device_id is None and registered_device is None)
            or (registered_device is not None and registered_device[0] == device_id)
        ):
            return True
        if (
            device_id is not None
            and registered_device is not None
            and registered_device[0] == device_id
        ):
            # A process may keep the old TCP socket around briefly after a
            # laptop resumes or the network changes. Bind the route to the new
            # authenticated connection before fencing the ghost, so the old
            # handler's eventual unregister() cannot remove the replacement.
            _tunnels[org_id] = ws
            _device_tunnels[org_id] = (device_id, ws)
            _agent_capabilities[org_id] = set()
            try:
                await current.close(
                    code=4008,
                    reason="Superseded by a newer connection for this device",
                )
            except Exception:
                log.debug("Failed to fence stale agent socket for org %s", org_id)
            log.info("Agent device %s reconnected for org %s", device_id, org_id)
            _schedule_connection_setup(org_id, device_id=device_id)
            return True
        if device_id is not None or registered_device is not None:
            # There is no Printer.site_id/device assignment yet. Allowing a
            # second v2 identity (or a v1 socket over a live v2 identity) to
            # replace this route could deliver physical commands to the wrong
            # farm. The WebSocket caller closes the rejected socket with 4009.
            log.warning(
                "Rejected concurrent agent socket for org %s (existing_device=%s, requested_device=%s)",
                org_id,
                registered_device[0] if registered_device else None,
                device_id,
            )
            return False
        log.info("Legacy agent reconnected for org %s — replacing old connection", org_id)
    _tunnels[org_id] = ws
    if device_id is None:
        _device_tunnels.pop(org_id, None)
    else:
        _device_tunnels[org_id] = (device_id, ws)
    _agent_capabilities[org_id] = set()
    log.info("Agent connected for org %s (total: %s)", org_id, len(_tunnels))
    _schedule_connection_setup(org_id, device_id=device_id)
    return True


def _replace_org_task(
    tasks: dict[int, asyncio.Task[None]],
    org_id: int,
    coroutine,
) -> None:
    previous = tasks.get(org_id)
    if previous is not None and not previous.done():
        previous.cancel()

    task = asyncio.create_task(coroutine)
    tasks[org_id] = task

    def cleanup(finished: asyncio.Task[None]) -> None:
        if tasks.get(org_id) is finished:
            tasks.pop(org_id, None)

    task.add_done_callback(cleanup)


def _schedule_connection_setup(org_id: int, *, device_id: UUID | None) -> None:
    _replace_org_task(
        _subscription_tasks,
        org_id,
        _subscribe_org_printers(org_id, device_id=device_id),
    )
    _replace_org_task(
        _backfill_tasks,
        org_id,
        _backfill_org_history(org_id, device_id=device_id),
    )


async def _subscribe_org_printers(org_id: int, *, device_id: UUID | None = None) -> None:
    """Subscribe the socket only to printers routed to its device identity."""
    await asyncio.sleep(0.5)  # let the agent finish its own setup first
    ws = _tunnels.get(org_id)
    if not ws:
        return
    from app.core.db import SessionLocal
    from app.models.printer import Printer
    with SessionLocal() as db:
        query = db.query(Printer).filter_by(organization_id=org_id, is_active=True)
        if device_id is not None:
            from app.models.agent import AgentDevice
            from app.services.agent_routing import printer_query_for_device

            device = db.get(AgentDevice, device_id)
            if device is None or device.organization_id != org_id:
                return
            query = printer_query_for_device(db, device).filter(Printer.is_active.is_(True))
        printers = query.filter(Printer.moonraker_url.isnot(None)).all()
    for p in printers:
        ws = _tunnels.get(org_id)
        if not ws:
            break
        try:
            await ws.send_text(json.dumps({
                "id": str(uuid.uuid4()),
                "method": "MOONRAKER_SUBSCRIBE",
                "url": p.moonraker_url,
                "name": p.name,
                "kind": p.kind.value,
            }))
            log.debug("Sent MOONRAKER_SUBSCRIBE for %s (org %s)", p.moonraker_url, org_id)
        except Exception as e:
            log.debug("_subscribe_org_printers: send failed for %s: %s", p.moonraker_url, e)
            break


async def _backfill_org_history(org_id: int, *, device_id: UUID | None = None) -> None:
    """Backfill only Moonraker printers routed to the connected device."""
    await asyncio.sleep(3)  # let subscriptions settle first
    try:
        from app.core.db import SessionLocal
        from app.models.printer import Printer
        from app.services.print_tracker import backfill_moonraker_history

        with SessionLocal() as db:
            query = db.query(Printer).filter_by(organization_id=org_id, is_active=True)
            if device_id is not None:
                from app.models.agent import AgentDevice
                from app.services.agent_routing import printer_query_for_device

                device = db.get(AgentDevice, device_id)
                if device is None or device.organization_id != org_id:
                    return
                query = printer_query_for_device(db, device).filter(Printer.is_active.is_(True))
            printers = query.filter(Printer.moonraker_url.isnot(None)).all()
            rows = [(p.id, p.name, p.kind.value, p.moonraker_url) for p in printers]

        for pid, pname, pkind, purl in rows:
            await backfill_moonraker_history(
                org_id=org_id,
                printer_id=pid,
                printer_name=pname,
                printer_kind=pkind,
                moonraker_url=purl,
            )
    except Exception:
        log.exception("_backfill_org_history failed for org %s", org_id)


async def unregister(org_id: int, ws: WebSocket | None = None) -> None:
    current = _tunnels.get(org_id)
    if ws is not None and current is not None and current is not ws:
        # A reconnect already replaced this socket — keep the live tunnel intact.
        log.info("Agent stale socket closed for org %s — replacement kept", org_id)
        return
    _tunnels.pop(org_id, None)
    registered_device = _device_tunnels.get(org_id)
    if registered_device is not None and (ws is None or registered_device[1] is ws):
        _device_tunnels.pop(org_id, None)
    _agent_capabilities.pop(org_id, None)
    for tasks in (_subscription_tasks, _backfill_tasks):
        task = tasks.pop(org_id, None)
        if task is not None and not task.done():
            task.cancel()
    # Fail only this org's futures — other orgs' in-flight requests stay alive
    for req_id, fut in list(_pending.items()):
        if _pending_org.get(req_id) != org_id:
            continue
        if not fut.done():
            fut.set_exception(RuntimeError(f"Agent disconnected (org {org_id})"))
        _pending_upload_progress.pop(req_id, None)
    for req_id, q in list(_pending_streams.items()):
        if _pending_stream_org.get(req_id) != org_id:
            continue
        _put_stream_item(q, None)
        _pending_stream_org.pop(req_id, None)
    log.info("Agent disconnected for org %s (total: %s)", org_id, len(_tunnels))


async def _handle_tg_bot_username(data: dict, org_id: int) -> None:
    """Agent reported its bot username after a successful getMe."""
    username = (data.get("username") or "").strip()
    if not username:
        return
    from app.core.db import SessionLocal
    from app.models.organization import Organization
    with SessionLocal() as db:
        org = db.get(Organization, int(org_id))
        if org:
            org.tg_bot_username = username
            db.commit()
    log.info("Org %s Telegram bot username cached: @%s", org_id, username)


async def _handle_tg_claim_link(data: dict, org_id_tunnel: int) -> None:
    """Agent received /start <code> — validate and link the user's chat_id."""
    from datetime import datetime, timezone
    from app.core.db import SessionLocal
    from app.models.user import User
    code    = (data.get("code") or "").strip()
    chat_id = data.get("chat_id")
    if not code or not chat_id:
        return
    reply_text: str
    parse_mode: str | None = None
    with SessionLocal() as db:
        user = (
            db.query(User)
            .filter(
                User.organization_id == org_id_tunnel,
                User.telegram_link_code == code,
            )
            .first()
        )
        if not user:
            reply_text = "Невірний код. Попроси адміна надіслати нове посилання."
        elif user.telegram_link_expires_at and user.telegram_link_expires_at < datetime.now(timezone.utc):
            reply_text = "Посилання прострочене. Попроси адміна нове."
        else:
            user.telegram_chat_id = int(chat_id)
            user.telegram_link_code = None
            user.telegram_link_expires_at = None
            db.commit()
            name = user.name or user.email
            reply_text = (
                f"✅ Готово, {name}!\n\n"
                "Тут будуть приходити:\n"
                "• ранкові плани о 09:00\n"
                "• алерти про принтери\n\n"
                "Команди: /план — план на сьогодні, /статус — стан принтерів."
            )
    await send_telegram(org_id_tunnel, int(chat_id), reply_text, parse_mode)


def _handle_status_push(data: dict, org_id: int) -> None:
    """Cache a Moonraker status pushed by the agent's WS subscription."""
    url = data.get("url") or ""
    raw = data.get("status") or {}
    if not url or not raw:
        return
    from app.services.moonraker import _parse_moonraker_status, _status_cache, STATUS_CACHE_TTL
    from app.services.cache import cache_set
    status = _parse_moonraker_status(raw)
    # _status_cache is shared with moonraker module; tunnel path expects (timestamp, status)
    cache_key = _moonraker_cache_key(org_id, url)
    _status_cache[cache_key] = (time.monotonic(), status)
    # Redis path used by moonraker.get_live_status (fresh + stale keys)
    cache_set(_moonraker_redis_key(org_id, "status", url), status, int(STATUS_CACHE_TTL))
    cache_set(_moonraker_redis_key(org_id, "stale", url), status, int(STATUS_CACHE_TTL * 10))
    log.debug("STATUS_PUSH: cached %s state=%s", url, status.get("state"))


_autoprint_idle_kicks: dict[str, float] = {}


def _handle_bambu_status_push(data: dict, org_id: int) -> None:
    """Cache a Bambu LAN MQTT report pushed by the agent."""
    dev_id = (data.get("dev_id") or "").strip()
    payload = data.get("payload") or {}
    if not dev_id or not isinstance(payload, dict):
        return
    from app.core.db import SessionLocal
    from app.models.printer import Printer, PrinterKind

    with SessionLocal() as db:
        owns_device = (
            db.query(Printer.id)
            .filter(
                Printer.organization_id == org_id,
                Printer.kind == PrinterKind.bambu,
                Printer.bambu_dev_id == dev_id,
                Printer.is_active.is_(True),
            )
            .first()
            is not None
        )
    if not owns_device:
        log.warning("Rejected Bambu status for an unregistered org device")
        return
    from app.services import bambu
    job = bambu.handle_agent_report(org_id, dev_id, payload)
    if job is not None and job.plan_entry_id is not None and job.status in {
        BambuCloudJobStatus.completed,
        BambuCloudJobStatus.failed,
        BambuCloudJobStatus.cancelled,
        BambuCloudJobStatus.lost,
    }:
        from app.services.autoprint import handle_terminal_job

        asyncio.create_task(handle_terminal_job(job.id))
    else:
        raw_state = str((payload.get("print") or {}).get("gcode_state") or "")
        now = time.monotonic()
        if raw_state in {"IDLE", "FINISH"} and now - _autoprint_idle_kicks.get(dev_id, 0.0) >= 30:
            _autoprint_idle_kicks[dev_id] = now
            from app.services.autoprint import start_next_for_device

            asyncio.create_task(
                start_next_for_device(
                    org_id,
                    dev_id,
                    allow_finished_state=raw_state == "FINISH",
                )
            )
    log.debug("BAMBU_STATUS_PUSH: cached %s", dev_id)


def _required_scope_for_message(data: dict) -> str:
    msg_type = data.get("type")
    if msg_type == "AGENT_HELLO":
        return "agent:connect"
    if msg_type in _STATUS_MESSAGE_TYPES:
        return "status:write"
    if data.get("id"):
        return "commands:read"
    raise AgentMessageRejected("Unsupported agent message", close_code=4004)


def _authorize_v2_message_target(data: dict, org_id: int, device_id: UUID) -> None:
    from app.core.db import SessionLocal
    from app.models.agent import AgentDevice
    from app.services.agent_routing import (
        device_can_handle_org_services,
        printer_for_device_by_bambu_dev_id,
        printer_for_device_by_moonraker_url,
    )

    with SessionLocal() as db:
        device = (
            db.query(AgentDevice)
            .filter(
                AgentDevice.id == device_id,
                AgentDevice.organization_id == org_id,
                AgentDevice.revoked_at.is_(None),
                AgentDevice.paired_at.isnot(None),
                AgentDevice.credential_hash.isnot(None),
            )
            .first()
        )
        if device is None:
            raise AgentMessageRejected("Agent device is no longer active")

        msg_type = data.get("type")
        if msg_type == "STATUS_PUSH":
            url = str(data.get("url") or "")
            if not url or printer_for_device_by_moonraker_url(db, device, url) is None:
                raise AgentMessageRejected("Moonraker printer is not assigned to this agent", close_code=4004)
        elif msg_type == "BAMBU_STATUS_PUSH":
            dev_id = str(data.get("dev_id") or "").strip()
            if not dev_id or printer_for_device_by_bambu_dev_id(db, device, dev_id) is None:
                raise AgentMessageRejected("Bambu printer is not assigned to this agent", close_code=4004)
        elif msg_type in {"TG_BOT_USERNAME", "TG_CLAIM_LINK"}:
            if not device_can_handle_org_services(db, device):
                raise AgentMessageRejected("Org-wide Telegram service requires one unscoped agent", close_code=4004)


async def handle_agent_message(
    data: dict,
    org_id: int = 0,
    *,
    device_id: UUID | None = None,
    scopes: frozenset[str] | None = None,
) -> None:
    """Dispatch an incoming agent message to the waiting caller."""
    msg_type = data.get("type")

    if device_id is not None:
        required_scope = _required_scope_for_message(data)
        if scopes is None or required_scope not in scopes:
            raise AgentMessageRejected(f"Agent message requires {required_scope}")
        await asyncio.to_thread(_authorize_v2_message_target, data, org_id, device_id)

    if msg_type == "AGENT_HELLO":
        _agent_capabilities[org_id] = set(data.get("capabilities") or [])
        log.info("Agent org %s capabilities: %s", org_id, sorted(_agent_capabilities[org_id]))
        return

    if msg_type == "STATUS_PUSH":
        _handle_status_push(data, org_id)
        return

    if msg_type == "BAMBU_STATUS_PUSH":
        _handle_bambu_status_push(data, org_id)
        return

    if msg_type == "TG_BOT_USERNAME":
        await _handle_tg_bot_username(data, org_id)
        return

    if msg_type == "TG_CLAIM_LINK":
        await _handle_tg_claim_link(data, org_id)
        return

    req_id = data.get("id")
    if not req_id:
        return

    msg_type = data.get("type")

    if msg_type == "chunk":
        q = _pending_streams.get(req_id)
        if q:
            raw = data.get("data", "")
            _put_stream_item(q, base64.b64decode(raw) if raw else b"")
        return

    if msg_type == "stream_end":
        q = _pending_streams.get(req_id)
        if q:
            _put_stream_item(q, None)  # sentinel → generator stops
        return

    if msg_type == "stream_start":
        # Nothing to do here — the generator is already waiting on the queue
        return

    if msg_type == "upload_progress":
        callback = _pending_upload_progress.get(req_id)
        if callback:
            result = callback(data)
            if inspect.isawaitable(result):
                await result
        return

    # Regular (non-streaming) response
    future = _pending.get(req_id)
    if future and not future.done():
        future.set_result(data)


async def proxy_request(
    org_id: int,
    method: str,
    url: str,
    body: dict | None = None,
    timeout: float = 8.0,
) -> dict:
    """Send an HTTP request through the agent tunnel, await JSON response."""
    ws = _tunnels.get(org_id)
    if not ws:
        raise RuntimeError(f"No agent connected for org {org_id}")

    req_id = str(uuid.uuid4())
    loop = asyncio.get_event_loop()
    future: asyncio.Future = loop.create_future()
    _pending[req_id] = future
    _pending_org[req_id] = org_id

    try:
        await ws.send_text(json.dumps({"id": req_id, "method": method, "url": url, "body": body}))
        return await asyncio.wait_for(future, timeout=timeout)
    except asyncio.TimeoutError:
        raise RuntimeError(f"Agent timed out ({timeout}s): {method} {url}")
    finally:
        _pending.pop(req_id, None)
        _pending_org.pop(req_id, None)


async def bambu_camera_stream(
    org_id: int,
    ip: str,
    access_code: str,
    chunk_timeout: float = 30.0,
) -> AsyncGenerator[bytes, None]:
    """Stream Bambu A1/P1 camera via native binary protocol through the agent tunnel."""
    ws = _tunnels.get(org_id)
    if not ws:
        raise RuntimeError(f"No agent connected for org {org_id}")

    req_id = str(uuid.uuid4())
    q: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=STREAM_QUEUE_MAX)
    _pending_streams[req_id] = q
    _pending_stream_org[req_id] = org_id

    try:
        await ws.send_text(json.dumps({
            "id": req_id, "method": "BAMBU_CAMERA",
            "ip": ip, "access_code": access_code,
        }))
        while True:
            chunk = await asyncio.wait_for(q.get(), timeout=chunk_timeout)
            if chunk is None:
                break
            yield chunk
    except asyncio.TimeoutError:
        log.warning("Bambu camera stream timed out for org %s ip %s", org_id, ip)
    finally:
        await _cancel_stream(ws, req_id)
        _pending_streams.pop(req_id, None)
        _pending_stream_org.pop(req_id, None)


async def ffmpeg_stream(
    org_id: int,
    rtsps_url: str,
    chunk_timeout: float = 30.0,
) -> AsyncGenerator[bytes, None]:
    """Ask the agent to run FFmpeg locally and stream MJPEG frames back.

    This is the SimplyPrint approach: FFmpeg runs on the agent machine
    (farm PC / Pi) which is on the same LAN as the printer.
    """
    ws = _tunnels.get(org_id)
    if not ws:
        raise RuntimeError(f"No agent connected for org {org_id}")

    req_id = str(uuid.uuid4())
    q: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=STREAM_QUEUE_MAX)
    _pending_streams[req_id] = q
    _pending_stream_org[req_id] = org_id

    try:
        await ws.send_text(json.dumps({
            "id": req_id, "method": "FFMPEG_STREAM", "url": rtsps_url,
        }))
        while True:
            chunk = await asyncio.wait_for(q.get(), timeout=chunk_timeout)
            if chunk is None:
                break
            yield chunk
    except asyncio.TimeoutError:
        log.warning("FFmpeg stream timed out for org %s", org_id)
    finally:
        await _cancel_stream(ws, req_id)
        _pending_streams.pop(req_id, None)
        _pending_stream_org.pop(req_id, None)


async def proxy_stream(
    org_id: int,
    url: str,
    chunk_timeout: float = 30.0,
) -> AsyncGenerator[bytes, None]:
    """Stream a response from the agent tunnel (e.g. MJPEG camera).

    Yields raw bytes chunks as they arrive from the agent.
    """
    ws = _tunnels.get(org_id)
    if not ws:
        raise RuntimeError(f"No agent connected for org {org_id}")

    req_id = str(uuid.uuid4())
    q: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=STREAM_QUEUE_MAX)
    _pending_streams[req_id] = q
    _pending_stream_org[req_id] = org_id

    try:
        await ws.send_text(json.dumps({"id": req_id, "method": "STREAM", "url": url}))
        while True:
            chunk = await asyncio.wait_for(q.get(), timeout=chunk_timeout)
            if chunk is None:
                break
            yield chunk
    except asyncio.TimeoutError:
        log.warning("Stream timed out for org %s url %s", org_id, url)
    finally:
        await _cancel_stream(ws, req_id)
        _pending_streams.pop(req_id, None)
        _pending_stream_org.pop(req_id, None)


# ── File upload helpers ───────────────────────────────────────────────────────


async def send_bambu_upload(
    org_id: int,
    dev_ip: str,
    access_code: str,
    filename: str,
    file_bytes: bytes | None = None,
    presigned_url: str | None = None,
    target_dir: str = "cache",
    timeout: float = 180.0,
    progress_callback: Callable[[dict[str, Any]], Awaitable[None] | None] | None = None,
) -> str:
    """Upload a .3mf to a Bambu printer via the agent's LAN FTPS connection.

    File source: either `presigned_url` (R2 — agent downloads directly, preferred)
    or `file_bytes` (fallback). Exactly one must be provided.

    Returns the remote path on the printer (`cache/x.3mf` from v0.6.0 agents,
    bare filename from older ones). Raises RuntimeError on failure.
    """
    ws = _tunnels.get(org_id)
    if not ws:
        raise RuntimeError(f"No agent connected for org {org_id}")

    payload: dict = {
        "id": "",
        "method": "BAMBU_UPLOAD",
        "ip": dev_ip,
        "access_code": access_code,
        "filename": filename,
        "target_dir": target_dir,
    }
    if presigned_url:
        payload["url"] = presigned_url
    elif file_bytes is not None:
        import base64
        payload["data_b64"] = base64.b64encode(file_bytes).decode()
    else:
        raise RuntimeError("send_bambu_upload: need presigned_url or file_bytes")

    req_id = str(uuid.uuid4())
    payload["id"] = req_id
    loop = asyncio.get_event_loop()
    future: asyncio.Future = loop.create_future()
    _pending[req_id] = future
    _pending_org[req_id] = org_id

    last_activity = time.monotonic()

    async def _on_progress(data: dict[str, Any]) -> None:
        nonlocal last_activity
        if not data.get("heartbeat"):
            last_activity = time.monotonic()
        if progress_callback is not None:
            result = progress_callback(data)
            if inspect.isawaitable(result):
                await result

    _pending_upload_progress[req_id] = _on_progress

    try:
        await ws.send_text(json.dumps(payload))
        started = time.monotonic()
        while True:
            now = time.monotonic()
            if now - started >= timeout:
                raise RuntimeError(f"Agent BAMBU_UPLOAD timed out ({timeout}s) for {dev_ip}")
            if now - last_activity >= UPLOAD_STALL_TIMEOUT:
                raise RuntimeError(
                    f"Agent BAMBU_UPLOAD: {UPLOAD_STALL_TIMEOUT:.0f}s без прогресу для {dev_ip}")
            wait_slice = min(
                _UPLOAD_POLL,
                timeout - (now - started),
                UPLOAD_STALL_TIMEOUT - (now - last_activity),
            )
            done, _ = await asyncio.wait({future}, timeout=wait_slice)
            if done:
                resp = future.result()
                break
    finally:
        _pending.pop(req_id, None)
        _pending_org.pop(req_id, None)
        _pending_upload_progress.pop(req_id, None)

    if resp.get("status", 0) >= 400 or resp.get("error"):
        raise RuntimeError(f"BAMBU_UPLOAD failed: {resp.get('error')}")
    body = resp.get("body") or {}
    return body.get("path") or filename


async def send_bambu_mqtt(
    org_id: int,
    dev_id: str,
    dev_ip: str,
    access_code: str,
    payload: dict,
    timeout: float = 20.0,
) -> dict:
    """Publish one Bambu LAN MQTT command through the local agent."""
    ws = _tunnels.get(org_id)
    if not ws:
        raise RuntimeError(f"No agent connected for org {org_id}")

    req_id = str(uuid.uuid4())
    loop = asyncio.get_event_loop()
    future: asyncio.Future = loop.create_future()
    _pending[req_id] = future
    _pending_org[req_id] = org_id

    try:
        await ws.send_text(json.dumps({
            "id": req_id,
            "method": "BAMBU_MQTT",
            "dev_id": dev_id,
            "ip": dev_ip,
            "access_code": access_code,
            "payload": payload,
        }))
        resp = await asyncio.wait_for(future, timeout=timeout)
    except asyncio.TimeoutError:
        raise RuntimeError(f"Agent BAMBU_MQTT timed out ({timeout}s) for {dev_ip}")
    finally:
        _pending.pop(req_id, None)
        _pending_org.pop(req_id, None)

    if resp.get("status", 0) >= 400 or resp.get("error"):
        raise RuntimeError(f"BAMBU_MQTT failed: {resp.get('error')}")
    return resp.get("body") or {"ok": True}


async def send_moonraker_upload(
    org_id: int,
    moonraker_url: str,
    filename: str,
    file_bytes: bytes,
    start_print: bool = False,
    timeout: float | None = None,
    progress_callback: Callable[[dict[str, Any]], Awaitable[None] | None] | None = None,
    presigned_url: str | None = None,
) -> dict:
    """Upload a gcode/3mf to Moonraker via the agent's LAN connection.

    Bounded by a stall guard, not total time: as long as the agent keeps
    reporting `upload_progress` the transfer may take as long as the printer
    needs. `timeout` (default `UPLOAD_TIMEOUT_MAX`) is only a hard cap.

    Returns Moonraker's response dict.
    Raises RuntimeError on failure.
    """
    import base64
    from app.services.moonraker import (  # noqa: PLC0415
        _api_base, MoonrakerError, UPLOAD_TIMEOUT_MAX, upload_timeout_for_size,
    )
    ws = _tunnels.get(org_id)
    if not ws:
        raise RuntimeError(f"No agent connected for org {org_id}")

    base = _api_base(moonraker_url)
    # Sent to the agent as its per-operation httpx timeout — not a total budget.
    agent_timeout = timeout if timeout is not None else upload_timeout_for_size(len(file_bytes))
    hard_cap = timeout if timeout is not None else UPLOAD_TIMEOUT_MAX
    req_id = str(uuid.uuid4())
    loop = asyncio.get_event_loop()
    future: asyncio.Future = loop.create_future()
    _pending[req_id] = future
    _pending_org[req_id] = org_id

    last_activity = time.monotonic()

    async def _on_progress(data: dict[str, Any]) -> None:
        nonlocal last_activity
        last_activity = time.monotonic()
        if progress_callback is not None:
            result = progress_callback(data)
            if inspect.isawaitable(result):
                await result

    _pending_upload_progress[req_id] = _on_progress

    try:
        payload = {
            "id": req_id,
            "method": "MOONRAKER_UPLOAD",
            "url": base,
            "filename": filename,
            "start_print": start_print,
            "upload_timeout": agent_timeout,
        }
        capabilities = _agent_capabilities.get(org_id, set())
        if presigned_url and "moonraker_upload_url" in capabilities:
            # Fastest path: the agent downloads straight from R2 at its own ISP
            # speed — no base64 chunk relay through the cloud WebSocket.
            payload.update({"download_url": presigned_url, "total_bytes": len(file_bytes)})
            await ws.send_text(json.dumps(payload))
        elif "moonraker_upload_chunks" in capabilities:
            payload.update({"chunked": True, "total_bytes": len(file_bytes)})
            await ws.send_text(json.dumps(payload))
            chunk_size = 1024 * 1024  # agent connects with max_size=None
            offsets = range(0, len(file_bytes), chunk_size) or (0,)
            for offset in offsets:
                chunk = file_bytes[offset:offset + chunk_size]
                await ws.send_text(json.dumps({
                    "id": req_id,
                    "method": "MOONRAKER_UPLOAD_CHUNK",
                    "offset": offset,
                    "final": offset + len(chunk) >= len(file_bytes),
                    "data_b64": base64.b64encode(chunk).decode(),
                }))
                last_activity = time.monotonic()  # cloud→agent transfer is activity too
        else:
            # Keep old agents working until they receive the chunk-capable build.
            payload["data_b64"] = base64.b64encode(file_bytes).decode()
            await ws.send_text(json.dumps(payload))

        started = time.monotonic()
        while True:
            now = time.monotonic()
            if now - started >= hard_cap:
                raise RuntimeError(
                    f"Agent MOONRAKER_UPLOAD timed out ({hard_cap:.0f}s hard cap) for {moonraker_url}")
            if now - last_activity >= UPLOAD_STALL_TIMEOUT:
                raise RuntimeError(
                    f"Agent MOONRAKER_UPLOAD: {UPLOAD_STALL_TIMEOUT:.0f}s без прогресу для {moonraker_url}")
            wait_slice = min(
                _UPLOAD_POLL,
                hard_cap - (now - started),
                UPLOAD_STALL_TIMEOUT - (now - last_activity),
            )
            done, _ = await asyncio.wait({future}, timeout=wait_slice)
            if done:
                resp = future.result()
                break
    finally:
        _pending.pop(req_id, None)
        _pending_org.pop(req_id, None)
        _pending_upload_progress.pop(req_id, None)

    if resp.get("status", 0) >= 400 or resp.get("error"):
        raise MoonrakerError(f"Agent upload failed ({resp.get('status')}): {resp.get('error')}")
    return resp.get("body") or {}


# ── Moonraker helpers ─────────────────────────────────────────────────────────

async def get_moonraker_status(org_id: int, moonraker_url: str) -> dict:
    """Fetch and cache Moonraker live status via the tunnel."""
    from app.services.moonraker import (
        _api_base, _parse_moonraker_status,
        LIVE_STATUS_OBJECTS, STATUS_CACHE_TTL, _status_cache,
    )

    now = time.monotonic()
    cache_key = _moonraker_cache_key(org_id, moonraker_url)
    cached = _status_cache.get(cache_key)
    if isinstance(cached, tuple) and len(cached) == 2:
        cached_at, cached_status = cached
        if isinstance(cached_at, (int, float)) and isinstance(cached_status, dict):
            if now - cached_at < STATUS_CACHE_TTL:
                return cached_status
    elif isinstance(cached, dict):
        return cached

    base = _api_base(moonraker_url)
    try:
        resp = await proxy_request(org_id, "GET", f"{base}/printer/objects/query?{LIVE_STATUS_OBJECTS}")
        if resp.get("status", 0) >= 400 or not resp.get("body"):
            raise RuntimeError(f"bad status {resp.get('status')}")
        raw = resp["body"].get("result", {}).get("status", {})
        status = _parse_moonraker_status(raw)
    except Exception as e:
        log.debug("Tunnel Moonraker status failed %s: %s", moonraker_url, e)
        status = cached[1] if cached else {"state": "offline"}

    _status_cache[cache_key] = (now, status)
    return status


async def moonraker_action(
    org_id: int,
    moonraker_url: str,
    path: str,
    body: dict | None = None,
    timeout: float = 30.0,
) -> dict:
    """Send a Moonraker POST action through the tunnel."""
    from app.services.moonraker import _api_base, MoonrakerError
    base = _api_base(moonraker_url)
    resp = await proxy_request(org_id, "POST", f"{base}{path}", body=body, timeout=timeout)
    if resp.get("status", 200) >= 400:
        raise MoonrakerError(f"Agent proxy {resp.get('status')}: {resp.get('error', '')}")
    return resp.get("body") or {}
