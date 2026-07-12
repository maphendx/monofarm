"""WebSocket endpoint for monofarm-agent connections.

Agents connect from the client's local network, authenticate with a JWT,
and then serve as HTTP proxies for Moonraker (and other local services).
"""
import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.api.deps import get_current_org, require_roles
from app.core.security import decode_token
from app.models.organization import Organization
from app.models.user import User, UserRole
from app.services import tunnel

log = logging.getLogger(__name__)

router = APIRouter(tags=["agent"])

AGENT_VERSION = "0.8.9"


@router.get("/api/agent/version")
def agent_version() -> dict:
    """Current agent version — checked by the agent at startup for auto-update.

    `build` exposes the deployed git SHA (Railway env) so "is my fix live yet?"
    is answerable with one curl; agents ignore the extra key.
    """
    import os
    build = (os.environ.get("RAILWAY_GIT_COMMIT_SHA") or "")[:7]
    return {"version": AGENT_VERSION, "build": build or None}


@router.get("/api/agent/status")
def agent_status(org: Organization = Depends(get_current_org)) -> dict:
    """Check whether a local agent is connected for this org."""
    return {"connected": tunnel.has_tunnel(org.id)}


@router.get("/api/agent/logs")
async def agent_logs(
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin)),
) -> dict:
    """Recent log lines from the connected farm agent (remote diagnostics)."""
    if not tunnel.has_tunnel(org.id):
        raise HTTPException(status_code=503, detail="Агент не підключений")
    result = await tunnel.proxy_request(org.id, method="AGENT_LOGS", url="", timeout=10)
    if result.get("status") != 200:
        raise HTTPException(status_code=502, detail=result.get("error") or "Агент не відповів")
    body = result.get("body") or {}
    return {"version": body.get("version"), "lines": body.get("lines") or []}


@router.get("/api/agent/bambu-lan-config")
def bambu_lan_config(org: Organization = Depends(get_current_org)) -> dict:
    """LAN-only Bambu printers the local agent should monitor.

    This endpoint is consumed by monofarm-agent, not browser UI. The agent needs
    each printer's LAN access code to subscribe to local MQTT and push live
    reports back through the existing WebSocket tunnel.
    """
    from app.core.db import SessionLocal
    from app.models.printer import Printer, PrinterKind

    with SessionLocal() as db:
        rows = (
            db.query(Printer)
            .filter(
                Printer.organization_id == org.id,
                Printer.kind == PrinterKind.bambu,
                Printer.bambu_lan_mode.is_(True),
                Printer.is_active.is_(True),
                Printer.bambu_dev_id.isnot(None),
                Printer.bambu_dev_ip.isnot(None),
                Printer.bambu_access_code.isnot(None),
            )
            .all()
        )
        printers = [
            {
                "id": row.id,
                "name": row.name,
                "dev_id": row.bambu_dev_id,
                "ip": row.bambu_dev_ip,
                "access_code": row.bambu_access_code,
            }
            for row in rows
            if row.bambu_dev_id and row.bambu_dev_ip and row.bambu_access_code
        ]
    return {"printers": printers}


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
        await tunnel.unregister(org_id, ws)
