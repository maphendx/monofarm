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

from fastapi import WebSocket

from app.models.bambu_cloud_job import BambuCloudJobStatus

log = logging.getLogger(__name__)

# org_id → active WebSocket
_tunnels: dict[int, WebSocket] = {}
# request_id → Future  (regular request/response)
_pending: dict[str, asyncio.Future] = {}
_pending_upload_progress: dict[str, Callable[[dict[str, Any]], Awaitable[None] | None]] = {}
# request_id → Queue  (streaming)
_pending_streams: dict[str, asyncio.Queue] = {}


def has_tunnel(org_id: int) -> bool:
    return org_id in _tunnels


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


async def register(org_id: int, ws: WebSocket) -> None:
    if org_id in _tunnels:
        log.info("Agent reconnected for org %s — replacing old connection", org_id)
    _tunnels[org_id] = ws
    log.info("Agent connected for org %s (total: %s)", org_id, len(_tunnels))
    asyncio.create_task(_subscribe_org_printers(org_id))
    asyncio.create_task(_backfill_org_history(org_id))


async def _subscribe_org_printers(org_id: int) -> None:
    """Send MOONRAKER_SUBSCRIBE for every active Moonraker printer in the org."""
    await asyncio.sleep(0.5)  # let the agent finish its own setup first
    ws = _tunnels.get(org_id)
    if not ws:
        return
    from app.core.db import SessionLocal
    from app.models.printer import Printer
    with SessionLocal() as db:
        printers = (
            db.query(Printer)
            .filter_by(organization_id=org_id, is_active=True)
            .filter(Printer.moonraker_url.isnot(None))
            .all()
        )
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
            }))
            log.debug("Sent MOONRAKER_SUBSCRIBE for %s (org %s)", p.moonraker_url, org_id)
        except Exception as e:
            log.debug("_subscribe_org_printers: send failed for %s: %s", p.moonraker_url, e)
            break


async def _backfill_org_history(org_id: int) -> None:
    """Backfill Moonraker print history for all printers when the agent connects."""
    await asyncio.sleep(3)  # let subscriptions settle first
    try:
        from app.core.db import SessionLocal
        from app.models.printer import Printer
        from app.services.print_tracker import backfill_moonraker_history

        with SessionLocal() as db:
            printers = (
                db.query(Printer)
                .filter_by(organization_id=org_id, is_active=True)
                .filter(Printer.moonraker_url.isnot(None))
                .all()
            )
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


async def unregister(org_id: int) -> None:
    _tunnels.pop(org_id, None)
    # Fail any futures that were waiting for a response from this agent
    for req_id, fut in list(_pending.items()):
        if not fut.done():
            fut.set_exception(RuntimeError(f"Agent disconnected (org {org_id})"))
    _pending_upload_progress.clear()
    log.info("Agent disconnected for org %s (total: %s)", org_id, len(_tunnels))


async def _handle_tg_bot_username(data: dict) -> None:
    """Agent reported its bot username after a successful getMe."""
    org_id   = data.get("org_id")
    username = (data.get("username") or "").strip()
    if not org_id or not username:
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
        user = db.query(User).filter(User.telegram_link_code == code).first()
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


def _handle_status_push(data: dict) -> None:
    """Cache a Moonraker status pushed by the agent's WS subscription."""
    url = data.get("url") or ""
    raw = data.get("status") or {}
    if not url or not raw:
        return
    from app.services.moonraker import _parse_moonraker_status, _status_cache, STATUS_CACHE_TTL
    from app.services.cache import cache_set
    status = _parse_moonraker_status(raw)
    # _status_cache is shared with moonraker module; tunnel path expects (timestamp, status)
    _status_cache[url] = (time.monotonic(), status)
    # Redis path used by moonraker.get_live_status (fresh + stale keys)
    cache_set(f"mr:status:{url}", status, int(STATUS_CACHE_TTL))
    cache_set(f"mr:stale:{url}", status, int(STATUS_CACHE_TTL * 10))
    log.debug("STATUS_PUSH: cached %s state=%s", url, status.get("state"))


_autoprint_idle_kicks: dict[str, float] = {}


def _handle_bambu_status_push(data: dict, org_id: int) -> None:
    """Cache a Bambu LAN MQTT report pushed by the agent."""
    dev_id = (data.get("dev_id") or "").strip()
    payload = data.get("payload") or {}
    if not dev_id or not isinstance(payload, dict):
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


async def handle_agent_message(data: dict, org_id: int = 0) -> None:
    """Dispatch an incoming agent message to the waiting caller."""
    msg_type = data.get("type")

    if msg_type == "STATUS_PUSH":
        _handle_status_push(data)
        return

    if msg_type == "BAMBU_STATUS_PUSH":
        _handle_bambu_status_push(data, org_id)
        return

    if msg_type == "TG_BOT_USERNAME":
        await _handle_tg_bot_username({**data, "org_id": data.get("org_id") or org_id})
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
            q.put_nowait(base64.b64decode(raw) if raw else b"")
        return

    if msg_type == "stream_end":
        q = _pending_streams.get(req_id)
        if q:
            q.put_nowait(None)  # sentinel → generator stops
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

    try:
        await ws.send_text(json.dumps({"id": req_id, "method": method, "url": url, "body": body}))
        return await asyncio.wait_for(future, timeout=timeout)
    except asyncio.TimeoutError:
        raise RuntimeError(f"Agent timed out ({timeout}s): {method} {url}")
    finally:
        _pending.pop(req_id, None)


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
    q: asyncio.Queue[bytes | None] = asyncio.Queue()
    _pending_streams[req_id] = q

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
        _pending_streams.pop(req_id, None)


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
    q: asyncio.Queue[bytes | None] = asyncio.Queue()
    _pending_streams[req_id] = q

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
        _pending_streams.pop(req_id, None)


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
    q: asyncio.Queue[bytes | None] = asyncio.Queue()
    _pending_streams[req_id] = q

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
        _pending_streams.pop(req_id, None)


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

    try:
        await ws.send_text(json.dumps(payload))
        resp = await asyncio.wait_for(future, timeout=timeout)
    except asyncio.TimeoutError:
        raise RuntimeError(f"Agent BAMBU_UPLOAD timed out ({timeout}s) for {dev_ip}")
    finally:
        _pending.pop(req_id, None)

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
) -> dict:
    """Upload a gcode/3mf to Moonraker via the agent's LAN connection.

    Returns Moonraker's response dict.
    Raises RuntimeError on failure.
    """
    import base64
    from app.services.moonraker import _api_base, MoonrakerError, upload_timeout_for_size  # noqa: PLC0415
    ws = _tunnels.get(org_id)
    if not ws:
        raise RuntimeError(f"No agent connected for org {org_id}")

    base = _api_base(moonraker_url)
    effective_timeout = timeout if timeout is not None else upload_timeout_for_size(len(file_bytes))
    req_id = str(uuid.uuid4())
    loop = asyncio.get_event_loop()
    future: asyncio.Future = loop.create_future()
    _pending[req_id] = future
    if progress_callback is not None:
        _pending_upload_progress[req_id] = progress_callback

    try:
        await ws.send_text(json.dumps({
            "id": req_id,
            "method": "MOONRAKER_UPLOAD",
            "url": base,
            "filename": filename,
            "start_print": start_print,
            "upload_timeout": effective_timeout,
            "chunked": True,
            "total_bytes": len(file_bytes),
        }))
        chunk_size = 256 * 1024
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
        resp = await asyncio.wait_for(future, timeout=effective_timeout)
    except asyncio.TimeoutError:
        raise RuntimeError(f"Agent MOONRAKER_UPLOAD timed out ({effective_timeout}s) for {moonraker_url}")
    finally:
        _pending.pop(req_id, None)
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
    cached = _status_cache.get(moonraker_url)
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

    _status_cache[moonraker_url] = (now, status)
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
