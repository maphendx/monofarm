"""Central gcode file storage.

Files are stored on the server's filesystem under data/gcodes/<stored_name>.
The stored_name is a UUID-based filename to avoid collisions and path traversal.
From here, files can be pushed to any Moonraker printer via /send/{printer_id}.
"""
from __future__ import annotations

import asyncio
import tempfile
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, get_current_user, require_roles
from app.core.db import get_db
from app.models.gcode_file import GcodeFile
from app.models.gcode_folder import GcodeFolder
from app.models.organization import Organization
from app.models.printer import Printer, PrinterKind
from app.models.user import User, UserRole
from app.services import bambu as bambu_svc
from app.services import moonraker as mr
from app.services import storage as storage_svc
from app.services import tunnel as _tunnel
from app.services.gcode_meta import parse_gcode
from app.services.storage import LOCAL_DIR as GCODES_DIR  # kept for self-heal read

ALLOWED_EXTS = {".gcode", ".gco", ".g", ".3mf", ".bgcode"}
MAX_FILE_BYTES = 500 * 1024 * 1024  # 500 MB

router = APIRouter(prefix="/files", tags=["files"])
folders_router = APIRouter(prefix="/folders", tags=["folders"])


# ── Schemas ──────────────────────────────────────────────────────────────────

class FilamentMeta(BaseModel):
    types: list[str] | None = None
    colors: list[str] | None = None
    used_g: list[float] | None = None
    estimated_minutes: int | None = None
    total_layers: int | None = None
    layer_height: float | None = None


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


class SendResult(BaseModel):
    ok: bool
    printer_name: str
    message: str


# ── Helpers ───────────────────────────────────────────────────────────────────

def _to_out(f: GcodeFile, db: Session) -> GcodeFileOut:
    name: str | None = None
    if f.uploaded_by_id:
        u = db.get(User, f.uploaded_by_id)
        name = u.name if u else None
    raw_meta = f.filament_meta or {}
    has_thumbnail = bool(raw_meta.get("has_thumbnail"))
    meta_fields = {k: v for k, v in raw_meta.items() if k != "has_thumbnail"}
    meta = FilamentMeta(**meta_fields) if meta_fields else None
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

    return [_to_out(f, db) for f in files]


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

    # Extract thumbnail from .3mf ZIP
    if ".3mf" in ext:
        import io as _io
        import re as _re
        import zipfile as _zf
        try:
            with _zf.ZipFile(_io.BytesIO(contents)) as zf:
                namelist = zf.namelist()

                # Priority 1: high-quality combined preview thumbnails
                # (BambuStudio / OrcaSlicer write these for the whole job)
                fixed_candidates = [
                    "Metadata/thumbnail/thumbnail_400x400.png",
                    "Metadata/thumbnail/thumbnail_300x300.png",
                    "Metadata/thumbnail/thumbnail_600x600.png",
                    "Metadata/thumbnail.png",
                    "thumbnail.png",
                ]

                # Priority 2: plate thumbnails — sorted by plate number descending
                # so we pick the highest plate the user actually added content to.
                plate_files = sorted(
                    [n for n in namelist if _re.match(r"Metadata/plate_\d+\.png$", n, _re.IGNORECASE)],
                    key=lambda x: int(_re.search(r"\d+", x.split("/")[-1]).group()),
                    reverse=True,
                )

                for candidate in fixed_candidates + plate_files:
                    if candidate in namelist:
                        thumb = zf.read(candidate)
                        if not thumb:
                            continue  # skip zero-byte files
                        thumb_name = stored_name + ".thumb.png"
                        storage_svc.put(thumb_name, thumb, org.id)
                        filament_meta = filament_meta or {}
                        filament_meta["has_thumbnail"] = True
                        break
        except Exception:
            pass

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
def get_thumbnail(file_id: int, db: Session = Depends(get_db)):
    from fastapi.responses import RedirectResponse
    row = db.query(GcodeFile).filter(GcodeFile.id == file_id).first()
    if not row:
        raise HTTPException(status_code=404)
    thumb_name = row.stored_name + ".thumb.png"
    if storage_svc.is_s3():
        url = storage_svc.presigned_url(thumb_name, row.organization_id)
        if not url:
            raise HTTPException(status_code=404)
        return RedirectResponse(url)
    path = GCODES_DIR / thumb_name
    if not path.exists():
        raise HTTPException(status_code=404)
    return FileResponse(path, media_type="image/png")


@router.post("/{file_id}/send/{printer_id}", response_model=SendResult)
async def send_to_printer(
    file_id: int,
    printer_id: int,
    payload: SendPayload = Body(default=SendPayload()),
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator, UserRole.manager)),
) -> SendResult:
    row = db.query(GcodeFile).filter(GcodeFile.id == file_id, GcodeFile.organization_id == org.id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Файл не знайдено")

    printer = db.query(Printer).filter(Printer.id == printer_id, Printer.organization_id == org.id).first()
    if not printer:
        raise HTTPException(status_code=404, detail="Принтер не знайдено")

    try:
        _src_ctx = storage_svc.local_path_for(row.stored_name, org.id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Файл відсутній")

    with _src_ctx as src:
        # ── Bambu path: Cloud upload (Alibaba OSS) + Cloud task API ──
        if printer.kind == PrinterKind.bambu:
            if not printer.bambu_dev_id:
                raise HTTPException(status_code=400, detail="У принтера немає Bambu dev_id")
            is_3mf = ".3mf" in Path(row.original_name).suffixes
            if not is_3mf:
                raise HTTPException(status_code=400, detail="Bambu Lab приймає лише .3mf файли")

            # slot_map → ams_mapping list (Bambu format: [target_for_file_slot_0, ...]).
            # -1 marks unused slots so Bambu doesn't try to load them.
            meta = row.filament_meta or {}
            slot_count = max(len(meta.get("colors") or []), len(meta.get("types") or []), 1)
            used_g = meta.get("used_g") or []
            ams_mapping: list[int] = []
            for i in range(slot_count):
                g = used_g[i] if i < len(used_g) else None
                if g is not None and g <= 0:
                    ams_mapping.append(-1)
                else:
                    ams_mapping.append(payload.slot_map.get(i, i))
            use_ams = any(v >= 0 for v in ams_mapping)

            try:
                await asyncio.to_thread(
                    bambu_svc.cloud_upload_and_print,
                    org.id,
                    src.read_bytes(),
                    row.original_name,
                    printer.bambu_dev_id,
                    ams_mapping,
                    use_ams,
                )
                return SendResult(ok=True, printer_name=printer.name, message="Файл надіслано на Bambu")
            except (bambu_svc.BambuError, RuntimeError) as e:
                return SendResult(ok=False, printer_name=printer.name, message=str(e))

        # ── Moonraker path: optional gcode rewrite + upload + auto-start ──
        if not printer.moonraker_url:
            raise HTTPException(
                status_code=400,
                detail=f"Принтер '{printer.name}' не має Moonraker URL",
            )

        has_remap = any(k != v for k, v in payload.slot_map.items())
        calibrate_set = (
            set(payload.calibrate_slots) if payload.calibrate_slots is not None else None
        )

        meta = row.filament_meta or {}
        used_g = meta.get("used_g") or []
        slot_count = max(len(meta.get("colors") or []), len(meta.get("types") or []), 0)
        used_set: set[int] | None = None
        if used_g and slot_count:
            candidate = {i for i in range(slot_count) if i >= len(used_g) or used_g[i] > 0}
            if 0 < len(candidate) < slot_count:
                used_set = candidate

        has_options = (
            payload.auto_bed_leveling is not None
            or payload.timelapse is not None
            or payload.ai_detection is not None
            or used_set is not None
            or calibrate_set is not None
        )

        try:
            working: bytes | None = None
            if has_options:
                working = await asyncio.to_thread(
                    mr.apply_print_options,
                    src,
                    payload.auto_bed_leveling,
                    payload.timelapse,
                    payload.ai_detection,
                    used_set,
                    calibrate_set,
                )
            if has_remap:
                base = working if working is not None else src
                working = await asyncio.to_thread(mr.remap_slots, base, payload.slot_map)

            upload_bytes: bytes | None = working
            if upload_bytes is None and _tunnel.has_tunnel(org.id):
                upload_bytes = src.read_bytes()

            if _tunnel.has_tunnel(org.id):
                await _tunnel.send_moonraker_upload(
                    org.id,
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
            return SendResult(ok=True, printer_name=printer.name, message="Файл успішно надіслано — друк стартує")
        except mr.MoonrakerError as e:
            return SendResult(ok=False, printer_name=printer.name, message=str(e))
