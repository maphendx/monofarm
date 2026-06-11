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

from fastapi import APIRouter, BackgroundTasks, Depends, Form, Header, HTTPException, Request, Response, UploadFile, status
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
from app.services.gcode_meta import extract_thumbnail, parse_gcode
from app.services.storage import LOCAL_DIR as GCODES_DIR

ALLOWED_EXTS = {".gcode", ".gco", ".g", ".3mf", ".bgcode"}
MAX_FILE_BYTES = 500 * 1024 * 1024

router = APIRouter(prefix="/api", tags=["octoprint"])
orca_router = APIRouter(tags=["octoprint"])
moonraker_router = APIRouter(tags=["moonraker-compat"])


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


def _resolve_slicer_user(
    x_api_key: str | None,
    authorization: str | None,
    db: Session,
) -> User:
    """Accept OrcaSlicer auth from either OctoPrint or Klipper host modes."""
    token = x_api_key
    if not token and authorization:
        scheme, _, value = authorization.partition(" ")
        token = value if scheme.lower() == "bearer" else authorization
    return _resolve_user(token, db)


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
    # Slicer uploads (OrcaSlicer shim) get the same preview as browser uploads
    thumb = extract_thumbnail(contents, ext)
    if thumb:
        storage_svc.put(stored_name + ".thumb.png", thumb, org_id)
        filament_meta = filament_meta or {}
        filament_meta["has_thumbnail"] = True
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


def _build_response(row: GcodeFile, user: User, next_path: str | None = None) -> dict:
    """Build the OctoPrint upload response with an authenticated webview URL.

    OrcaSlicer opens `url` in the Device tab webview after upload.
    We route through /auth/webview so the JWT is stored before the auth guard
    on the target app route runs.
    """
    from urllib.parse import quote

    frontend = settings.FARM_PUBLIC_URL.rstrip("/")
    backend = settings.FARM_PUBLIC_URL.rstrip("/")

    # Short-lived token (15 min) for the webview session
    wv_token = create_access_token(str(user.id), user.role.value, user.organization_id)
    next_url = quote(next_path or f"/files?highlight={row.id}", safe="")
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


def _dashboard_slicer_path(row: GcodeFile, printer_id: int | None = None) -> str:
    suffix = f"&printer={printer_id}" if printer_id is not None else ""
    return f"/dashboard?slicerFile={row.id}&slicerAction=choose{suffix}"


def _set_slicer_redirect_cookie(
    response: Response,
    row: GcodeFile,
    user: User,
    next_path: str | None = None,
) -> None:
    """Remember the just-uploaded file for Orca's Device tab base-url load."""
    from urllib.parse import quote

    webview_url = _build_response(row, user, next_path=next_path)["url"]
    response.set_cookie(
        "monofarm_slicer_next",
        quote(webview_url, safe=""),
        max_age=15 * 60,
        httponly=True,
        secure=settings.FARM_PUBLIC_URL.startswith("https://"),
        samesite="lax",
        path="/",
    )


def _moonraker_upload_response(
    row: GcodeFile,
    user: User,
    print_requested: bool,
    next_path: str | None = None,
) -> dict:
    """Build a Moonraker-shaped upload response for Orca Klipper host mode."""
    response = _build_response(row, user, next_path=next_path)
    return {
        "item": {
            "path": row.original_name,
            "root": "gcodes",
            "size": row.size_bytes,
            "permissions": "rw",
        },
        "print_started": False,
        "print_queued": False,
        "action": "create_file",
        "monofarm": {
            "file_id": row.id,
            "print_requested": print_requested,
            "url": response["url"],
        },
        "url": response["url"],
    }


def _resolve_scoped_printer(printer_id: int | None, user: User, db: Session) -> Printer | None:
    if printer_id is None:
        return None
    printer = (
        db.query(Printer)
        .filter(Printer.id == printer_id, Printer.organization_id == user.organization_id)
        .first()
    )
    if not printer:
        raise HTTPException(status_code=404, detail="Printer not found")
    return printer


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
    response: Response,
    file: UploadFile,
    x_api_key: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    """Upload to file library only (no auto-print). Use /orca/{id}/... for auto-print."""
    user = _resolve_user(x_api_key, db)
    row = await _store_file(file, user.organization_id, db, uploaded_by_id=user.id)
    _set_slicer_redirect_cookie(response, row, user)
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
    response: Response,
    file: UploadFile,
    background_tasks: BackgroundTasks,
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
    _set_slicer_redirect_cookie(response, row, user)

    if print == "true":
        printer = (
            db.query(Printer)
            .filter(Printer.id == printer_id, Printer.organization_id == user.organization_id)
            .first()
        )
        if printer:
            if printer.kind == PrinterKind.bambu:
                if settings.BAMBU_CLOUD_V2_ENABLED and printer.bambu_dev_id:
                    is_3mf = ".3mf" in Path(row.original_name).suffixes
                    if is_3mf:
                        try:
                            from app.models.organization import Organization
                            from app.services import bambu_dispatch
                            from app.workers.bambu_jobs import run_bambu_cloud_job
                            org = db.get(Organization, user.organization_id)
                            job = bambu_dispatch.create_cloud_job(
                                db,
                                org_id=user.organization_id,
                                printer_id=printer.id,
                                printer_bambu_dev_id=printer.bambu_dev_id,
                                gcode_file_id=row.id,
                                file_name=row.original_name,
                                region=org.bambu_region if org else None,
                                created_by_user_id=user.id,
                                request_payload={"source": "orca.auto_print"},
                            )
                            background_tasks.add_task(run_bambu_cloud_job, job.id)
                        except Exception:
                            pass  # file is stored — don't fail the upload response
            else:
                slots = db.query(PrinterSlot).filter_by(printer_id=printer_id).all()
                slot_map = _auto_slot_map(row.filament_meta, slots)
                try:
                    await _autoprint_moonraker(printer, row, slot_map, user.organization_id)
                except Exception:
                    pass  # file is stored — don't fail the upload response

    return _build_response(row, user)


# ── Moonraker-compatible endpoints for Orca Klipper host mode ─────────────────
# Configure OrcaSlicer: Host Type = Klipper/Moonraker, URL = https://api...

@moonraker_router.get("/server/info")
@moonraker_router.get("/orca/{printer_id}/server/info")
def moonraker_server_info(printer_id: int | None = None) -> dict:
    _ = printer_id
    return {
        "result": {
            "klippy_connected": True,
            "klippy_state": "ready",
            "components": ["server", "file_manager", "octoprint_compat"],
            "failed_components": [],
            "registered_directories": ["gcodes"],
            "warnings": [],
            "websocket_count": 0,
            "moonraker_version": "monofarm-shim",
            "api_version": [1, 0, 0],
            "api_version_string": "1.0.0",
        }
    }


@moonraker_router.get("/printer/info")
@moonraker_router.get("/orca/{printer_id}/printer/info")
def moonraker_printer_info(
    printer_id: int | None = None,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    user = _resolve_slicer_user(x_api_key, authorization, db)
    _resolve_scoped_printer(printer_id, user, db)
    return {"result": {"state": "ready", "state_message": "Monofarm upload shim ready"}}


@moonraker_router.get("/access/oneshot_token")
@moonraker_router.get("/orca/{printer_id}/access/oneshot_token")
def moonraker_oneshot_token(
    printer_id: int | None = None,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    user = _resolve_slicer_user(x_api_key, authorization, db)
    _resolve_scoped_printer(printer_id, user, db)
    return {"result": "monofarm"}


@moonraker_router.get("/server/files/roots")
@moonraker_router.get("/orca/{printer_id}/server/files/roots")
def moonraker_file_roots(
    printer_id: int | None = None,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    user = _resolve_slicer_user(x_api_key, authorization, db)
    _resolve_scoped_printer(printer_id, user, db)
    return {"result": [{"name": "gcodes", "path": "gcodes", "permissions": "rw"}]}


@moonraker_router.get("/server/files/list")
@moonraker_router.get("/orca/{printer_id}/server/files/list")
def moonraker_file_list(
    printer_id: int | None = None,
    root: str = "gcodes",
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    if root != "gcodes":
        raise HTTPException(status_code=400, detail="Only gcodes root is supported")
    user = _resolve_slicer_user(x_api_key, authorization, db)
    _resolve_scoped_printer(printer_id, user, db)
    return {"result": []}


@moonraker_router.get("/server/webcams/list")
@moonraker_router.get("/orca/{printer_id}/server/webcams/list")
def moonraker_webcams_list(
    printer_id: int | None = None,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    user = _resolve_slicer_user(x_api_key, authorization, db)
    _resolve_scoped_printer(printer_id, user, db)
    return {"result": {"webcams": []}}


@moonraker_router.get("/printer/objects/list")
@moonraker_router.get("/orca/{printer_id}/printer/objects/list")
def moonraker_objects_list(
    printer_id: int | None = None,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    user = _resolve_slicer_user(x_api_key, authorization, db)
    _resolve_scoped_printer(printer_id, user, db)
    return {
        "result": {
            "objects": [
                "webhooks",
                "print_stats",
                "virtual_sdcard",
                "display_status",
                "toolhead",
                "extruder",
                "heater_bed",
                "pause_resume",
                "idle_timeout",
            ]
        }
    }


def _moonraker_object_status() -> dict:
    return {
        "webhooks": {"state": "ready", "state_message": "Monofarm upload shim ready"},
        "print_stats": {
            "state": "standby",
            "filename": "",
            "message": "",
            "print_duration": 0,
            "total_duration": 0,
            "filament_used": 0,
        },
        "virtual_sdcard": {"progress": 0, "is_active": False, "file_position": 0},
        "display_status": {"progress": 0, "message": None},
        "toolhead": {"homed_axes": "", "position": [0, 0, 0, 0], "estimated_print_time": 0},
        "extruder": {"temperature": 0, "target": 0, "power": 0},
        "heater_bed": {"temperature": 0, "target": 0, "power": 0},
        "pause_resume": {"is_paused": False},
        "idle_timeout": {"state": "Ready", "printing_time": 0},
    }


@moonraker_router.get("/printer/objects/query")
@moonraker_router.get("/orca/{printer_id}/printer/objects/query")
def moonraker_objects_query(
    request: Request,
    printer_id: int | None = None,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    user = _resolve_slicer_user(x_api_key, authorization, db)
    _resolve_scoped_printer(printer_id, user, db)
    requested = set(request.query_params.keys())
    all_status = _moonraker_object_status()
    status_out = {k: v for k, v in all_status.items() if not requested or k in requested}
    return {"result": {"eventtime": 0, "status": status_out}}


@moonraker_router.post("/server/files/upload", status_code=status.HTTP_201_CREATED)
@moonraker_router.post("/orca/{printer_id}/server/files/upload", status_code=status.HTTP_201_CREATED)
async def moonraker_upload(
    response: Response,
    file: UploadFile,
    printer_id: int | None = None,
    root: str = Form(default="gcodes"),
    path: str | None = Form(default=None),
    print: str | None = Form(default=None),
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    """Receive Orca Klipper/Moonraker uploads and store them in Monofarm.

    Orca's Klipper host mode posts here instead of OctoPrint's /api/files/local.
    Monofarm still stores the file in the library; choosing the target printer
    and slot remap happens in the Monofarm UI.
    """
    if root != "gcodes":
        raise HTTPException(status_code=400, detail="Only gcodes root is supported")
    _ = path
    user = _resolve_slicer_user(x_api_key, authorization, db)
    printer = _resolve_scoped_printer(printer_id, user, db)
    row = await _store_file(file, user.organization_id, db, uploaded_by_id=user.id)
    next_path = _dashboard_slicer_path(row, printer.id if printer else None)
    _set_slicer_redirect_cookie(response, row, user, next_path=next_path)
    from urllib.parse import quote

    response.headers["Location"] = f"/server/files/gcodes/{quote(row.original_name)}"
    return _moonraker_upload_response(row, user, print_requested=print == "true", next_path=next_path)
