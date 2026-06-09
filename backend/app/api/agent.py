"""WebSocket endpoint for monofarm-agent connections.

Agents connect from the client's local network, authenticate with a JWT,
and then serve as HTTP proxies for Moonraker (and other local services).
"""
import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.api.deps import get_current_org
from app.core.security import decode_token
from app.models.organization import Organization
from app.services import tunnel

log = logging.getLogger(__name__)

router = APIRouter(tags=["agent"])

AGENT_VERSION = "0.5.0"


@router.get("/api/agent/version")
def agent_version() -> dict:
    """Current agent version — checked by the agent at startup for auto-update."""
    return {"version": AGENT_VERSION}


@router.get("/api/agent/status")
def agent_status(org: Organization = Depends(get_current_org)) -> dict:
    """Check whether a local agent is connected for this org."""
    return {"connected": tunnel.has_tunnel(org.id)}


class PrintZplRequest(BaseModel):
    ip:   str
    port: int = 9100
    zpl:  str


@router.post("/api/agent/print-zpl")
async def agent_print_zpl(
    payload: PrintZplRequest,
    org: Organization = Depends(get_current_org),
) -> dict:
    """Send ZPL to a network printer via the local farm agent (raw TCP)."""
    if not tunnel.has_tunnel(org.id):
        raise HTTPException(status_code=503, detail="Агент не підключений")
    result = await tunnel.proxy_request(
        org.id,
        method="PRINT_ZPL",
        url="",
        body={"ip": payload.ip, "port": payload.port, "zpl": payload.zpl},
        timeout=10,
    )
    if result.get("status") != 200:
        raise HTTPException(status_code=502, detail=result.get("error") or "Помилка друку")
    return {"ok": True}


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
