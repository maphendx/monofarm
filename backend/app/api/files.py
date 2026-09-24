"""Central gcode file storage.

Files are stored on the server's filesystem under data/gcodes/<stored_name>.
The stored_name is a UUID-based filename to avoid collisions and path traversal.
From here, files can be pushed to any Moonraker printer via /send/{printer_id}.
"""
from __future__ import annotations

import time
import uuid
from collections import defaultdict, deque
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Body, Depends, HTTPException, Response, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session
from starlette.requests import Request

from app.api.deps import get_current_org, require_roles
from app.core.config import settings
from app.core.db import get_db
from app.models.gcode_file import GcodeFile
from app.services.auto_tag import auto_tag_file
from app.models.gcode_folder import GcodeFolder
from app.models.organization import Organization
from app.models.printer import Printer, PrinterKind
from app.models.printer_group import PrinterGroup
from app.models.user import User, UserRole
from app.schemas.bambu_jobs import BambuQueuedResult
from app.schemas.file_output import FileOutputOut, FileOutputSet
from app.schemas.tag import TagOut
from app.services import bambu, bambu_dispatch, bambu_lan_dispatch
from app.services import file_outputs
from app.services import moonraker as mr
from app.services import moonraker_dispatch
from app.services import storage as storage_svc
from app.services.bambu_mapping import build_ams_mapping
from app.workers import bambu_jobs as bambu_jobs_worker
from app.services.gcode_meta import extract_thumbnail, parse_gcode
from app.services.storage import LOCAL_DIR as GCODES_DIR  # kept for self-heal read

ALLOWED_EXTS = {".gcode", ".gco", ".g", ".3mf", ".bgcode"}
MAX_FILE_BYTES = 500 * 1024 * 1024  # 500 MB

router = APIRouter(prefix="/files", tags=["files"])
folders_router = APIRouter(prefix="/folders", tags=["folders"])

_BAMBU_SEND_LIMIT = 30
_BAMBU_SEND_WINDOW_SECONDS = 60
_bambu_send_hits: dict[str, deque[float]] = defaultdict(deque)


# ── Schemas ──────────────────────────────────────────────────────────────────

class FilamentMeta(BaseModel):
    types: list[str] | None = None
    colors: list[str] | None = None
    used_g: list[float] | None = None
    estimated_minutes: int | None = None
    total_layers: int | None = None
    layer_height: float | None = None
    nozzle_diameter: float | None = None
    print_size_x: float | None = None
    print_size_y: float | None = None
    print_size_z: float | None = None
    printer_model: str | None = None


class GcodeFileOut(BaseModel):
    id: int
    original_name: str
    stored_name: str
    size_bytes: int
    notes: str | None
    filament_meta: FilamentMeta | None
    has_thumbnail: bool
    uploaded_at: str
    uploaded_by_name: str | None
    folder_id: int | None
    assigned_group_id: int | None
    assigned_group_name: str | None
    tags: list[TagOut] = []
    output_warehouse_id: int | None = None
    outputs: list[FileOutputOut] = []

    model_config = {"from_attributes": True}


class GcodeFolderOut(BaseModel):
    id: int
    name: str
    file_count: int
    created_at: str

    model_config = {"from_attributes": True}


class FolderCreate(BaseModel):
    name: str


class FolderRename(BaseModel):
    name: str


class MoveFilePayload(BaseModel):
    folder_id: Optional[int] = None


class FileRename(BaseModel):
    name: str


class AssignGroupPayload(BaseModel):
    group_id: Optional[int] = None


class SendPayload(BaseModel):
    # slot_map: keys and values are 0-based slot indices, e.g. {"0": 1, "1": 0}
    # Only contains entries for filament slots actually used by the print.
    slot_map: dict[int, int] = {}
    # Snapmaker U1 print options. None = leave gcode as-is.
    auto_bed_leveling: bool | None = None
    timelapse: bool | None = None
    # Camera-based AI: DEFECT_DETECTION_* + DETECT_BED_PLATE
    ai_detection: bool | None = None
    # 0-based extruder indices to calibrate. None = leave SM_PRINT_FLOW_CALIBRATE
    # lines untouched; empty list = skip calibration on every slot.
    calibrate_slots: list[int] | None = None
    # Bambu flow (dynamics) calibration before print. None = firmware default (off).
    flow_calibration: bool | None = None
    # Bambu AMS selection. None = infer from the selected slot mapping.
    use_ams: bool | None = None
    # Optional link to a PrintTask — used for schedule eligibility guard.
    task_id: int | None = None
    # Exactly one physical slicer plate; None uses the first available plate.
    plate: int | None = Field(default=None, ge=1, le=1000)


class SendResult(BaseModel):
    ok: bool
    printer_name: str
    message: str


# ── Helpers ───────────────────────────────────────────────────────────────────

def _to_out(f: GcodeFile, db: Session, group_names: dict[int, str] | None = None) -> GcodeFileOut:
    name: str | None = None
    if f.uploaded_by_id:
        u = db.get(User, f.uploaded_by_id)
        name = u.name if u else None
    raw_meta = f.filament_meta or {}
    has_thumbnail = bool(raw_meta.get("has_thumbnail"))
    meta_fields = {k: v for k, v in raw_meta.items() if k != "has_thumbnail"}
    meta = FilamentMeta(**meta_fields) if meta_fields else None
    group_name: str | None = None
    if f.assigned_group_id:
        if group_names is not None:
            group_name = group_names.get(f.assigned_group_id)
        else:
            g = db.get(PrinterGroup, f.assigned_group_id)
            group_name = g.name if g else None
    return GcodeFileOut(
        id=f.id,
        original_name=f.original_name,
        stored_name=f.stored_name,
        size_bytes=f.size_bytes,
        notes=f.notes,
        filament_meta=meta,
        has_thumbnail=has_thumbnail,
        uploaded_at=f.uploaded_at.isoformat(),
        uploaded_by_name=name,
        folder_id=f.folder_id,
        assigned_group_id=f.assigned_group_id,
        assigned_group_name=group_name,
        tags=[TagOut(id=t.id, kind=t.kind, label=t.label, color=t.color, meta=t.meta, display=t.display) for t in (f.tags or [])],
        output_warehouse_id=f.output_warehouse_id,
        outputs=[
            FileOutputOut(
                product_id=o.product_id,
                product_name=f"{o.product.sku} · {o.product.name}" if o.product else None,
                qty_per_run=o.qty_per_run,
                plate=o.plate,
            )
            for o in (f.outputs or [])
        ],
    )


def _folder_to_out(folder: GcodeFolder, db: Session) -> GcodeFolderOut:
    file_count = (
        db.query(func.count(GcodeFile.id))
        .filter(GcodeFile.folder_id == folder.id)
        .scalar()
        or 0
    )
    return GcodeFolderOut(
        id=folder.id,
        name=folder.name,
        file_count=file_count,
        created_at=folder.created_at.isoformat(),
    )


# ── Folder endpoints ──────────────────────────────────────────────────────────

@folders_router.get("", response_model=list[GcodeFolderOut])
def list_folders(
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[GcodeFolderOut]:
    folders = (
        db.query(GcodeFolder)
        .filter(GcodeFolder.organization_id == org.id)
        .order_by(GcodeFolder.name)
        .all()
    )
    return [_folder_to_out(f, db) for f in folders]


@folders_router.post("", response_model=GcodeFolderOut, status_code=status.HTTP_201_CREATED)
def create_folder(
    payload: FolderCreate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator, UserRole.manager)),
) -> GcodeFolderOut:
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Назва папки не може бути порожньою")
    if len(name) > 255:
        raise HTTPException(status_code=400, detail="Назва папки занадто довга (макс 255 символів)")
    folder = GcodeFolder(organization_id=org.id, name=name)
    db.add(folder)
    db.commit()
    db.refresh(folder)
    return _folder_to_out(folder, db)


@folders_router.patch("/{folder_id}", response_model=GcodeFolderOut)
def rename_folder(
    folder_id: int,
    payload: FolderRename,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator, UserRole.manager)),
) -> GcodeFolderOut:
    folder = (
        db.query(GcodeFolder)
        .filter(GcodeFolder.id == folder_id, GcodeFolder.organization_id == org.id)
        .first()
    )
    if not folder:
        raise HTTPException(status_code=404, detail="Папку не знайдено")
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Назва папки не може бути порожньою")
    folder.name = name
    db.commit()
    db.refresh(folder)
    return _folder_to_out(folder, db)


@folders_router.delete("/{folder_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_folder(
    folder_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator, UserRole.manager)),
) -> None:
    folder = (
        db.query(GcodeFolder)
        .filter(GcodeFolder.id == folder_id, GcodeFolder.organization_id == org.id)
        .first()
    )
    if not folder:
        raise HTTPException(status_code=404, detail="Папку не знайдено")
    # Files in this folder move to root (folder_id → NULL) via ondelete SET NULL on FK
    db.delete(folder)
    db.commit()


# ── File endpoints ─────────────────────────────────────────────────────────────

@router.get("", response_model=list[GcodeFileOut])
def list_files(
    folder_id: int | None = None,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[GcodeFileOut]:
    q = db.query(GcodeFile).filter(GcodeFile.organization_id == org.id)
    if folder_id is not None:
        q = q.filter(GcodeFile.folder_id == folder_id)
    files = q.order_by(GcodeFile.uploaded_at.desc()).all()

    # Self-heal rows whose filament_meta was written by an older parser that
    # couldn't read comma-separated `filament used [g]` / `[m]` fields.
    # Without this we'd silently keep showing all slots as "used".
    from sqlalchemy.orm.attributes import flag_modified

    healed = False
    for f in files:
        meta = f.filament_meta or {}
        if meta.get("used_g") and meta.get("used_m"):
            continue
        path = GCODES_DIR / f.stored_name
        if not path.exists():
            continue
        try:
            parsed = parse_gcode(path)
        except Exception:
            continue
        patch: dict = {}
        if parsed.get("used_g") and not meta.get("used_g"):
            patch["used_g"] = parsed["used_g"]
        if parsed.get("used_m") and not meta.get("used_m"):
            patch["used_m"] = parsed["used_m"]
        if patch:
            f.filament_meta = {**meta, **patch}
            flag_modified(f, "filament_meta")
            healed = True
    if healed:
        db.commit()

    group_names = {
        g.id: g.name
        for g in db.query(PrinterGroup).filter(PrinterGroup.organization_id == org.id).all()
    }
    return [_to_out(f, db, group_names) for f in files]


@router.post("/upload", response_model=GcodeFileOut, status_code=status.HTTP_201_CREATED)
async def upload_file(
    file: UploadFile,
    folder_id: int | None = None,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    user: User = Depends(require_roles(UserRole.admin, UserRole.operator, UserRole.manager)),
) -> GcodeFileOut:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Немає імені файлу")

    # Preserve full suffix for .gcode.3mf (OrcaSlicer double extension)
    _p = Path(file.filename)
    ext = ("".join(_p.suffixes)).lower() if len(_p.suffixes) > 1 else _p.suffix.lower()
    if not any(ext.endswith(a) for a in ALLOWED_EXTS):
        raise HTTPException(
            status_code=400,
            detail=f"Дозволені формати: {', '.join(sorted(ALLOWED_EXTS))}",
        )

    # Validate folder belongs to org (if provided)
    if folder_id is not None:
        folder = (
            db.query(GcodeFolder)
            .filter(GcodeFolder.id == folder_id, GcodeFolder.organization_id == org.id)
            .first()
        )
        if not folder:
            raise HTTPException(status_code=404, detail="Папку не знайдено")

    contents = await file.read()
    if len(contents) > MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="Файл занадто великий (макс 500 МБ)")

    stored_name = f"{uuid.uuid4().hex}{ext}"

    # Parse metadata from a local copy before committing to final storage
    filament_meta: dict | None = None
    parse_path = GCODES_DIR / stored_name
    parse_path.write_bytes(contents)
    try:
        parsed = parse_gcode(parse_path)
        filament_meta = parsed if parsed else None
    except Exception:
        pass

    if ext.endswith(".3mf"):
        plate_gcode = bambu.plate_gcode_entry(contents)
        if plate_gcode:
            filament_meta = {**(filament_meta or {}), "bambu_plate_gcode": plate_gcode}

    # Extract preview (3mf plate render / gcode embedded thumbnail)
    thumb = extract_thumbnail(contents, ext)
    if thumb:
        storage_svc.put(stored_name + ".thumb.png", thumb, org.id)
        filament_meta = filament_meta or {}
        filament_meta["has_thumbnail"] = True

    # If S3 mode: upload to S3 and remove the local copy we just wrote for parsing
    if storage_svc.is_s3():
        try:
            storage_svc.put(stored_name, contents, org.id)
        finally:
            parse_path.unlink(missing_ok=True)

    row = GcodeFile(
        organization_id=org.id,
        stored_name=stored_name,
        original_name=file.filename,
        size_bytes=len(contents),
        filament_meta=filament_meta,
        uploaded_by_id=user.id,
        folder_id=folder_id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    try:
        auto_tag_file(db, org, row)
    except Exception:
        pass  # never block upload on tagging errors
    return _to_out(row, db)


@router.get("/{file_id}", response_model=GcodeFileOut)
def get_file(
    file_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> GcodeFileOut:
    row = (
        db.query(GcodeFile)
        .filter(GcodeFile.id == file_id, GcodeFile.organization_id == org.id)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Файл не знайдено")
    return _to_out(row, db)


@router.put("/{file_id}/outputs", response_model=GcodeFileOut)
def set_file_outputs(
    file_id: int,
    payload: FileOutputSet,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> GcodeFileOut:
    """Configure what one run of this file produces and where it is received."""
    from app.api.deps import require_warehouse_full

    require_warehouse_full(org)
    row = (
        db.query(GcodeFile)
        .filter(GcodeFile.id == file_id, GcodeFile.organization_id == org.id)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Файл не знайдено")
    file_outputs.set_file_outputs(db, org, row, payload)
    db.commit()
    db.refresh(row)
    return _to_out(row, db)


@router.patch("/{file_id}/move", response_model=GcodeFileOut)
def move_file(
    file_id: int,
    payload: MoveFilePayload,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator, UserRole.manager)),
) -> GcodeFileOut:
    row = db.query(GcodeFile).filter(GcodeFile.id == file_id, GcodeFile.organization_id == org.id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Файл не знайдено")

    if payload.folder_id is not None:
        folder = (
            db.query(GcodeFolder)
            .filter(GcodeFolder.id == payload.folder_id, GcodeFolder.organization_id == org.id)
            .first()
        )
        if not folder:
            raise HTTPException(status_code=404, detail="Папку не знайдено")

    row.folder_id = payload.folder_id
    db.commit()
    db.refresh(row)
    return _to_out(row, db)


@router.patch("/{file_id}/rename", response_model=GcodeFileOut)
def rename_file(
    file_id: int,
    payload: FileRename,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator, UserRole.manager)),
) -> GcodeFileOut:
    row = db.query(GcodeFile).filter(GcodeFile.id == file_id, GcodeFile.organization_id == org.id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Файл не знайдено")

    new_stem = payload.name.strip()
    if not new_stem:
        raise HTTPException(status_code=400, detail="Назва файлу не може бути порожньою")

    # Preserve the original extension (including double-extension .gcode.3mf) —
    # renaming must never change the file type, since it drives Bambu 3mf vs
    # Moonraker gcode dispatch logic downstream.
    _p = Path(row.original_name)
    ext = ("".join(_p.suffixes)) if len(_p.suffixes) > 1 else _p.suffix
    if ext and new_stem.lower().endswith(ext.lower()):
        new_stem = new_stem[: -len(ext)].strip()
    if not new_stem:
        raise HTTPException(status_code=400, detail="Назва файлу не може бути порожньою")

    new_name = f"{new_stem}{ext}"
    if len(new_name) > 255:
        raise HTTPException(status_code=400, detail="Назва файлу занадто довга (макс 255 символів)")

    row.original_name = new_name
    db.commit()
    db.refresh(row)
    return _to_out(row, db)


@router.patch("/{file_id}/assign-group", response_model=GcodeFileOut)
def assign_file_group(
    file_id: int,
    payload: AssignGroupPayload,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator, UserRole.manager)),
) -> GcodeFileOut:
    row = db.query(GcodeFile).filter(GcodeFile.id == file_id, GcodeFile.organization_id == org.id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Файл не знайдено")

    if payload.group_id is not None:
        group = (
            db.query(PrinterGroup)
            .filter(PrinterGroup.id == payload.group_id, PrinterGroup.organization_id == org.id)
            .first()
        )
        if not group:
            raise HTTPException(status_code=404, detail="Групу принтерів не знайдено")

    row.assigned_group_id = payload.group_id
    db.commit()
    db.refresh(row)
    return _to_out(row, db)


@router.delete("/{file_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_file(
    file_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator, UserRole.manager)),
) -> None:
    row = db.query(GcodeFile).filter(GcodeFile.id == file_id, GcodeFile.organization_id == org.id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Файл не знайдено")
    storage_svc.delete(row.stored_name, org.id)
    storage_svc.delete(row.stored_name + ".thumb.png", org.id)
    db.delete(row)
    db.commit()


@router.get("/{file_id}/download")
def download_file(
    file_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
):
    from fastapi.responses import RedirectResponse
    row = db.query(GcodeFile).filter(GcodeFile.id == file_id, GcodeFile.organization_id == org.id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Файл не знайдено")
    if storage_svc.is_s3():
        url = storage_svc.presigned_url(row.stored_name, org.id)
        if not url:
            raise HTTPException(status_code=404, detail="Файл відсутній в S3")
        return RedirectResponse(url)
    path = GCODES_DIR / row.stored_name
    if not path.exists():
        raise HTTPException(status_code=404, detail="Файл відсутній на диску")
    return FileResponse(path, filename=row.original_name)


@router.get("/{file_id}/thumbnail")
def get_thumbnail(
    file_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
):
    from fastapi.responses import RedirectResponse
    row = db.query(GcodeFile).filter(GcodeFile.id == file_id, GcodeFile.organization_id == org.id).first()
    if not row:
        raise HTTPException(status_code=404)
    thumb_name = row.stored_name + ".thumb.png"
    if storage_svc.is_s3():
        url = storage_svc.presigned_url(thumb_name, row.organization_id)
        if not url:
            raise HTTPException(status_code=404)
        return RedirectResponse(url, headers={"Cache-Control": "no-store"})
    path = GCODES_DIR / thumb_name
    if not path.exists():
        raise HTTPException(status_code=404)
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "no-store"})


@router.get("/{file_id}/plates/{plate}")
def get_plate_metadata(file_id: int, plate: int, db: Session = Depends(get_db), org: Organization = Depends(get_current_org)):
    from app.services.print_plates import plate_metadata
    file = db.query(GcodeFile).filter_by(id=file_id, organization_id=org.id).first()
    if not file:
        raise HTTPException(404, "Файл не знайдено")
    return plate_metadata(file, org.id, plate)


@router.get("/{file_id}/plates", response_model=list[int])
def list_file_plates(file_id: int, db: Session = Depends(get_db), org: Organization = Depends(get_current_org)):
    from app.services.print_plates import file_plates
    file = db.query(GcodeFile).filter_by(id=file_id, organization_id=org.id).first()
    if not file:
        raise HTTPException(404, "Файл не знайдено")
    return file_plates(file, org.id)


@router.get("/{file_id}/preflight")
def preflight_file(
    file_id: int,
    printer_id: int,
    plate: int | None = None,
    slot_map: str | None = None,
    use_ams: bool | None = None,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
):
    """Per-slot material availability for the send form (backend-authoritative)."""
    from app.services import filament_inventory

    file = db.query(GcodeFile).filter_by(id=file_id, organization_id=org.id).first()
    if not file:
        raise HTTPException(404, "Файл не знайдено")
    printer = db.query(Printer).filter_by(id=printer_id, organization_id=org.id).first()
    if not printer:
        raise HTTPException(404, "Принтер не знайдено")
    import json
    try:
        mapping = {int(k): int(v) for k, v in json.loads(slot_map or "{}").items()}
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(422, "Некоректна карта слотів")
    demand = filament_inventory.mapped_demand(db, org.id, file, printer, {"plate": plate, "slot_map": mapping, "use_ams": use_ams})
    rows = filament_inventory.preflight_for_print(db, org, printer, demand)
    return [
        {
            "slot_index": r.slot_index, "material": r.material,
            "spool_label": r.spool_label, "planned_g": r.planned_g,
            "required_g": round(r.required_g, 1), "remaining_g": r.remaining_g,
            "reserved_g": r.reserved_g, "available_g": r.available_g,
            "status": r.status, "reason": r.reason,
            "suggestions": [
                {"filament_id": c.filament_id, "label": c.label,
                 "grams_available": c.grams_available}
                for c in r.suggestions
            ],
        } for r in rows
    ]


@router.post("/{file_id}/send/{printer_id}", response_model=SendResult | BambuQueuedResult)
async def send_to_printer(
    request: Request,
    file_id: int,
    printer_id: int,
    response: Response,
    background_tasks: BackgroundTasks,
    payload: SendPayload = Body(default=SendPayload()),
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    user: User = Depends(require_roles(UserRole.admin, UserRole.operator, UserRole.manager)),
) -> SendResult | BambuQueuedResult:
    _ = request
    row = db.query(GcodeFile).filter(GcodeFile.id == file_id, GcodeFile.organization_id == org.id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Файл не знайдено")

    printer = db.query(Printer).filter(Printer.id == printer_id, Printer.organization_id == org.id).first()
    if not printer:
        raise HTTPException(status_code=404, detail="Принтер не знайдено")

    if not storage_svc.exists(row.stored_name, org.id):
        raise HTTPException(status_code=404, detail="Файл відсутній")

    if payload.plate is not None or row.outputs:
        from app.services.print_plates import file_plates
        plates = file_plates(row, org.id)
        if payload.plate is None:
            payload.plate = plates[0]
        if payload.plate not in plates:
            raise HTTPException(400, "Обрана пластина відсутня у файлі")

    # Pre-flight material check: backend-authoritative. Blocks dispatch only
    # when the org explicitly enabled enforcement (Налаштування → Загальне).
    preflight_report: list[dict] = []
    from app.services import filament_inventory
    try:
        demand = filament_inventory.mapped_demand(db, org.id, row, printer, payload.model_dump())
        if demand:
            preflight_rows = filament_inventory.preflight_for_print(db, org, printer, demand)
            preflight_report = [
                {
                    "slot_index": r.slot_index, "material": r.material,
                    "spool_label": r.spool_label, "planned_g": r.planned_g,
                    "required_g": round(r.required_g, 1), "remaining_g": r.remaining_g,
                    "reserved_g": r.reserved_g, "available_g": r.available_g,
                    "status": r.status, "reason": r.reason,
                    "suggestions": [
                        {"filament_id": c.filament_id, "label": c.label,
                         "grams_available": c.grams_available}
                        for c in r.suggestions
                    ],
                } for r in preflight_rows
            ]
            blocked = [r for r in preflight_report if r["status"] == "blocked"]
            if blocked and org.preflight_block_dispatch:
                detail = "; ".join(
                    f"Слот {r['slot_index'] + 1}: {r['reason']}" for r in blocked
                )
                raise HTTPException(409, f"Недостатньо матеріалу для запуску. {detail}")
    except HTTPException:
        raise
    except Exception:  # noqa: BLE001 — validation must never block dispatch on its own errors
        preflight_report = []
    output_plan = file_outputs.build_output_plan(db, org.id, row.id, task_id=payload.task_id, plate=payload.plate)
    if printer.kind != PrinterKind.bambu and row.original_name.lower().endswith(".3mf"):
        raise HTTPException(400, "Для Moonraker експортуйте вибрану пластину як G-code")

    if printer.kind == PrinterKind.snapmaker_u1:
        try:
            moonraker_dispatch.validate_moonraker_filename(printer.kind, row.original_name)
        except mr.MoonrakerError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    # Track last sent file so reprint is available from the dashboard
    printer.last_gcode_file_id = row.id
    db.commit()

    # ── Schedule eligibility guard ──────────────────────────────────────────
    # If the send is linked to a task that has a non-asap PlanEntry for today
    # on this printer, enforce the scheduling constraint before dispatching.
    if payload.task_id is not None:
        from datetime import date as _date, datetime as _dt, timezone as _tz
        from app.models.plan import PlanEntry as _PE
        from app.services.schedule_conflict import check_eligibility as _chk

        plan_entry = (
            db.query(_PE)
            .filter(
                _PE.organization_id == org.id,
                _PE.task_id == payload.task_id,
                _PE.printer_id == printer_id,
                _PE.plan_date == _date.today(),
                _PE.schedule_mode != "asap",
            )
            .first()
        )
        if plan_entry:
            eligible, reason = _chk(plan_entry, _dt.now(_tz.utc))
            if not eligible:
                _mode_msg = {
                    "not_before": f"Завдання запланване не раніше {plan_entry.start_time}",
                    "exact_time": f"Точний старт о {plan_entry.start_time}",
                    "window": "Завдання поза дозволеним часовим вікном",
                }
                raise HTTPException(
                    status_code=409,
                    detail=_mode_msg.get(
                        plan_entry.schedule_mode,
                        f"Завдання заблоковане: {reason}",
                    ),
                )

    # File bytes are only needed by the legacy synchronous Moonraker path —
    # queued dispatchers read from storage themselves, so don't download the
    # whole file here (S3 mode would pull it all into the request).
    # ── Bambu path: Cloud upload (Alibaba OSS) + Cloud task API ──
    if printer.kind == PrinterKind.bambu:
        _check_bambu_send_rate_limit(request, org.id)
        if not printer.bambu_dev_id:
            raise HTTPException(status_code=400, detail="У принтера немає Bambu dev_id")
        is_3mf = ".3mf" in Path(row.original_name).suffixes
        if not is_3mf:
            raise HTTPException(status_code=400, detail="Bambu Lab приймає лише .3mf файли")

        selected_meta = row.filament_meta
        if payload.plate is not None:
            from app.services.print_plates import plate_metadata
            selected_meta = plate_metadata(row, org.id, payload.plate)
        ams_mapping, detected_use_ams, mapping_details = build_ams_mapping(
            selected_meta, printer, payload.slot_map
        )
        configured_use_ams = printer.bambu_has_ams
        use_ams = (
            payload.use_ams
            if payload.use_ams is not None
            else configured_use_ams if configured_use_ams is not None else detected_use_ams
        )
        if not use_ams:
            ams_mapping = None
        # Prefer the hybrid path for every cloud-mode printer when the agent is
        # available: Bambu Cloud's cloud_file parser only handles Bambu-Studio
        # 3mf (OrcaSlicer files stay at 0 plates → no profileId → doomed task),
        # while agent FTPS + project_file works regardless of the slicer.
        hybrid_cloud_command = (
            not printer.bambu_lan_mode
            and printer.bambu_dev_ip
            and printer.bambu_access_code
            and bambu_lan_dispatch.has_agent_tunnel(org.id)
        )

        if printer.bambu_lan_mode or hybrid_cloud_command:
            if not printer.bambu_dev_ip or not printer.bambu_access_code:
                raise HTTPException(
                    status_code=400,
                    detail="Для Bambu LAN потрібні IP адреса та LAN Access Code",
                )
            # SimplyPrint-style path: agent uploads to the printer SD card over
            # FTPS, then project_file starts the local file. In LAN mode the
            # command goes through agent MQTT; in cloud mode it goes through
            # the existing Bambu cloud MQTT connection.
            start_via = "lan" if printer.bambu_lan_mode else "cloud"
            job = bambu_dispatch.create_cloud_job(
                db,
                org_id=org.id,
                printer_id=printer.id,
                printer_bambu_dev_id=printer.bambu_dev_id,
                gcode_file_id=row.id,
                file_name=row.original_name,
                created_by_user_id=user.id,
                dispatch_mode="lan",
                output_plan=output_plan,
                request_payload={
                    "source": "files.send_to_printer",
                    "plate": payload.plate,
                    "start_via": start_via,
                    "ams_mapping": ams_mapping if use_ams else None,
                    "use_ams": use_ams,
                    "slot_map": {str(k): v for k, v in payload.slot_map.items()},
                    "mapping_details": mapping_details,
                    "auto_bed_leveling": payload.auto_bed_leveling,
                    "flow_calibration": payload.flow_calibration,
                },
            )
            if job.file_size is None:
                job.file_size = row.size_bytes
                db.commit()
                db.refresh(job)

            background_tasks.add_task(bambu_lan_dispatch.dispatch_lan_job, job.id)
            response.status_code = status.HTTP_202_ACCEPTED
            return BambuQueuedResult(
                ok=True,
                printer_id=printer.id,
                printer_name=printer.name,
                dispatch_mode="lan" if printer.bambu_lan_mode else "cloud_lan_upload",
                message=(
                    "Файл заливається agent-ом на SD, команда старту йде через Bambu Cloud"
                    if hybrid_cloud_command
                    else "Файл відправляється на принтер через agent — друк запускається"
                ),
                job_id=job.id,
                status=job.status,
                correlation_id=job.correlation_id,
            )

        if not settings.BAMBU_CLOUD_V2_ENABLED:
            raise HTTPException(status_code=503, detail="Bambu Cloud job system is disabled")

        job = bambu_dispatch.create_cloud_job(
            db,
            org_id=org.id,
            printer_id=printer.id,
            printer_bambu_dev_id=printer.bambu_dev_id,
            gcode_file_id=row.id,
            file_name=row.original_name,
                region=org.bambu_region or None,
                created_by_user_id=user.id,
                output_plan=output_plan,
            request_payload={
                "source": "files.send_to_printer",
                "plate": payload.plate,
                "ams_mapping": ams_mapping if use_ams else None,
                "use_ams": use_ams,
                "slot_map": {str(k): v for k, v in payload.slot_map.items()},
                "mapping_details": mapping_details,
                "auto_bed_leveling": payload.auto_bed_leveling,
                "flow_calibration": payload.flow_calibration,
            },
        )
        if job.file_size is None:
            job.file_size = row.size_bytes
            db.commit()
            db.refresh(job)

        # Instant dispatch off the request thread — the worker poller is a
        # crash-recovery fallback (it skips jobs younger than its grace window).
        background_tasks.add_task(bambu_jobs_worker.run_bambu_cloud_job, job.id)
        response.status_code = status.HTTP_202_ACCEPTED
        return BambuQueuedResult(
            ok=True,
            printer_id=printer.id,
            printer_name=printer.name,
            message="Bambu Cloud print job queued",
            job_id=job.id,
            status=job.status,
            correlation_id=job.correlation_id,
        )

    # ── Moonraker path: optional gcode rewrite + upload + auto-start ──
    if not printer.moonraker_url:
        raise HTTPException(
            status_code=400,
            detail=f"Принтер '{printer.name}' не має Moonraker URL",
        )

    if settings.MOONRAKER_QUEUE_ENABLED or output_plan is not None:
        _check_bambu_send_rate_limit(request, org.id)
        job = bambu_dispatch.create_cloud_job(
            db,
            org_id=org.id,
            printer_id=printer.id,
            printer_bambu_dev_id=None,
            gcode_file_id=row.id,
            file_name=row.original_name,
            created_by_user_id=user.id,
            dispatch_mode="moonraker",
            output_plan=output_plan,
            request_payload={
                "source": "files.send_to_printer",
                "slot_map": {str(k): v for k, v in payload.slot_map.items()},
                "auto_bed_leveling": payload.auto_bed_leveling,
                "timelapse": payload.timelapse,
                "ai_detection": payload.ai_detection,
                "calibrate_slots": payload.calibrate_slots,
            },
        )
        if job.file_size is None:
            job.file_size = row.size_bytes
            db.commit()
            db.refresh(job)

        background_tasks.add_task(moonraker_dispatch.dispatch_moonraker_job, job.id)
        response.status_code = status.HTTP_202_ACCEPTED
        return BambuQueuedResult(
            ok=True,
            printer_id=printer.id,
            printer_name=printer.name,
            dispatch_mode="moonraker",
            message="Print job queued",
            job_id=job.id,
            status=job.status,
            correlation_id=job.correlation_id,
        )

    try:
        with storage_svc.local_path_for(row.stored_name, org.id) as src:
            await moonraker_dispatch.send_file_to_moonraker(
                org_id=org.id,
                moonraker_url=printer.moonraker_url,
                src=src,
                file_name=row.original_name,
                filament_meta=row.filament_meta or {},
                slot_map=payload.slot_map,
                printer_kind=printer.kind,
                auto_bed_leveling=payload.auto_bed_leveling,
                timelapse=payload.timelapse,
                ai_detection=payload.ai_detection,
                calibrate_slots=payload.calibrate_slots,
            )
        return SendResult(ok=True, printer_name=printer.name, message="Файл успішно надіслано — друк стартує")
    except mr.MoonrakerError as e:
        return SendResult(ok=False, printer_name=printer.name, message=str(e))


def _check_bambu_send_rate_limit(request: Request, org_id: int) -> None:
    forwarded = request.headers.get("x-forwarded-for", "")
    ip = forwarded.split(",")[0].strip() if forwarded else (request.client.host if request.client else "unknown")
    key = f"{org_id}:{ip}"
    now = time.monotonic()
    hits = _bambu_send_hits[key]
    while hits and now - hits[0] > _BAMBU_SEND_WINDOW_SECONDS:
        hits.popleft()
    if len(hits) >= _BAMBU_SEND_LIMIT:
        raise HTTPException(status_code=429, detail="Too many Bambu Cloud send requests")
    hits.append(now)
