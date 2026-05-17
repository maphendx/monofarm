"""Printer endpoints.

Strategy: DB stores persistent printer rows (name, kind, manual state).
Bambu live state comes from MQTT cache; Moonraker from REST polling.
"""
import asyncio
from datetime import datetime, timezone

import requests as _requests
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, get_current_user, require_roles
from app.core.db import get_db
from app.models.organization import Organization
from app.models.plan import PlanEntry
from app.models.printer import Printer, PrinterKind
from app.models.printer_group import PrinterGroup
from app.models.task import PrintTask
from app.models.user import User, UserRole
from app.schemas.printer import (
    FilamentSlot,
    PrinterCreate,
    PrinterGroupAssign,
    PrinterManualUpdate,
    PrinterOut,
    PrinterReorderItem,
    PrinterUpdate,
)
from app.services import bambu, moonraker, tunnel as _tunnel


class ClearBedPayload(BaseModel):
    success: bool = True


class SendGcodePayload(BaseModel):
    gcode: list[str]


import re


def _natural_key(s: str) -> list:
    """Split a string into text/number chunks so A11 sorts after A10, not after A1."""
    return [int(chunk) if chunk.isdigit() else chunk.lower() for chunk in re.split(r"(\d+)", s)]


router = APIRouter(prefix="/printers", tags=["printers"])



def _ensure_bambu_rows(db: Session, devices: list[dict], org_id: int) -> dict[str, Printer]:
    """Make sure every Bambu Cloud device has a DB row for this org.  Returns dev_id -> Printer map."""
    if not devices:
        return {}
    dev_ids = [d["dev_id"] for d in devices]
    existing = {
        p.bambu_dev_id: p
        for p in db.query(Printer).filter(
            Printer.bambu_dev_id.in_(dev_ids),
            Printer.organization_id == org_id,
        )
    }
    dirty = False
    new_rows: list[Printer] = []
    for d in devices:
        did = d["dev_id"]
        if did in existing:
            row = existing[did]
            if row.name != d["name"]:
                row.name = d["name"]
                dirty = True
            if d.get("dev_access_code") and row.bambu_access_code != d["dev_access_code"]:
                row.bambu_access_code = d["dev_access_code"]
                dirty = True
            model = d.get("dev_product_name") or d.get("dev_model_name") or ""
            if model and row.bambu_model != model:
                row.bambu_model = model
                dirty = True
            continue
        row = Printer(
            organization_id=org_id,
            name=d["name"],
            kind=PrinterKind.bambu,
            bambu_dev_id=did,
            bambu_access_code=d.get("dev_access_code", ""),
            bambu_model=d.get("dev_product_name") or d.get("dev_model_name") or "",
        )
        db.add(row)
        new_rows.append(row)
        dirty = True
    if dirty:
        db.commit()
        for row in new_rows:
            db.refresh(row)
            existing[row.bambu_dev_id] = row
            bambu.subscribe_device(row.bambu_dev_id, org_id)
    return existing


def _resolve_filament_for_file(
    db: Session, filename: str | None, moonraker_url: str | None = None, org_id: int | None = None
) -> dict | None:
    """Find filament_meta for the file currently being printed.

    1. Local DB: PrintTask whose file_name matches (most recent if duplicates).
    2. Fallback: fetch from Moonraker — its metadata, then file tail.
    """
    if not filename:
        return None
    q = db.query(PrintTask).filter(PrintTask.file_name == filename, PrintTask.filament_meta.isnot(None))
    if org_id is not None:
        q = q.filter(PrintTask.organization_id == org_id)
    task = q.order_by(PrintTask.created_at.desc()).first()
    if task and task.filament_meta:
        return task.filament_meta
    # Fall back to Moonraker — for files uploaded outside our system
    if moonraker_url:
        remote = moonraker.get_remote_file_meta(moonraker_url, filename)
        return remote or None
    return None


def _to_dto(
    printer: Printer,
    db: Session | None = None,
    groups_by_id: dict[int, str] | None = None,
    prefetched_live: dict | None = None,
) -> PrinterOut:
    group_name: str | None = None
    if printer.group_id is not None:
        if groups_by_id is not None:
            group_name = groups_by_id.get(printer.group_id)
        elif db is not None:
            g = db.get(PrinterGroup, printer.group_id)
            group_name = g.name if g else None

    base = dict(
        id=printer.id,
        name=printer.name,
        kind=printer.kind,
        moonraker_url=printer.moonraker_url,
        bambu_dev_id=printer.bambu_dev_id,
        bambu_dev_ip=printer.bambu_dev_ip,
        bambu_model=printer.bambu_model,
        is_active=printer.is_active,
        group_id=printer.group_id,
        group_name=group_name,
        loaded_filaments=printer.loaded_filaments or [],
    )

    # Bambu Lab — live state from MQTT cache, AMS filaments from cache
    if printer.kind == PrinterKind.bambu and printer.bambu_dev_id:
        live = bambu.get_cached_state(printer.bambu_dev_id)
        ams_trays = bambu.get_ams_filaments(printer.bambu_dev_id)
        filaments = ams_trays if ams_trays else (printer.loaded_filaments or [])
        return PrinterOut(
            **{**base, "loaded_filaments": filaments},
            state=live.get("state") or "unknown",
            flags=[],
            job=live.get("filename"),
            eta_minutes=live.get("eta_minutes"),
            source="bambu",
            progress_pct=live.get("progress_pct"),
            extruder_temp=live.get("nozzle_temp"),
            extruder_target=live.get("nozzle_target"),
            bed_temp=live.get("bed_temp"),
            bed_target=live.get("bed_target"),
            error_msg=live.get("error_msg"),
            active_tray=live.get("active_tray"),
        )

    # Manual (U1, other) — if Moonraker URL is set, prefer live data
    if printer.moonraker_url:
        live = prefetched_live if prefetched_live is not None else moonraker.get_live_status(printer.moonraker_url)
        filename = live.get("filename") or printer.manual_job
        current_meta = (
            _resolve_filament_for_file(db, filename, printer.moonraker_url, printer.organization_id)
            if db
            else None
        )
        return PrinterOut(
            **base,
            state=live.get("state") or "unknown",
            flags=[],
            job=filename,
            eta_minutes=live.get("eta_minutes"),
            updated_at=printer.manual_updated_at,
            source="moonraker",
            progress_pct=live.get("progress_pct"),
            extruder_temp=live.get("extruder_temp"),
            extruder_target=live.get("extruder_target"),
            bed_temp=live.get("bed_temp"),
            bed_target=live.get("bed_target"),
            current_filament_meta=current_meta,
            error_msg=live.get("error_msg"),
        )

    return PrinterOut(
        **base,
        state=printer.manual_status or "idle",
        flags=[],
        job=printer.manual_job,
        eta_minutes=printer.manual_eta_minutes,
        updated_at=printer.manual_updated_at,
        source="manual",
    )


@router.get("/{printer_id}", response_model=PrinterOut)
async def get_printer(
    printer_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> PrinterOut:
    row = db.query(Printer).filter(Printer.id == printer_id, Printer.organization_id == org.id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Printer not found")
    groups_by_id = {g.id: g.name for g in db.query(PrinterGroup).filter(PrinterGroup.organization_id == org.id).all()}
    # Pre-fetch Moonraker status so _to_dto can stay synchronous
    live: dict | None = None
    if row.moonraker_url:
        if _tunnel.has_tunnel(org.id):
            live = await _tunnel.get_moonraker_status(org.id, row.moonraker_url)
        else:
            live = await asyncio.to_thread(moonraker.get_live_status, row.moonraker_url)
    return _to_dto(row, db, groups_by_id, prefetched_live=live)


@router.get("/bambu-discover")
async def bambu_discover(
    org: Organization = Depends(get_current_org),
) -> list[dict]:
    """UDP LAN broadcast to find Bambu printers and their IPs (same protocol as Bambu Studio)."""
    import json
    import socket

    BAMBU_PORT = 2021
    TIMEOUT = 3.0

    def _discover() -> list[dict]:
        results: dict[str, dict] = {}
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.settimeout(TIMEOUT)
        try:
            msg = json.dumps({"command": "get_version"}).encode()
            sock.sendto(msg, ("255.255.255.255", BAMBU_PORT))
            deadline = __import__("time").monotonic() + TIMEOUT
            while __import__("time").monotonic() < deadline:
                try:
                    data, addr = sock.recvfrom(4096)
                    payload = json.loads(data)
                    dev_id = payload.get("dev_id") or payload.get("sn") or ""
                    if dev_id:
                        results[dev_id] = {
                            "dev_id": dev_id,
                            "ip": addr[0],
                            "name": payload.get("dev_name") or payload.get("name") or "",
                            "model": payload.get("dev_product_name") or payload.get("machine_type") or "",
                        }
                except socket.timeout:
                    break
                except Exception:
                    continue
        finally:
            sock.close()
        return list(results.values())

    return await asyncio.to_thread(_discover)


@router.get("/{printer_id}/webcam/snapshot")
async def webcam_snapshot(
    printer_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> Response:
    """Proxy a single webcam snapshot from Moonraker — bypasses browser Private Network Access."""
    row = db.query(Printer).filter(Printer.id == printer_id, Printer.organization_id == org.id).first()
    if not row or not row.moonraker_url:
        raise HTTPException(status_code=404, detail="No Moonraker URL")
    webcams = await asyncio.to_thread(moonraker.get_webcams, row.moonraker_url)
    if not webcams:
        raise HTTPException(status_code=404, detail="No webcams configured on this printer")
    snapshot_url: str = webcams[0].get("snapshot_url", "")
    if not snapshot_url.startswith("http"):
        base = moonraker._api_base(row.moonraker_url)  # noqa: SLF001
        snapshot_url = base + snapshot_url
    try:
        resp = await asyncio.to_thread(lambda: _requests.get(snapshot_url, timeout=5))
        resp.raise_for_status()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Webcam unavailable: {exc}") from exc
    return Response(
        content=resp.content,
        media_type=resp.headers.get("content-type", "image/jpeg"),
        headers={"Cache-Control": "no-store"},
    )


@router.get("/{printer_id}/camera/stream")
async def camera_stream(
    printer_id: int,
    token: str | None = None,
    db: Session = Depends(get_db),
) -> StreamingResponse:
    """Stream Bambu Lab camera as MJPEG via FFmpeg RTSPS proxy.

    Accepts token as query param (for <img> tags that can't set headers).
    """
    import shutil
    from app.core.security import decode_token
    payload = decode_token(token or "")
    if not payload:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = db.get(User, int(payload.get("sub", 0)))
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="Invalid user")
    row = db.query(Printer).filter(Printer.id == printer_id, Printer.organization_id == user.organization_id).first()
    if not row or row.kind != PrinterKind.bambu or not row.bambu_dev_ip:
        raise HTTPException(status_code=404, detail="Camera not available: set LAN IP in printer settings")
    if not shutil.which("ffmpeg"):
        raise HTTPException(status_code=503, detail="ffmpeg not found on server")

    rtsps_url = f"rtsps://bblp:{row.bambu_access_code}@{row.bambu_dev_ip}:322/streaming/live/1"
    cmd = [
        "ffmpeg",
        "-loglevel", "quiet",
        "-rtsp_transport", "tcp",
        "-tls_verify", "0",
        "-i", rtsps_url,
        "-vf", "fps=5",
        "-f", "image2pipe",
        "-vcodec", "mjpeg",
        "-q:v", "3",
        "pipe:1",
    ]

    async def generate():
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        buf = b""
        try:
            while True:
                chunk = await proc.stdout.read(65536)
                if not chunk:
                    break
                buf += chunk
                # Extract complete JPEG frames (SOI=FFD8, EOI=FFD9)
                while True:
                    start = buf.find(b"\xff\xd8")
                    if start < 0:
                        break
                    end = buf.find(b"\xff\xd9", start + 2)
                    if end < 0:
                        break
                    frame = buf[start:end + 2]
                    buf = buf[end + 2:]
                    yield (
                        b"--frame\r\n"
                        b"Content-Type: image/jpeg\r\n\r\n"
                        + frame
                        + b"\r\n"
                    )
        finally:
            proc.kill()
            await proc.wait()

    return StreamingResponse(
        generate(),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={"Cache-Control": "no-store"},
    )


@router.get("", response_model=list[PrinterOut])
async def list_printers(
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[PrinterOut]:
    bambu_devices = await asyncio.to_thread(bambu.list_devices, org.id)
    _ensure_bambu_rows(db, bambu_devices, org.id)

    groups_by_id = {g.id: g.name for g in db.query(PrinterGroup).filter(PrinterGroup.organization_id == org.id).all()}
    groups_order = {g.id: g.sort_order for g in db.query(PrinterGroup).filter(PrinterGroup.organization_id == org.id).all()}

    rows = (
        db.query(Printer)
        .filter(Printer.is_active.is_(True), Printer.organization_id == org.id)
        .all()
    )
    rows.sort(key=lambda p: (
        p.group_id is None,
        groups_order.get(p.group_id, 0) if p.group_id is not None else 0,
        _natural_key(p.name),
    ))

    # Fetch all Moonraker statuses in parallel — via tunnel if available, else direct
    moonraker_rows = [r for r in rows if r.moonraker_url]
    if moonraker_rows:
        if _tunnel.has_tunnel(org.id):
            fetchers = [_tunnel.get_moonraker_status(org.id, r.moonraker_url) for r in moonraker_rows]
        else:
            fetchers = [asyncio.to_thread(moonraker.get_live_status, r.moonraker_url) for r in moonraker_rows]
        results = await asyncio.gather(*fetchers, return_exceptions=True)
        live_by_url: dict[str, dict] = {}
        for r, res in zip(moonraker_rows, results):
            live_by_url[r.moonraker_url] = res if isinstance(res, dict) else {"state": "offline"}
    else:
        live_by_url = {}

    out: list[PrinterOut] = []
    for row in rows:
        prefetched = live_by_url.get(row.moonraker_url) if row.moonraker_url else None
        out.append(_to_dto(row, db, groups_by_id, prefetched_live=prefetched))
    return out


@router.post("", response_model=PrinterOut, status_code=status.HTTP_201_CREATED)
def create_printer(
    payload: PrinterCreate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin)),
) -> PrinterOut:
    from app.models.organization import PLAN_LIMITS
    current_count = db.query(Printer).filter(Printer.organization_id == org.id).count()
    limit = PLAN_LIMITS[org.plan]["printers"]
    if current_count >= limit:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail=f"Printer limit reached for your plan ({limit}). Upgrade to add more.",
        )
    row = Printer(
        organization_id=org.id,
        name=payload.name,
        kind=payload.kind,
        moonraker_url=payload.moonraker_url,
        bambu_dev_id=payload.bambu_dev_id,
        bambu_access_code=payload.bambu_access_code,
        bambu_dev_ip=payload.bambu_dev_ip,
        bambu_model=payload.bambu_model,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    if row.kind == PrinterKind.bambu and row.bambu_dev_id:
        bambu.subscribe_device(row.bambu_dev_id, org.id)
    return _to_dto(row, db)


@router.patch("/{printer_id}", response_model=PrinterOut)
def update_printer(
    printer_id: int,
    payload: PrinterUpdate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin)),
) -> PrinterOut:
    row = db.query(Printer).filter(Printer.id == printer_id, Printer.organization_id == org.id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Printer not found")
    if payload.name is not None:
        row.name = payload.name
    if payload.is_active is not None:
        row.is_active = payload.is_active
    if payload.moonraker_url is not None:
        row.moonraker_url = payload.moonraker_url.strip() or None
    if payload.bambu_dev_id is not None:
        row.bambu_dev_id = payload.bambu_dev_id.strip() or None
    if payload.bambu_access_code is not None:
        row.bambu_access_code = payload.bambu_access_code.strip() or None
    if payload.bambu_dev_ip is not None:
        row.bambu_dev_ip = payload.bambu_dev_ip.strip() or None
    if payload.bambu_model is not None:
        row.bambu_model = payload.bambu_model.strip() or None
    db.commit()
    db.refresh(row)
    return _to_dto(row, db)


@router.post("/{printer_id}/group", response_model=PrinterOut)
def assign_group(
    printer_id: int,
    payload: PrinterGroupAssign,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> PrinterOut:
    row = db.query(Printer).filter(Printer.id == printer_id, Printer.organization_id == org.id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Printer not found")
    if payload.group_id is not None:
        group = db.query(PrinterGroup).filter(PrinterGroup.id == payload.group_id, PrinterGroup.organization_id == org.id).first()
        if not group:
            raise HTTPException(status_code=404, detail="Group not found")
    row.group_id = payload.group_id
    db.commit()
    db.refresh(row)
    return _to_dto(row, db)


@router.put("/{printer_id}/loaded-filaments", response_model=PrinterOut)
def set_loaded_filaments(
    printer_id: int,
    slots: list[FilamentSlot],
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> PrinterOut:
    """Replace the full list of filament slots loaded in the printer."""
    row = db.query(Printer).filter(Printer.id == printer_id, Printer.organization_id == org.id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Printer not found")
    row.loaded_filaments = [s.model_dump() for s in slots]
    db.commit()
    db.refresh(row)
    return _to_dto(row, db)


@router.post("/{printer_id}/manual", response_model=PrinterOut)
def set_manual_state(
    printer_id: int,
    payload: PrinterManualUpdate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> PrinterOut:
    row = db.query(Printer).filter(Printer.id == printer_id, Printer.organization_id == org.id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Printer not found")
    if payload.status is not None:
        row.manual_status = payload.status
    if payload.job is not None:
        row.manual_job = payload.job
    if payload.eta_minutes is not None:
        row.manual_eta_minutes = payload.eta_minutes
    row.manual_updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(row)
    return _to_dto(row, db)


@router.delete("/{printer_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_printer(
    printer_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _admin: User = Depends(require_roles(UserRole.admin)),
) -> None:
    row = db.query(Printer).filter(Printer.id == printer_id, Printer.organization_id == org.id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Printer not found")
    # Cascade: drop plan entries pointing to this printer
    db.query(PlanEntry).filter(PlanEntry.printer_id == printer_id).delete()
    db.delete(row)
    db.commit()


@router.delete("", status_code=status.HTTP_200_OK)
def bulk_delete_printers(
    kind: str | None = None,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _admin: User = Depends(require_roles(UserRole.admin)),
) -> dict:
    """Delete all printers for this org, optionally filtered by kind."""
    q = db.query(Printer).filter(Printer.organization_id == org.id)
    if kind:
        q = q.filter(Printer.kind == kind)
    rows = q.all()
    ids = [r.id for r in rows]
    if ids:
        db.query(PlanEntry).filter(PlanEntry.printer_id.in_(ids)).delete(synchronize_session=False)
        db.query(Printer).filter(Printer.id.in_(ids)).delete(synchronize_session=False)
        db.commit()
    return {"deleted": len(ids)}


@router.post("/reorder", status_code=status.HTTP_204_NO_CONTENT)
def reorder_printers(
    items: list[PrinterReorderItem],
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> None:
    """Bulk-update sort_order for a list of printers."""
    for item in items:
        row = db.query(Printer).filter(Printer.id == item.id, Printer.organization_id == org.id).first()
        if row:
            row.sort_order = item.sort_order
    db.commit()


@router.post("/sync", response_model=list[PrinterOut])
async def force_sync(
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> list[PrinterOut]:
    return await list_printers(db=db, org=org)


# ── Moonraker print control ─────────────────────────────────────────────────


_MR_ACTION_PATH = {
    "pause":  "/printer/print/pause",
    "resume": "/printer/print/resume",
    "cancel": "/printer/print/cancel",
}


async def _moonraker_action(
    printer_id: int, action_name: str, action_fn, db: Session, org_id: int
) -> dict:
    row = db.query(Printer).filter(Printer.id == printer_id, Printer.organization_id == org_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Printer not found")
    if not row.moonraker_url:
        raise HTTPException(status_code=400, detail="У принтера не вказано Moonraker URL")
    try:
        if _tunnel.has_tunnel(org_id) and action_name in _MR_ACTION_PATH:
            await _tunnel.moonraker_action(org_id, row.moonraker_url, _MR_ACTION_PATH[action_name])
        else:
            await asyncio.to_thread(action_fn, row.moonraker_url)
    except (moonraker.MoonrakerError, RuntimeError) as e:
        raise HTTPException(status_code=502, detail=str(e))
    moonraker._status_cache.pop(row.moonraker_url, None)  # noqa: SLF001
    return {"ok": True, "action": action_name}


@router.post("/{printer_id}/pause")
async def pause_print(
    printer_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    return await _moonraker_action(printer_id, "pause", moonraker.pause_print, db, org.id)


@router.post("/{printer_id}/resume")
async def resume_print(
    printer_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    return await _moonraker_action(printer_id, "resume", moonraker.resume_print, db, org.id)


@router.post("/{printer_id}/cancel")
async def cancel_print(
    printer_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    return await _moonraker_action(printer_id, "cancel", moonraker.cancel_print, db, org.id)


# ── Unified print controls (dispatches to Moonraker or Bambu) ────────────────


def _require_printer(printer_id: int, db: Session, org_id: int) -> Printer:
    row = db.query(Printer).filter(Printer.id == printer_id, Printer.organization_id == org_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Printer not found")
    return row


async def _dispatch(
    printer_id: int,
    action: str,
    mr_fn,
    db: Session,
    org: Organization,
    bambu_fn=None,
    optimistic_state: str | None = None,
) -> dict:
    """Route to Moonraker or Bambu based on printer kind."""
    import time as _time
    row = _require_printer(printer_id, db, org.id)
    if row.kind == PrinterKind.bambu and row.bambu_dev_id and bambu_fn:
        try:
            await asyncio.to_thread(bambu_fn, row.bambu_dev_id)
        except bambu.BambuError as e:
            raise HTTPException(status_code=502, detail=str(e))
        # Optimistically set transitional state — MQTT will correct it within seconds
        if optimistic_state and row.bambu_dev_id in bambu._state_cache:  # noqa: SLF001
            bambu._state_cache[row.bambu_dev_id]["state"] = optimistic_state  # noqa: SLF001
            bambu._state_cache[row.bambu_dev_id]["ts"] = _time.monotonic()  # noqa: SLF001
    elif row.moonraker_url:
        try:
            if _tunnel.has_tunnel(org.id) and action in _MR_ACTION_PATH:
                await _tunnel.moonraker_action(org.id, row.moonraker_url, _MR_ACTION_PATH[action])
            else:
                await asyncio.to_thread(mr_fn, row.moonraker_url)
        except (moonraker.MoonrakerError, RuntimeError) as e:
            raise HTTPException(status_code=502, detail=str(e))
        moonraker._status_cache.pop(row.moonraker_url, None)  # noqa: SLF001
    else:
        raise HTTPException(status_code=400, detail="Принтер не підтримує цю дію")
    return {"ok": True, "action": action}


@router.post("/{printer_id}/print/pause")
async def print_pause(
    printer_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    return await _dispatch(
        printer_id, "pause",
        moonraker.pause_print,
        db, org,
        bambu_fn=bambu.pause_print,
        optimistic_state="pausing",
    )


@router.post("/{printer_id}/print/resume")
async def print_resume(
    printer_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    return await _dispatch(
        printer_id, "resume",
        moonraker.resume_print,
        db, org,
        bambu_fn=bambu.resume_print,
        optimistic_state="resuming",
    )


@router.post("/{printer_id}/print/cancel")
async def print_cancel(
    printer_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    return await _dispatch(
        printer_id, "cancel",
        moonraker.cancel_print,
        db, org,
        bambu_fn=bambu.stop_print,
        optimistic_state="cancelling",
    )


@router.post("/{printer_id}/print/clear-bed")
async def print_clear_bed(
    printer_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    """Mark bed cleared — operator confirmed print was removed from bed."""
    row = _require_printer(printer_id, db, org.id)

    if row.kind == PrinterKind.bambu and row.bambu_dev_id:
        from app.services import bambu
        # Clear cached state so printer returns to IDLE on next MQTT push
        import time as _time
        bambu._state_cache[row.bambu_dev_id] = {"ts": _time.monotonic(), "state": "idle"}

    elif row.moonraker_url:
        # Home the printer — typical Klipper post-print sequence
        try:
            await asyncio.to_thread(moonraker.send_gcode, row.moonraker_url, "G28")
        except Exception:
            pass  # best-effort; state will refresh from Moonraker cache

    else:
        row.manual_status = "idle"
        row.manual_job = None
        db.commit()

    return {"ok": True, "action": "clear_bed"}


@router.post("/{printer_id}/print/clear-error")
async def print_clear_error(
    printer_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    """Acknowledge and clear an error state."""
    row = _require_printer(printer_id, db, org.id)

    if row.kind == PrinterKind.bambu and row.bambu_dev_id:
        from app.services import bambu
        import time as _time
        bambu._state_cache[row.bambu_dev_id] = {"ts": _time.monotonic(), "state": "idle"}

    elif row.moonraker_url:
        try:
            await asyncio.to_thread(moonraker.send_gcode, row.moonraker_url, "FIRMWARE_RESTART")
        except Exception:
            pass

    else:
        row.manual_status = "idle"
        db.commit()

    return {"ok": True, "action": "clear_error"}


@router.post("/{printer_id}/print/skip-object")
async def print_skip_object(
    printer_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    """Skip the currently-printing object via EXCLUDE_OBJECT_CURRENT gcode.

    Works on any Klipper printer with [exclude_object] enabled in printer.cfg.
    SimplyPrint: sends gcode via the SP API (printer must be Klipper-based).
    Moonraker: calls the /printer/gcode/script endpoint directly.
    """
    row = _require_printer(printer_id, db, org.id)
    if row.moonraker_url:
        try:
            await asyncio.to_thread(moonraker.skip_object, row.moonraker_url)
        except moonraker.MoonrakerError as e:
            raise HTTPException(status_code=502, detail=str(e))
        moonraker._status_cache.pop(row.moonraker_url, None)  # noqa: SLF001
        return {"ok": True, "action": "skip_object"}
    raise HTTPException(status_code=400, detail="Принтер не підтримує цю дію")


class GcodePayload(BaseModel):
    script: str


@router.post("/{printer_id}/gcode")
async def send_gcode(
    printer_id: int,
    payload: GcodePayload,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    """Send raw G-code to a Moonraker or Bambu printer."""
    row = _require_printer(printer_id, db, org.id)
    if row.kind == PrinterKind.bambu and row.bambu_dev_id:
        try:
            await asyncio.to_thread(bambu.send_gcode, row.bambu_dev_id, payload.script)
        except bambu.BambuError as e:
            raise HTTPException(status_code=502, detail=str(e))
        return {"ok": True}
    if row.moonraker_url:
        try:
            if _tunnel.has_tunnel(org.id):
                await _tunnel.moonraker_action(org.id, row.moonraker_url, "/printer/gcode/script", {"script": payload.script})
            else:
                await asyncio.to_thread(moonraker.send_gcode, row.moonraker_url, payload.script)
        except (moonraker.MoonrakerError, RuntimeError) as e:
            raise HTTPException(status_code=502, detail=str(e))
        return {"ok": True}
    raise HTTPException(status_code=400, detail="G-code не підтримується для цього принтера")


class SpeedProfilePayload(BaseModel):
    profile: int  # 1=Silent 2=Standard 3=Sport 4=Ludicrous


@router.post("/{printer_id}/speed-profile")
async def set_speed_profile(
    printer_id: int,
    payload: SpeedProfilePayload,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    """Set Bambu speed profile (1-4)."""
    row = _require_printer(printer_id, db, org.id)
    if row.kind != PrinterKind.bambu or not row.bambu_dev_id:
        raise HTTPException(status_code=400, detail="Тільки для Bambu принтерів")
    try:
        await asyncio.to_thread(bambu.set_speed_profile, row.bambu_dev_id, payload.profile)
    except bambu.BambuError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True}
