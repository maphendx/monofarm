"""WebSocket tunnel manager for monofarm-agent connections.

Each organization can have one active agent connection.
The agent runs on the client's local network and proxies HTTP requests
to Moonraker (or other local services) on behalf of the cloud server.

Wire protocol (JSON over WebSocket):
  Server → Agent: {"id": "<uuid>", "method": "GET", "url": "http://...", "body": null}
  Agent → Server: {"id": "<uuid>", "status": 200, "body": {...}, "error": null}
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid

from fastapi import WebSocket

log = logging.getLogger(__name__)

# org_id → active WebSocket
_tunnels: dict[int, WebSocket] = {}
# request_id → Future (pending response)
_pending: dict[str, asyncio.Future] = {}


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
    """Called when the agent sends a response back to the server."""
    req_id = data.get("id")
    if not req_id:
        return
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
    """Send an HTTP request through the agent tunnel and wait for the response."""
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


_MOONRAKER_ACTION_PATHS: dict = {}  # populated lazily below


async def moonraker_action(org_id: int, moonraker_url: str, path: str, body: dict | None = None) -> dict:
    """Send a Moonraker POST action through the tunnel."""
    from app.services.moonraker import _api_base, MoonrakerError
    base = _api_base(moonraker_url)
    resp = await proxy_request(org_id, "POST", f"{base}{path}", body=body)
    if resp.get("status", 200) >= 400:
        raise MoonrakerError(f"Agent proxy {resp.get('status')}: {resp.get('error', '')}")
    return resp.get("body") or {}
