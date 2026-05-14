"""Printer endpoints.

Strategy: DB stores persistent printer rows (name, kind, sp_printer_id, manual state).
SimplyPrint live state is fetched on demand (with a 30s in-memory cache) and merged
with DB rows. Unknown sp_printer_ids are auto-imported as new rows on first sync.
"""
import asyncio
from datetime import datetime, timezone

import requests as _requests
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_roles
from app.core.db import get_db
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
from app.services import bambu, moonraker, simplyprint


class ClearBedPayload(BaseModel):
    success: bool = True


class SendGcodePayload(BaseModel):
    gcode: list[str]


import re


def _natural_key(s: str) -> list:
    """Split a string into text/number chunks so A11 sorts after A10, not after A1."""
    return [int(chunk) if chunk.isdigit() else chunk.lower() for chunk in re.split(r"(\d+)", s)]


router = APIRouter(prefix="/printers", tags=["printers"])


def _ensure_simplyprint_rows(db: Session, sp_printers: list[dict]) -> dict[str, Printer]:
    """Make sure every SP printer has a DB row. Returns sp_id -> Printer map."""
    if not sp_printers:
        return {}
    sp_ids = [str(p["id"]) for p in sp_printers]
    existing = {p.sp_printer_id: p for p in db.query(Printer).filter(Printer.sp_printer_id.in_(sp_ids))}
    dirty = False
    new_rows: list[Printer] = []
    for sp in sp_printers:
        sp_id = str(sp["id"])
        if sp_id in existing:
            row = existing[sp_id]
            if row.name != sp["name"]:
                row.name = sp["name"]
                dirty = True
            continue
        row = Printer(
            name=sp["name"],
            kind=PrinterKind.simplyprint,
            sp_printer_id=sp_id,
        )
        db.add(row)
        new_rows.append(row)
        dirty = True
    if dirty:
        db.commit()
        for row in new_rows:
            db.refresh(row)
            existing[row.sp_printer_id] = row
    return existing


def _ensure_bambu_rows(db: Session, devices: list[dict]) -> dict[str, Printer]:
    """Make sure every Bambu Cloud device has a DB row.  Returns dev_id -> Printer map."""
    if not devices:
        return {}
    dev_ids = [d["dev_id"] for d in devices]
    existing = {
        p.bambu_dev_id: p
        for p in db.query(Printer).filter(Printer.bambu_dev_id.in_(dev_ids))
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
            # Subscribe MQTT for newly discovered printers
            bambu.subscribe_device(row.bambu_dev_id)
    return existing


def _resolve_filament_for_file(
    db: Session, filename: str | None, moonraker_url: str | None = None
) -> dict | None:
    """Find filament_meta for the file currently being printed.

    1. Local DB: PrintTask whose file_name matches (most recent if duplicates).
    2. Fallback: fetch from Moonraker — its metadata, then file tail.
    """
    if not filename:
        return None
    task = (
        db.query(PrintTask)
        .filter(PrintTask.file_name == filename, PrintTask.filament_meta.isnot(None))
        .order_by(PrintTask.created_at.desc())
        .first()
    )
    if task and task.filament_meta:
        return task.filament_meta
    # Fall back to Moonraker — for files uploaded outside our system
    if moonraker_url:
        remote = moonraker.get_remote_file_meta(moonraker_url, filename)
        return remote or None
    return None


def _to_dto(
    printer: Printer,
    sp_state: dict | None,
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
        sp_printer_id=printer.sp_printer_id,
        moonraker_url=printer.moonraker_url,
        bambu_dev_id=printer.bambu_dev_id,
        bambu_model=printer.bambu_model,
        is_active=printer.is_active,
        group_id=printer.group_id,
        group_name=group_name,
        loaded_filaments=printer.loaded_filaments or [],
    )
    if printer.kind == PrinterKind.simplyprint and sp_state:
        return PrinterOut(
            **base,
            state=sp_state["state"],
            flags=sp_state.get("flags", []),
            progress_pct=sp_state.get("progress"),
            source="simplyprint",
        )
    if printer.kind == PrinterKind.simplyprint:
        return PrinterOut(**base, state="unknown", flags=[], source="unknown")

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
        )

    # Manual (U1, other) — if Moonraker URL is set, prefer live data
    if printer.moonraker_url:
        live = prefetched_live if prefetched_live is not None else moonraker.get_live_status(printer.moonraker_url)
        filename = live.get("filename") or printer.manual_job
        current_meta = (
            _resolve_filament_for_file(db, filename, printer.moonraker_url)
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
def get_printer(
    printer_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> PrinterOut:
    row = db.get(Printer, printer_id)
    if not row:
        raise HTTPException(status_code=404, detail="Printer not found")
    groups_by_id = {g.id: g.name for g in db.query(PrinterGroup).all()}
    sp_state = None
    if row.kind == PrinterKind.simplyprint and row.sp_printer_id:
        overview = simplyprint.get_farm_overview()
        sp_printers = simplyprint.extract_printers(overview)
        sp_state = next((p for p in sp_printers if str(p["id"]) == row.sp_printer_id), None)
    return _to_dto(row, sp_state, db, groups_by_id)


@router.get("/{printer_id}/webcam/snapshot")
async def webcam_snapshot(
    printer_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> Response:
    """Proxy a single webcam snapshot from Moonraker — bypasses browser Private Network Access."""
    row = db.get(Printer, printer_id)
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


@router.get("", response_model=list[PrinterOut])
async def list_printers(
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[PrinterOut]:
    # Fetch SimplyPrint + Bambu devices in parallel (both are network calls)
    overview_task = asyncio.to_thread(simplyprint.get_farm_overview)
    bambu_task = asyncio.to_thread(bambu.list_devices)
    overview, bambu_devices = await asyncio.gather(overview_task, bambu_task)

    sp_printers = simplyprint.extract_printers(overview)
    _ensure_simplyprint_rows(db, sp_printers)
    _ensure_bambu_rows(db, bambu_devices)

    sp_state_by_id = {str(p["id"]): p for p in sp_printers}

    groups_by_id = {g.id: g.name for g in db.query(PrinterGroup).all()}
    groups_order = {g.id: g.sort_order for g in db.query(PrinterGroup).all()}

    rows = (
        db.query(Printer)
        .filter(Printer.is_active.is_(True))
        .all()
    )
    rows.sort(key=lambda p: (
        p.group_id is None,
        groups_order.get(p.group_id, 0) if p.group_id is not None else 0,
        _natural_key(p.name),
    ))

    # Fetch all Moonraker statuses in parallel — avoids sequential timeouts
    moonraker_rows = [r for r in rows if r.moonraker_url]
    if moonraker_rows:
        results = await asyncio.gather(
            *[asyncio.to_thread(moonraker.get_live_status, r.moonraker_url) for r in moonraker_rows],
            return_exceptions=True,
        )
        live_by_url: dict[str, dict] = {}
        for r, res in zip(moonraker_rows, results):
            live_by_url[r.moonraker_url] = (
                res if isinstance(res, dict) else {"state": "offline"}
            )
    else:
        live_by_url = {}

    out: list[PrinterOut] = []
    for row in rows:
        sp_state = sp_state_by_id.get(row.sp_printer_id) if row.sp_printer_id else None
        prefetched = live_by_url.get(row.moonraker_url) if row.moonraker_url else None
        out.append(_to_dto(row, sp_state, db, groups_by_id, prefetched_live=prefetched))
    return out


@router.post("", response_model=PrinterOut, status_code=status.HTTP_201_CREATED)
def create_printer(
    payload: PrinterCreate,
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin)),
) -> PrinterOut:
    row = Printer(
        name=payload.name,
        kind=payload.kind,
        sp_printer_id=payload.sp_printer_id,
        moonraker_url=payload.moonraker_url,
        bambu_dev_id=payload.bambu_dev_id,
        bambu_access_code=payload.bambu_access_code,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_dto(row, None, db)


@router.patch("/{printer_id}", response_model=PrinterOut)
def update_printer(
    printer_id: int,
    payload: PrinterUpdate,
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin)),
) -> PrinterOut:
    row = db.get(Printer, printer_id)
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
    db.commit()
    db.refresh(row)
    return _to_dto(row, None, db)


@router.post("/{printer_id}/group", response_model=PrinterOut)
def assign_group(
    printer_id: int,
    payload: PrinterGroupAssign,
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> PrinterOut:
    row = db.get(Printer, printer_id)
    if not row:
        raise HTTPException(status_code=404, detail="Printer not found")
    if payload.group_id is not None:
        group = db.get(PrinterGroup, payload.group_id)
        if not group:
            raise HTTPException(status_code=404, detail="Group not found")
    row.group_id = payload.group_id
    db.commit()
    db.refresh(row)
    return _to_dto(row, None, db)


@router.put("/{printer_id}/loaded-filaments", response_model=PrinterOut)
def set_loaded_filaments(
    printer_id: int,
    slots: list[FilamentSlot],
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> PrinterOut:
    """Replace the full list of filament slots loaded in the printer."""
    row = db.get(Printer, printer_id)
    if not row:
        raise HTTPException(status_code=404, detail="Printer not found")
    row.loaded_filaments = [s.model_dump() for s in slots]
    db.commit()
    db.refresh(row)
    return _to_dto(row, None, db)


@router.post("/{printer_id}/manual", response_model=PrinterOut)
def set_manual_state(
    printer_id: int,
    payload: PrinterManualUpdate,
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> PrinterOut:
    row = db.get(Printer, printer_id)
    if not row:
        raise HTTPException(status_code=404, detail="Printer not found")
    if row.kind == PrinterKind.simplyprint:
        raise HTTPException(
            status_code=400,
            detail="Не можна вручну змінювати стан SimplyPrint-принтера — він тягнеться з API.",
        )
    if payload.status is not None:
        row.manual_status = payload.status
    if payload.job is not None:
        row.manual_job = payload.job
    if payload.eta_minutes is not None:
        row.manual_eta_minutes = payload.eta_minutes
    row.manual_updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(row)
    return _to_dto(row, None, db)


@router.delete("/{printer_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_printer(
    printer_id: int,
    db: Session = Depends(get_db),
    _admin: User = Depends(require_roles(UserRole.admin)),
) -> None:
    row = db.get(Printer, printer_id)
    if not row:
        raise HTTPException(status_code=404, detail="Printer not found")
    # Cascade: drop plan entries pointing to this printer
    db.query(PlanEntry).filter(PlanEntry.printer_id == printer_id).delete()
    db.delete(row)
    db.commit()


@router.post("/reorder", status_code=status.HTTP_204_NO_CONTENT)
def reorder_printers(
    items: list[PrinterReorderItem],
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> None:
    """Bulk-update sort_order for a list of printers."""
    for item in items:
        row = db.get(Printer, item.id)
        if row:
            row.sort_order = item.sort_order
    db.commit()


@router.post("/sync", response_model=list[PrinterOut])
async def force_sync(
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> list[PrinterOut]:
    overview = simplyprint.get_farm_overview(force=True)
    sp_printers = simplyprint.extract_printers(overview)
    _ensure_simplyprint_rows(db, sp_printers)
    return await list_printers(db=db, _user=_user)  # type: ignore[arg-type]


# ── Moonraker print control ─────────────────────────────────────────────────


async def _moonraker_action(
    printer_id: int, action_name: str, action_fn, db: Session
) -> dict:
    row = db.get(Printer, printer_id)
    if not row:
        raise HTTPException(status_code=404, detail="Printer not found")
    if not row.moonraker_url:
        raise HTTPException(status_code=400, detail="У принтера не вказано Moonraker URL")
    try:
        await asyncio.to_thread(action_fn, row.moonraker_url)
    except moonraker.MoonrakerError as e:
        raise HTTPException(status_code=502, detail=str(e))
    # invalidate live cache so the next /api/printers shows fresh state
    moonraker._status_cache.pop(row.moonraker_url, None)  # noqa: SLF001
    return {"ok": True, "action": action_name}


@router.post("/{printer_id}/pause")
async def pause_print(
    printer_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    return await _moonraker_action(printer_id, "pause", moonraker.pause_print, db)


@router.post("/{printer_id}/resume")
async def resume_print(
    printer_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    return await _moonraker_action(printer_id, "resume", moonraker.resume_print, db)


@router.post("/{printer_id}/cancel")
async def cancel_print(
    printer_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    return await _moonraker_action(printer_id, "cancel", moonraker.cancel_print, db)


# ── SimplyPrint print control ────────────────────────────────────────────────


def _get_sp_printer(printer_id: int, db: Session) -> Printer:
    """Fetch printer row and verify it is a SimplyPrint printer with a known SP id."""
    row = db.get(Printer, printer_id)
    if not row:
        raise HTTPException(status_code=404, detail="Printer not found")
    if row.kind != PrinterKind.simplyprint or not row.sp_printer_id:
        raise HTTPException(status_code=400, detail="Принтер не підключений до SimplyPrint")
    return row


async def _sp_action(printer_id: int, action_name: str, action_fn, db: Session) -> dict:
    row = _get_sp_printer(printer_id, db)
    try:
        await asyncio.to_thread(action_fn, row.sp_printer_id)
    except simplyprint.SimplyPrintError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True, "action": action_name}


@router.post("/{printer_id}/sp/pause")
async def sp_pause(
    printer_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    return await _sp_action(printer_id, "pause", simplyprint.pause_print, db)


@router.post("/{printer_id}/sp/resume")
async def sp_resume(
    printer_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    return await _sp_action(printer_id, "resume", simplyprint.resume_print, db)


@router.post("/{printer_id}/sp/cancel")
async def sp_cancel(
    printer_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    return await _sp_action(printer_id, "cancel", simplyprint.cancel_print, db)


@router.post("/{printer_id}/sp/clear-bed")
async def sp_clear_bed(
    printer_id: int,
    payload: ClearBedPayload = ClearBedPayload(),
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    row = _get_sp_printer(printer_id, db)
    try:
        await asyncio.to_thread(simplyprint.clear_bed, row.sp_printer_id, payload.success)
    except simplyprint.SimplyPrintError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True, "action": "clear_bed"}


@router.post("/{printer_id}/sp/gcode")
async def sp_send_gcode(
    printer_id: int,
    payload: SendGcodePayload,
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin)),
) -> dict:
    row = _get_sp_printer(printer_id, db)
    try:
        await asyncio.to_thread(simplyprint.send_gcode, row.sp_printer_id, payload.gcode)
    except simplyprint.SimplyPrintError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"ok": True, "action": "send_gcode"}


# ── Unified print controls (dispatches to SP or Moonraker) ───────────────────
# Designed so a third backend (e.g. OctoPrint, Bambu) can be added here later
# by adding another elif branch — the frontend always calls the same endpoints.


def _require_printer(printer_id: int, db: Session) -> Printer:
    row = db.get(Printer, printer_id)
    if not row:
        raise HTTPException(status_code=404, detail="Printer not found")
    return row


async def _dispatch(
    printer_id: int,
    action: str,
    sp_fn,
    mr_fn,
    db: Session,
    bambu_fn=None,
) -> dict:
    """Route to SimplyPrint, Moonraker, or Bambu based on printer kind."""
    row = _require_printer(printer_id, db)
    if row.kind == PrinterKind.simplyprint and row.sp_printer_id:
        try:
            await asyncio.to_thread(sp_fn, row.sp_printer_id)
        except simplyprint.SimplyPrintError as e:
            raise HTTPException(status_code=502, detail=str(e))
        simplyprint.invalidate_cache()
    elif row.kind == PrinterKind.bambu and row.bambu_dev_id and bambu_fn:
        try:
            await asyncio.to_thread(bambu_fn, row.bambu_dev_id)
        except bambu.BambuError as e:
            raise HTTPException(status_code=502, detail=str(e))
    elif row.moonraker_url:
        try:
            await asyncio.to_thread(mr_fn, row.moonraker_url)
        except moonraker.MoonrakerError as e:
            raise HTTPException(status_code=502, detail=str(e))
        moonraker._status_cache.pop(row.moonraker_url, None)  # noqa: SLF001
    else:
        raise HTTPException(status_code=400, detail="Принтер не підтримує цю дію")
    return {"ok": True, "action": action}


@router.post("/{printer_id}/print/pause")
async def print_pause(
    printer_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    return await _dispatch(
        printer_id, "pause",
        simplyprint.pause_print,
        moonraker.pause_print,
        db,
        bambu_fn=bambu.pause_print,
    )


@router.post("/{printer_id}/print/resume")
async def print_resume(
    printer_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    return await _dispatch(
        printer_id, "resume",
        simplyprint.resume_print,
        moonraker.resume_print,
        db,
        bambu_fn=bambu.resume_print,
    )


@router.post("/{printer_id}/print/cancel")
async def print_cancel(
    printer_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    return await _dispatch(
        printer_id, "cancel",
        simplyprint.cancel_print,
        moonraker.cancel_print,
        db,
        bambu_fn=bambu.stop_print,
    )


@router.post("/{printer_id}/print/clear-bed")
async def print_clear_bed(
    printer_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    """Mark bed cleared after a finished print.

    SimplyPrint: calls ClearBed action.
    Moonraker/other: not applicable — returns 400.
    """
    row = _require_printer(printer_id, db)
    if row.kind == PrinterKind.simplyprint and row.sp_printer_id:
        try:
            await asyncio.to_thread(simplyprint.clear_bed, row.sp_printer_id, True)
        except simplyprint.SimplyPrintError as e:
            raise HTTPException(status_code=502, detail=str(e))
        simplyprint.invalidate_cache()
        return {"ok": True, "action": "clear_bed"}
    raise HTTPException(status_code=400, detail="Clear bed підтримується лише для SimplyPrint принтерів")


@router.post("/{printer_id}/print/skip-object")
async def print_skip_object(
    printer_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    """Skip the currently-printing object via EXCLUDE_OBJECT_CURRENT gcode.

    Works on any Klipper printer with [exclude_object] enabled in printer.cfg.
    SimplyPrint: sends gcode via the SP API (printer must be Klipper-based).
    Moonraker: calls the /printer/gcode/script endpoint directly.
    """
    row = _require_printer(printer_id, db)
    if row.kind == PrinterKind.simplyprint:
        # SimplyPrint's SkipObjects endpoint requires explicit object_ids from slicer
        # metadata — we don't have them at this point. Use the SimplyPrint panel directly
        # to skip objects, or switch to Moonraker/Klipper for this feature.
        raise HTTPException(
            status_code=501,
            detail="Скіп об'єктів через SimplyPrint вимагає ID об'єктів зі слайсера. "
                   "Скористайтесь панеллю SimplyPrint.",
        )
    if row.moonraker_url:
        try:
            await asyncio.to_thread(moonraker.skip_object, row.moonraker_url)
        except moonraker.MoonrakerError as e:
            raise HTTPException(status_code=502, detail=str(e))
        moonraker._status_cache.pop(row.moonraker_url, None)  # noqa: SLF001
        return {"ok": True, "action": "skip_object"}
    raise HTTPException(status_code=400, detail="Принтер не підтримує цю дію")
