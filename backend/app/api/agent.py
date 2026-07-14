"""WebSocket endpoint for monofarm-agent connections.

Agents connect from the client's local network, authenticate with a JWT,
and then serve as HTTP proxies for Moonraker (and other local services).
"""
import asyncio
import ipaddress
import json
import logging
import os
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager, suppress
from datetime import datetime, timezone
from urllib.parse import urlsplit
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles
from app.core.config import settings
from app.core.agent_release_trust import resolve_agent_release_public_key
from app.core.db import SessionLocal, get_db
from app.core.security import decode_token
from app.models.agent import AgentDevice
from app.models.organization import Organization
from app.models.printer import Printer, PrinterKind
from app.models.user import User, UserRole
from app.schemas.agent import AgentRuntimeConfigOut, PrintZplRequest
from app.services.agent_auth import (
    AgentPrincipal,
    decode_agent_access_token,
    require_agent_principal,
    resolve_agent_access_token,
)
from app.services.agent_routing import printer_query_for_device
from app.services.agent_updates import (
    VerifiedWindowsRelease,
    release_manifest_object_key,
    release_source_object_key,
    verify_ci_release_manifest,
    verify_windows_release_attestation,
    windows_release_object_key,
)
from app.services import tunnel
from app.services import storage

log = logging.getLogger(__name__)

router = APIRouter(tags=["agent"])

AGENT_VERSION = "0.9.1"

# Protocol migration boundary: installed v1 agents keep their user-JWT route.
# New clients must use the scoped device credential on V2_AGENT_WS_PATH. Remove
# LEGACY_AGENT_WS_PATH only after the installed v1 fleet has migrated.
LEGACY_AGENT_WS_PATH = "/api/agent/connect"
V2_AGENT_WS_PATH = "/api/agent/v2/connect"
AGENT_CREDENTIAL_WATCHDOG_INTERVAL_SECONDS = 20

_ZPL_PRIVATE_NETWORKS = (
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("fc00::/7"),
)

_AGENT_SOURCE_FILES = {
    "monofarm_agent.py",
    "monofarm_tray.py",
    "command_worker.py",
    "command_runtime.py",
    "device_identity.py",
    "network_policy.py",
    "printer_runtime.py",
    "provider_adapters.py",
    "update_policy.py",
    "requirements.txt",
    "edge_runtime/__init__.py",
    "edge_runtime/adapters.py",
    "edge_runtime/artifact_spool.py",
    "edge_runtime/journal.py",
    "edge_runtime/registry.py",
    "edge_runtime/transfer.py",
}


def _release_public_key() -> str | None:
    try:
        return resolve_agent_release_public_key(
            settings.AGENT_RELEASE_ATTESTATION_PUBLIC_KEY
        )
    except ValueError as exc:
        log.error("Agent release trust configuration rejected: %s", exc)
        return None


def _verified_windows_release() -> VerifiedWindowsRelease | None:
    """Resolve the exact Windows release only after CI attestation verifies."""

    public_key = _release_public_key()
    if not public_key:
        return None
    try:
        object_key = windows_release_object_key(AGENT_VERSION)
        head = storage.head_raw_object(object_key)
        if head is None:
            return None
        return verify_windows_release_attestation(
            object_key=head["key"],
            content_length=head["size"],
            metadata=head["metadata"],
            expected_version=AGENT_VERSION,
            public_key_b64=public_key,
        )
    except ValueError as exc:
        log.warning("Windows agent release attestation rejected: %s", exc)
        return None


def _verified_release_manifest() -> dict | None:
    """Load and verify the immutable CI manifest for the API agent version."""

    public_key = _release_public_key()
    base_url = settings.AGENT_UPDATE_BASE_URL.strip().rstrip("/")
    if not public_key or not base_url:
        return None
    windows_release = _verified_windows_release()
    if windows_release is None:
        return None
    try:
        raw = storage.get_raw_object_bytes(
            release_manifest_object_key(AGENT_VERSION),
            2 * 1024 * 1024,
        )
        manifest = json.loads(raw.decode("utf-8"))
        verified = verify_ci_release_manifest(
            manifest,
            expected_version=AGENT_VERSION,
            base_url=base_url,
            public_key_b64=public_key,
            source_files=_AGENT_SOURCE_FILES,
            windows_release=windows_release,
        )
        for filename in sorted(_AGENT_SOURCE_FILES):
            artifact = verified["artifacts"][f"source-{filename}"]
            head = storage.head_raw_object(
                release_source_object_key(AGENT_VERSION, filename)
            )
            if (
                head is None
                or head["size"] != artifact["size"]
                or head["metadata"].get("sha256") != artifact["sha256"]
                or head["metadata"].get("version") != AGENT_VERSION
            ):
                raise ValueError(f"source release object does not match: {filename}")
        return verified
    except (FileNotFoundError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        log.warning("CI agent release manifest rejected: %s", exc)
        return None


def agent_release_download_url(version: str, artifact_name: str) -> str | None:
    """Presign only an artifact present in the verified immutable CI release."""

    if version != AGENT_VERSION:
        return None
    manifest = _verified_release_manifest()
    if manifest is None or artifact_name not in manifest["artifacts"]:
        return None
    if artifact_name == "windows-x86_64":
        object_key = windows_release_object_key(version)
    elif artifact_name.startswith("source-"):
        filename = artifact_name.removeprefix("source-")
        if filename not in _AGENT_SOURCE_FILES:
            return None
        object_key = release_source_object_key(version, filename)
    else:
        return None
    return storage.presigned_url_raw(object_key)


def agent_windows_download_url() -> str | None:
    """Presign only the immutable key covered by a valid CI attestation."""

    return agent_release_download_url(AGENT_VERSION, "windows-x86_64")


@router.get("/api/agent/version")
def agent_version() -> dict:
    """Current agent version — checked by the agent at startup for auto-update.

    `build` exposes the deployed git SHA (Railway env) so "is my fix live yet?"
    is answerable with one curl; agents ignore the extra key.
    """
    build = (os.environ.get("RAILWAY_GIT_COMMIT_SHA") or "")[:7]
    response = {
        "version": AGENT_VERSION,
        "build": build or None,
        "manifest": None,
        "update_public_key": None,
    }
    public_key = _release_public_key()
    base_url = settings.AGENT_UPDATE_BASE_URL.strip().rstrip("/")
    if not public_key or not base_url:
        return response

    response["manifest"] = _verified_release_manifest()
    if response["manifest"] is not None:
        response["update_public_key"] = public_key
    return response


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


@router.get("/api/agent/v2/runtime-config", response_model=AgentRuntimeConfigOut)
def agent_runtime_config(
    db: Session = Depends(get_db),
    principal: AgentPrincipal = Depends(require_agent_principal("status:write")),
) -> AgentRuntimeConfigOut:
    """Return only local transports assigned to the authenticated agent's org."""
    rows = (
        printer_query_for_device(db, principal.device)
        .filter(
            Printer.is_active.is_(True),
        )
        .order_by(Printer.sort_order.asc(), Printer.id.asc())
        .all()
    )
    printers: list[dict] = []
    for row in rows:
        if row.kind in {PrinterKind.snapmaker_u1, PrinterKind.other} and row.moonraker_url:
            printers.append(
                {
                    "transport": "moonraker",
                    "id": row.id,
                    "name": row.name,
                    "kind": row.kind.value,
                    "moonraker_url": row.moonraker_url,
                }
            )
            continue
        if (
            row.kind == PrinterKind.bambu
            and row.bambu_lan_mode
            and row.bambu_dev_id
            and row.bambu_dev_ip
            and row.bambu_access_code
        ):
            printers.append(
                {
                    "transport": "bambu_lan",
                    "id": row.id,
                    "name": row.name,
                    "kind": "bambu",
                    "dev_id": row.bambu_dev_id,
                    "ip": row.bambu_dev_ip,
                    "access_code": row.bambu_access_code,
                    "model": row.bambu_model,
                }
            )
    return AgentRuntimeConfigOut(
        device_id=principal.device.id,
        organization_id=principal.organization.id,
        artifact_hosts=_configured_artifact_hosts(),
        printers=printers,
    )


def _configured_artifact_hosts() -> list[str]:
    """Build the edge download allowlist exclusively from trusted server settings."""
    hosts: list[str] = []
    for raw_url in (
        settings.FARM_PUBLIC_URL,
        settings.AGENT_UPDATE_BASE_URL,
        settings.S3_ENDPOINT_URL,
    ):
        parsed = urlsplit(raw_url.strip())
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            continue
        hostname = parsed.hostname.lower().rstrip(".")
        if hostname and hostname not in hosts:
            hosts.append(hostname)
    return hosts


def _zpl_target_is_allowed(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return any(ip in network for network in _ZPL_PRIVATE_NETWORKS if ip.version == network.version)


@router.post("/api/agent/print-zpl")
async def agent_print_zpl(
    payload: PrintZplRequest,
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin)),
) -> dict:
    """Send ZPL to a network printer via the local farm agent (raw TCP)."""
    if not _zpl_target_is_allowed(payload.ip):
        raise HTTPException(status_code=400, detail="ZPL target must be a private LAN IP address")
    if not tunnel.has_tunnel(org.id):
        raise HTTPException(status_code=503, detail="Агент не підключений")
    result = await tunnel.proxy_request(
        org.id,
        method="PRINT_ZPL",
        url="",
        body={"ip": str(payload.ip), "port": payload.port, "zpl": payload.zpl},
        timeout=10,
    )
    if result.get("status") != 200:
        raise HTTPException(status_code=502, detail=result.get("error") or "Помилка друку")
    return {"ok": True}


async def _serve_agent_socket(
    ws: WebSocket,
    org_id: int,
    *,
    device_id: UUID | None = None,
    scopes: frozenset[str] | None = None,
    on_message: Callable[[dict], None] | None = None,
    credential_watchdog: Callable[[], Awaitable[None]] | None = None,
) -> None:
    await ws.accept()
    if not await tunnel.register(org_id, ws, device_id=device_id):
        await ws.close(code=4009, reason="Another farm agent is already connected")
        return
    watchdog_task = asyncio.create_task(credential_watchdog()) if credential_watchdog else None

    try:
        while True:
            raw = await ws.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                log.warning("Agent org %s sent invalid JSON", org_id)
                continue
            await tunnel.handle_agent_message(
                data,
                org_id=org_id,
                device_id=device_id,
                scopes=scopes,
            )
            if on_message is not None:
                on_message(data)
    except WebSocketDisconnect:
        pass
    except tunnel.AgentMessageRejected as exc:
        await ws.close(code=exc.close_code, reason=str(exc))
    except Exception as exc:
        log.warning("Agent org %s connection error: %s", org_id, exc)
    finally:
        if watchdog_task is not None:
            watchdog_task.cancel()
            with suppress(asyncio.CancelledError):
                await watchdog_task
        await tunnel.unregister(org_id, ws)


@contextmanager
def _fresh_agent_session() -> Iterator[Session]:
    """Open a short-lived session for WebSocket callbacks and guards."""
    with SessionLocal() as db:
        yield db


def _agent_credential_is_current(
    *,
    device_id: UUID,
    organization_id: int,
    credential_version: int,
) -> bool:
    with _fresh_agent_session() as db:
        current = (
            db.query(AgentDevice.id)
            .filter(
                AgentDevice.id == device_id,
                AgentDevice.organization_id == organization_id,
                AgentDevice.credential_version == credential_version,
                AgentDevice.revoked_at.is_(None),
                AgentDevice.paired_at.isnot(None),
                AgentDevice.credential_hash.isnot(None),
            )
            .first()
        )
    return current is not None


def _org_has_paired_agent_device(organization_id: int) -> bool:
    """Return whether legacy user-JWT control must be disabled for the org."""
    with _fresh_agent_session() as db:
        paired = (
            db.query(AgentDevice.id)
            .filter(
                AgentDevice.organization_id == organization_id,
                AgentDevice.revoked_at.is_(None),
                AgentDevice.paired_at.isnot(None),
                AgentDevice.credential_hash.isnot(None),
            )
            .first()
        )
    return paired is not None


def _legacy_agent_user_is_current(payload: dict) -> bool:
    try:
        user_id = int(payload.get("sub"))
        organization_id = int(payload.get("org_id"))
    except (TypeError, ValueError):
        return False
    with _fresh_agent_session() as db:
        current = (
            db.query(User.id)
            .filter(
                User.id == user_id,
                User.organization_id == organization_id,
                User.role == UserRole.admin,
                User.is_active.is_(True),
            )
            .first()
        )
    return current is not None


async def _watch_agent_credential(
    ws: WebSocket,
    *,
    device_id: UUID,
    organization_id: int,
    credential_version: int,
) -> None:
    """Close a connected v2 socket no later than one watchdog interval after revocation."""
    while True:
        await asyncio.sleep(AGENT_CREDENTIAL_WATCHDOG_INTERVAL_SECONDS)
        try:
            if _agent_credential_is_current(
                device_id=device_id,
                organization_id=organization_id,
                credential_version=credential_version,
            ):
                continue
        except Exception as exc:
            log.warning("Agent credential watchdog failed for device %s: %s", device_id, exc)
            await ws.close(code=1011, reason="Unable to validate agent credential")
            return
        await ws.close(code=4003, reason="Agent credential revoked")
        return


def _persist_agent_hello(
    *,
    device_id: UUID,
    organization_id: int,
    data: dict,
) -> None:
    if data.get("type") != "AGENT_HELLO":
        return
    with _fresh_agent_session() as db:
        current = (
            db.query(AgentDevice)
            .filter(
                AgentDevice.id == device_id,
                AgentDevice.organization_id == organization_id,
                AgentDevice.revoked_at.is_(None),
            )
            .first()
        )
        if current is None:
            return
        current.version = str(data.get("version") or "")[:32] or None
        current.build = str(data.get("build") or "")[:64] or None
        current.capabilities = [str(item)[:128] for item in (data.get("capabilities") or [])[:64]]
        current.last_seen_at = datetime.now(timezone.utc)
        db.commit()


@router.websocket(LEGACY_AGENT_WS_PATH)
async def agent_connect(
    ws: WebSocket,
    token: str = Query(..., description="User JWT token for authentication"),
) -> None:
    """Deprecated protocol-v1 connection using a regular user JWT."""
    payload = decode_token(token)
    if not payload:
        await ws.close(code=4001, reason="Invalid token")
        return

    org_id = payload.get("org_id")
    if not org_id:
        await ws.close(code=4002, reason="Token missing org_id")
        return

    if not _legacy_agent_user_is_current(payload):
        await ws.close(code=4003, reason="Legacy agent requires an active organization admin")
        return

    try:
        if _org_has_paired_agent_device(int(org_id)):
            await ws.close(
                code=4003,
                reason="Legacy agent authentication disabled; use device pairing",
            )
            return
    except Exception as exc:
        log.warning("Unable to validate legacy agent migration state for org %s: %s", org_id, exc)
        await ws.close(code=1011, reason="Unable to validate agent credential")
        return

    await _serve_agent_socket(ws, int(org_id))


@router.websocket(V2_AGENT_WS_PATH)
async def agent_connect_v2(
    ws: WebSocket,
    token: str | None = Query(
        default=None,
        description="Deprecated query fallback for a short-lived agent token",
    ),
) -> None:
    """Protocol-v2 connection authenticated as a dedicated AgentDevice."""
    authorization = (ws.headers.get("authorization") or "").strip()
    header_token = ""
    if authorization:
        scheme, separator, value = authorization.partition(" ")
        if separator and scheme.lower() == "bearer" and value.strip():
            header_token = value.strip()
    if header_token and token and header_token != token:
        await ws.close(code=4001, reason="Conflicting agent credentials")
        return
    access_token = header_token or token or ""
    runtime_scopes = frozenset({"agent:connect"})
    claims = decode_agent_access_token(
        access_token,
        required_scopes=runtime_scopes,
    )
    if claims is None:
        await ws.close(code=4001, reason="Invalid agent credential")
        return
    with _fresh_agent_session() as db:
        device = resolve_agent_access_token(
            db,
            access_token,
            required_scopes=runtime_scopes,
        )
        if device is None:
            await ws.close(code=4001, reason="Invalid agent credential")
            return
        device.last_seen_at = datetime.now(timezone.utc)
        device.connection_epoch += 1
        db.commit()
        device_id = device.id
        organization_id = device.organization_id

    await _serve_agent_socket(
        ws,
        organization_id,
        device_id=device_id,
        scopes=claims.scopes,
        on_message=lambda data: _persist_agent_hello(
            device_id=device_id,
            organization_id=organization_id,
            data=data,
        ),
        credential_watchdog=lambda: _watch_agent_credential(
            ws,
            device_id=device_id,
            organization_id=organization_id,
            credential_version=claims.credential_version,
        ),
    )
