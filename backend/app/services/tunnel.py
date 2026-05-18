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
import json
import logging
import time
import uuid
from collections.abc import AsyncGenerator

from fastapi import WebSocket

log = logging.getLogger(__name__)

# org_id → active WebSocket
_tunnels: dict[int, WebSocket] = {}
# request_id → Future  (regular request/response)
_pending: dict[str, asyncio.Future] = {}
# request_id → Queue  (streaming)
_pending_streams: dict[str, asyncio.Queue] = {}


def has_tunnel(org_id: int) -> bool:
    return org_id in _tunnels


async def register(org_id: int, ws: WebSocket) -> None:
    if org_id in _tunnels:
        log.info("Agent reconnected for org %s — replacing old connection", org_id)
    _tunnels[org_id] = ws
    log.info("Agent connected for org %s (total: %s)", org_id, len(_tunnels))


async def unregister(org_id: int) -> None:
    _tunnels.pop(org_id, None)
    log.info("Agent disconnected for org %s (total: %s)", org_id, len(_tunnels))


async def handle_agent_message(data: dict) -> None:
    """Dispatch an incoming agent message to the waiting caller."""
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
    timeout: float = 120.0,
) -> str:
    """Upload a .3mf to a Bambu printer via the agent's LAN FTPS connection.

    File source: either `presigned_url` (R2 — agent downloads directly, preferred)
    or `file_bytes` (fallback). Exactly one must be provided.

    Returns the filename on the printer.  Raises RuntimeError on failure.
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
    return filename


async def send_moonraker_upload(
    org_id: int,
    moonraker_url: str,
    filename: str,
    file_bytes: bytes,
    start_print: bool = False,
    timeout: float = 120.0,
) -> dict:
    """Upload a gcode/3mf to Moonraker via the agent's LAN connection.

    Returns Moonraker's response dict.
    Raises RuntimeError on failure.
    """
    import base64
    from app.services.moonraker import _api_base, MoonrakerError  # noqa: PLC0415
    ws = _tunnels.get(org_id)
    if not ws:
        raise RuntimeError(f"No agent connected for org {org_id}")

    base = _api_base(moonraker_url)
    req_id = str(uuid.uuid4())
    loop = asyncio.get_event_loop()
    future: asyncio.Future = loop.create_future()
    _pending[req_id] = future

    try:
        await ws.send_text(json.dumps({
            "id": req_id,
            "method": "MOONRAKER_UPLOAD",
            "url": base,
            "filename": filename,
            "data_b64": base64.b64encode(file_bytes).decode(),
            "start_print": start_print,
        }))
        resp = await asyncio.wait_for(future, timeout=timeout)
    except asyncio.TimeoutError:
        raise RuntimeError(f"Agent MOONRAKER_UPLOAD timed out ({timeout}s) for {moonraker_url}")
    finally:
        _pending.pop(req_id, None)

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
    if cached and now - cached[0] < STATUS_CACHE_TTL:
        return cached[1]

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


async def moonraker_action(org_id: int, moonraker_url: str, path: str, body: dict | None = None) -> dict:
    """Send a Moonraker POST action through the tunnel."""
    from app.services.moonraker import _api_base, MoonrakerError
    base = _api_base(moonraker_url)
    resp = await proxy_request(org_id, "POST", f"{base}{path}", body=body)
    if resp.get("status", 200) >= 400:
        raise MoonrakerError(f"Agent proxy {resp.get('status')}: {resp.get('error', '')}")
    return resp.get("body") or {}
