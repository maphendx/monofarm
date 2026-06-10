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
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session
from starlette.requests import Request

from app.api.deps import get_current_org, require_roles
from app.core.config import settings
from app.core.db import get_db
from app.models.gcode_file import GcodeFile
from app.models.gcode_folder import GcodeFolder
from app.models.organization import Organization
from app.models.printer import Printer, PrinterKind
from app.models.user import User, UserRole
from app.schemas.bambu_jobs import BambuQueuedResult
from app.services import bambu_dispatch
from app.services import moonraker as mr
from app.services import moonraker_dispatch
from app.services import storage as storage_svc
from app.workers import bambu_jobs as bambu_jobs_worker
from app.services.gcode_meta import parse_gcode
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
    # Optional link to a PrintTask — used for schedule eligibility guard.
    task_id: int | None = None


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
        if not settings.BAMBU_CLOUD_V2_ENABLED:
            raise HTTPException(status_code=503, detail="Bambu Cloud job system is disabled")
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

        job = bambu_dispatch.create_cloud_job(
            db,
            org_id=org.id,
            printer_id=printer.id,
            printer_bambu_dev_id=printer.bambu_dev_id,
            gcode_file_id=row.id,
            file_name=row.original_name,
            region=org.bambu_region or None,
            created_by_user_id=user.id,
            request_payload={
                "source": "files.send_to_printer",
                "ams_mapping": ams_mapping,
                "use_ams": use_ams,
                "slot_map": {str(k): v for k, v in payload.slot_map.items()},
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

    if settings.MOONRAKER_QUEUE_ENABLED:
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
