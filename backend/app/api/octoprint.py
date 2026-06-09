"""OctoPrint-compatible API shim.

Allows OrcaSlicer (and any other OctoPrint-aware slicer) to upload gcode files
directly to this server.

── Generic (library-only upload): ───────────────────────────────────────────
  Host Type:  OctoPrint
  Hostname:   https://api.monofarm.app
  API Key:    <your API key from Settings>

── Auto-print to a specific printer: ────────────────────────────────────────
  Host Type:  OctoPrint
  Hostname:   https://api.monofarm.app/orca/{printer_id}
  API Key:    <your API key from Settings>

  Click "Send & Print" in OrcaSlicer — the file is uploaded, slots are
  auto-remapped by material type, and print starts immediately.

Implemented endpoints (minimal subset OrcaSlicer requires):
  GET  /api/version       — version handshake / connection test
  GET  /api/printer       — printer state (always "Operational")
  POST /api/files/local   — upload → stored in file library
  GET  /orca/{id}/api/version
  GET  /orca/{id}/api/printer
  POST /orca/{id}/api/files/local  — upload + auto-print to printer {id}
"""
from __future__ import annotations

import asyncio
import tempfile
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, Form, Header, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.db import get_db
from app.core.security import create_access_token, decode_token
from app.models.gcode_file import GcodeFile
from app.models.printer import Printer, PrinterKind
from app.models.printer_slot import PrinterSlot, SlotState
from app.models.user import User
from app.services import moonraker as mr
from app.services import storage as storage_svc
from app.services import tunnel as _tunnel
from app.services.gcode_meta import parse_gcode
from app.services.storage import LOCAL_DIR as GCODES_DIR

ALLOWED_EXTS = {".gcode", ".gco", ".g", ".3mf", ".bgcode"}
MAX_FILE_BYTES = 500 * 1024 * 1024

router = APIRouter(prefix="/api", tags=["octoprint"])
orca_router = APIRouter(tags=["octoprint"])


# ── Auth helper ───────────────────────────────────────────────────────────────

def _resolve_user(
    x_api_key: str | None,
    db: Session,
) -> User:
    """Accept OctoPrint-style X-Api-Key: scoped ApiKey (preferred) or JWT (legacy)."""
    if not x_api_key:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Missing API key")

    # Try scoped ApiKey first (mf_… prefix or any non-JWT value)
    if not x_api_key.startswith("eyJ"):
        from app.api.api_keys import resolve_api_key
        user = resolve_api_key(x_api_key, db)
        if user and user.is_active:
            return user
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid or expired API key")

    # Legacy path: raw JWT token
    payload = decode_token(x_api_key)
    if not payload:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid API key")
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid API key")
    user = db.get(User, int(user_id))
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="User inactive")
    return user


# ── Shared helpers ────────────────────────────────────────────────────────────

_OCTO_STATE = {
    "state": {
        "flags": {
            "operational": True, "printing": False, "paused": False,
            "ready": True, "error": False, "closedOrError": False,
            "finishing": False, "cancelling": False,
        },
        "text": "Operational",
    },
    "temperature": {
        "tool0": {"actual": 0.0, "target": 0.0, "offset": 0},
        "bed": {"actual": 0.0, "target": 0.0, "offset": 0},
    },
}

_OCTO_VERSION = {
    "api": "0.1",
    "server": "1.3.0",
    "text": "OctoPrint 1.3.0 (monofarm shim)",
}


def _auto_slot_map(
    file_meta: dict | None,
    slots: list[PrinterSlot],
) -> dict[int, int]:
    """Build slot_map by matching file material types to loaded printer slots.

    Returns only entries where file_slot != printer_slot (non-identity remaps).
    """
    if not file_meta:
        return {}
    file_types = [t.upper() for t in (file_meta.get("types") or [])]
    if not file_types:
        return {}

    # Group loaded slots by material (preserving order for deterministic matching)
    avail: dict[str, list[int]] = {}
    for s in sorted(slots, key=lambda s: s.slot_index):
        if s.state == SlotState.loaded and s.material:
            avail.setdefault(s.material.upper(), []).append(s.slot_index)

    slot_map: dict[int, int] = {}
    used: set[int] = set()
    for fi, mat in enumerate(file_types):
        candidates = [s for s in avail.get(mat, []) if s not in used]
        if candidates:
            pi = candidates[0]
            if fi != pi:
                slot_map[fi] = pi
            used.add(pi)

    return slot_map


async def _store_file(file: UploadFile, org_id: int, db: Session, uploaded_by_id: int | None = None) -> GcodeFile:
    """Validate, persist bytes, parse meta, and commit a GcodeFile row."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename")

    _p = Path(file.filename)
    ext = ("".join(_p.suffixes)).lower() if len(_p.suffixes) > 1 else _p.suffix.lower()
    if not any(ext.endswith(a) for a in ALLOWED_EXTS):
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {ext}")

    contents = await file.read()
    if len(contents) > MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="File too large")

    stored_name = f"{uuid.uuid4().hex}{ext}"
    parse_path = GCODES_DIR / stored_name
    parse_path.write_bytes(contents)
    filament_meta: dict | None = None
    try:
        parsed = parse_gcode(parse_path)
        filament_meta = parsed if parsed else None
    except Exception:
        pass
    if storage_svc.is_s3():
        try:
            storage_svc.put(stored_name, contents, org_id)
        finally:
            parse_path.unlink(missing_ok=True)

    row = GcodeFile(
        organization_id=org_id,
        stored_name=stored_name,
        original_name=file.filename,
        size_bytes=len(contents),
        filament_meta=filament_meta,
        uploaded_by_id=uploaded_by_id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


async def _autoprint_moonraker(
    printer: Printer,
    row: GcodeFile,
    slot_map: dict[int, int],
    org_id: int,
) -> None:
    """Upload (with optional remap) and start print on a Moonraker printer."""
    if not printer.moonraker_url:
        return

    has_remap = bool(slot_map)
    with storage_svc.local_path_for(row.stored_name, org_id) as src:
        working: bytes | None = None
        if has_remap:
            working = await asyncio.to_thread(mr.remap_slots, src, slot_map)

        upload_bytes: bytes | None = working
        if upload_bytes is None and _tunnel.has_tunnel(org_id):
            upload_bytes = src.read_bytes()

        if _tunnel.has_tunnel(org_id):
            await _tunnel.send_moonraker_upload(
                org_id,
                printer.moonraker_url,
                row.original_name,
                upload_bytes,  # type: ignore[arg-type]
                start_print=True,
            )
        elif working is not None:
            with tempfile.NamedTemporaryFile(suffix=src.suffix, delete=False) as tmp:
                tmp.write(working)
                tmp_path = Path(tmp.name)
            try:
                await asyncio.to_thread(
                    mr.upload_gcode,
                    printer.moonraker_url,
                    tmp_path,
                    row.original_name,
                    start_print=True,
                )
            finally:
                tmp_path.unlink(missing_ok=True)
        else:
            await asyncio.to_thread(
                mr.upload_gcode,
                printer.moonraker_url,
                src,
                row.original_name,
                start_print=True,
            )


def _build_response(row: GcodeFile, user: User) -> dict:
    """Build the OctoPrint upload response with an authenticated webview URL.

    OrcaSlicer opens `url` in the Device tab webview after upload.
    We route through /auth/webview so the JWT is stored before the
    auth guard on /files runs.
    """
    from urllib.parse import quote

    frontend = settings.FARM_PUBLIC_URL.rstrip("/")
    backend = settings.FARM_PUBLIC_URL.rstrip("/")

    # Short-lived token (15 min) for the webview session
    wv_token = create_access_token(str(user.id), user.role.value, user.organization_id)
    next_url = quote(f"/files?highlight={row.id}", safe="")
    webview_url = f"{frontend}/auth/webview?token={wv_token}&next={next_url}"

    return {
        "done": True,
        "files": {
            "local": {
                "name": row.original_name,
                "origin": "local",
                "path": row.original_name,
                "refs": {
                    "download": f"{backend}/api/files/{row.id}/download",
                    "resource": webview_url,
                },
            }
        },
        "url": webview_url,
    }


# ── Generic OctoPrint endpoints (/api/...) ────────────────────────────────────

@router.get("/version")
def octo_version() -> dict:
    return _OCTO_VERSION


@router.get("/printer")
def octo_printer(
    x_api_key: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    _resolve_user(x_api_key, db)
    return _OCTO_STATE


@router.post("/files/local", status_code=status.HTTP_201_CREATED)
async def octo_upload(
    file: UploadFile,
    x_api_key: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    """Upload to file library only (no auto-print). Use /orca/{id}/... for auto-print."""
    user = _resolve_user(x_api_key, db)
    row = await _store_file(file, user.organization_id, db, uploaded_by_id=user.id)
    return _build_response(row, user)


# ── Printer-scoped OctoPrint endpoints (/orca/{printer_id}/api/...) ───────────
# Configure OrcaSlicer: Hostname = https://api.monofarm.app/orca/{printer_id}

@orca_router.get("/orca/{printer_id}/api/version")
def orca_version(printer_id: int) -> dict:
    return _OCTO_VERSION


@orca_router.get("/orca/{printer_id}/api/printer")
def orca_printer(
    printer_id: int,
    x_api_key: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    _resolve_user(x_api_key, db)
    return _OCTO_STATE


@orca_router.post("/orca/{printer_id}/api/files/local", status_code=status.HTTP_201_CREATED)
async def orca_upload(
    printer_id: int,
    file: UploadFile,
    # OrcaSlicer sends print=true when the user clicks "Send & Print"
    print: str | None = Form(default=None),
    x_api_key: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    """Upload + auto-print to the specified printer.

    Slot remapping is automatic: file material types are matched to loaded
    printer slots by material name (case-insensitive).
    """
    user = _resolve_user(x_api_key, db)
    row = await _store_file(file, user.organization_id, db, uploaded_by_id=user.id)

    if print == "true":
        printer = (
            db.query(Printer)
            .filter(Printer.id == printer_id, Printer.organization_id == user.organization_id)
            .first()
        )
        if printer and printer.kind != PrinterKind.bambu:
            slots = db.query(PrinterSlot).filter_by(printer_id=printer_id).all()
            slot_map = _auto_slot_map(row.filament_meta, slots)
            try:
                await _autoprint_moonraker(printer, row, slot_map, user.organization_id)
            except Exception:
                pass  # file is stored — don't fail the upload response

    return _build_response(row, user)
