"""WebSocket endpoint for monofarm-agent connections.

Agents connect from the client's local network, authenticate with a JWT,
and then serve as HTTP proxies for Moonraker (and other local services).
"""
import json
import logging

from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect

from app.api.deps import get_current_org
from app.core.security import decode_token
from app.models.organization import Organization
from app.services import tunnel

log = logging.getLogger(__name__)

router = APIRouter(tags=["agent"])

AGENT_VERSION = "0.4.7"


@router.get("/api/agent/version")
def agent_version() -> dict:
    """Current agent version — checked by the agent at startup for auto-update."""
    return {"version": AGENT_VERSION}


@router.get("/api/agent/status")
def agent_status(org: Organization = Depends(get_current_org)) -> dict:
    """Check whether a local agent is connected for this org."""
    return {"connected": tunnel.has_tunnel(org.id)}


@router.websocket("/api/agent/connect")
async def agent_connect(
    ws: WebSocket,
    token: str = Query(..., description="User JWT token for authentication"),
) -> None:
    """monofarm-agent connects here and serves as a local HTTP proxy tunnel."""
    payload = decode_token(token)
    if not payload:
        await ws.close(code=4001, reason="Invalid token")
        return

    org_id = payload.get("org_id")
    if not org_id:
        await ws.close(code=4002, reason="Token missing org_id")
        return

    org_id = int(org_id)
    await ws.accept()
    await tunnel.register(org_id, ws)

    try:
        while True:
            raw = await ws.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                log.warning("Agent org %s sent invalid JSON", org_id)
                continue
            await tunnel.handle_agent_message(data, org_id=org_id)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.warning("Agent org %s connection error: %s", org_id, e)
    finally:
        await tunnel.unregister(org_id)
