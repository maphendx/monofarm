"""Printer endpoints.

Strategy: DB stores persistent printer rows (name, kind, sp_printer_id, manual state).
SimplyPrint live state is fetched on demand (with a 30s in-memory cache) and merged
with DB rows. Unknown sp_printer_ids are auto-imported as new rows on first sync.
"""
import asyncio
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_roles
from app.core.db import get_db
from app.models.printer import Printer, PrinterKind
from app.models.user import User, UserRole
from app.schemas.printer import (
    PrinterCreate,
    PrinterManualUpdate,
    PrinterOut,
    PrinterUpdate,
)
from app.services import moonraker, simplyprint


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


def _to_dto(printer: Printer, sp_state: dict | None) -> PrinterOut:
    base = dict(
        id=printer.id,
        name=printer.name,
        kind=printer.kind,
        sp_printer_id=printer.sp_printer_id,
        moonraker_url=printer.moonraker_url,
        is_active=printer.is_active,
    )
    if printer.kind == PrinterKind.simplyprint and sp_state:
        return PrinterOut(
            **base,
            state=sp_state["state"],
            flags=sp_state.get("flags", []),
            source="simplyprint",
        )
    if printer.kind == PrinterKind.simplyprint:
        return PrinterOut(**base, state="unknown", flags=[], source="unknown")

    # Manual (U1, other) — if Moonraker URL is set, prefer live data
    if printer.moonraker_url:
        live = moonraker.get_live_status(printer.moonraker_url)
        return PrinterOut(
            **base,
            state=live.get("state") or "unknown",
            flags=[],
            job=live.get("filename") or printer.manual_job,
            eta_minutes=live.get("eta_minutes"),
            updated_at=printer.manual_updated_at,
            source="moonraker",
            progress_pct=live.get("progress_pct"),
            extruder_temp=live.get("extruder_temp"),
            extruder_target=live.get("extruder_target"),
            bed_temp=live.get("bed_temp"),
            bed_target=live.get("bed_target"),
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


@router.get("", response_model=list[PrinterOut])
def list_printers(
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[PrinterOut]:
    overview = simplyprint.get_farm_overview()
    sp_printers = simplyprint.extract_printers(overview)
    sp_rows = _ensure_simplyprint_rows(db, sp_printers)

    sp_state_by_id = {str(p["id"]): p for p in sp_printers}

    rows = db.query(Printer).filter(Printer.is_active.is_(True)).order_by(Printer.kind, Printer.name).all()
    out: list[PrinterOut] = []
    for row in rows:
        sp_state = sp_state_by_id.get(row.sp_printer_id) if row.sp_printer_id else None
        out.append(_to_dto(row, sp_state))
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
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_dto(row, None)


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
        # Empty string clears the URL
        row.moonraker_url = payload.moonraker_url.strip() or None
    db.commit()
    db.refresh(row)
    return _to_dto(row, None)


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
    return _to_dto(row, None)


@router.post("/sync", response_model=list[PrinterOut])
def force_sync(
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> list[PrinterOut]:
    overview = simplyprint.get_farm_overview(force=True)
    sp_printers = simplyprint.extract_printers(overview)
    _ensure_simplyprint_rows(db, sp_printers)
    return list_printers(db=db, _user=_user)  # type: ignore[arg-type]


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
