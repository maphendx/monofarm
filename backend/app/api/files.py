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

from fastapi import APIRouter, Body, Depends, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, get_current_user, require_roles
from app.core.db import get_db
from app.models.gcode_file import GcodeFile
from app.models.organization import Organization
from app.models.printer import Printer, PrinterKind
from app.models.user import User, UserRole
from app.services import bambu as bambu_svc
from app.services import moonraker as mr
from app.services.gcode_meta import parse_gcode


GCODES_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "gcodes"
GCODES_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_EXTS = {".gcode", ".gco", ".g", ".3mf", ".bgcode"}
MAX_FILE_BYTES = 500 * 1024 * 1024  # 500 MB

router = APIRouter(prefix="/files", tags=["files"])


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
    uploaded_at: str
    uploaded_by_name: str | None

    model_config = {"from_attributes": True}


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
    meta = FilamentMeta(**f.filament_meta) if f.filament_meta else None
    return GcodeFileOut(
        id=f.id,
        original_name=f.original_name,
        stored_name=f.stored_name,
        size_bytes=f.size_bytes,
        notes=f.notes,
        filament_meta=meta,
        uploaded_at=f.uploaded_at.isoformat(),
        uploaded_by_name=name,
    )


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("", response_model=list[GcodeFileOut])
def list_files(
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[GcodeFileOut]:
    files = db.query(GcodeFile).filter(GcodeFile.organization_id == org.id).order_by(GcodeFile.uploaded_at.desc()).all()

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

    contents = await file.read()
    if len(contents) > MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="Файл занадто великий (макс 500 МБ)")

    stored_name = f"{uuid.uuid4().hex}{ext}"
    dest = GCODES_DIR / stored_name
    dest.write_bytes(contents)

    # Parse filament metadata from the gcode file (best-effort, non-blocking)
    filament_meta: dict | None = None
    try:
        parsed = parse_gcode(dest)
        filament_meta = parsed if parsed else None
    except Exception:
        pass

    row = GcodeFile(
        organization_id=org.id,
        stored_name=stored_name,
        original_name=file.filename,
        size_bytes=len(contents),
        filament_meta=filament_meta,
        uploaded_by_id=user.id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_out(row, db)


@router.delete("/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_file(
    file_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator, UserRole.manager)),
) -> None:
    row = db.query(GcodeFile).filter(GcodeFile.id == file_id, GcodeFile.organization_id == org.id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Файл не знайдено")
    path = GCODES_DIR / row.stored_name
    path.unlink(missing_ok=True)
    db.delete(row)
    db.commit()


@router.get("/{file_id}/download")
def download_file(
    file_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> FileResponse:
    row = db.query(GcodeFile).filter(GcodeFile.id == file_id, GcodeFile.organization_id == org.id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Файл не знайдено")
    path = GCODES_DIR / row.stored_name
    if not path.exists():
        raise HTTPException(status_code=404, detail="Файл відсутній на диску")
    return FileResponse(path, filename=row.original_name)


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

    src = GCODES_DIR / row.stored_name
    if not src.exists():
        raise HTTPException(status_code=404, detail="Файл відсутній на диску")

    # ── Bambu path: FTPS upload + MQTT start command ──
    if printer.kind == PrinterKind.bambu:
        if not printer.bambu_dev_id:
            raise HTTPException(status_code=400, detail="У принтера немає Bambu dev_id")
        if not printer.bambu_access_code or not printer.bambu_dev_ip:
            raise HTTPException(
                status_code=400,
                detail=f"Принтер '{printer.name}': відсутній access_code або LAN IP для FTPS",
            )
        is_3mf = ".3mf" in Path(row.original_name).suffixes
        if not is_3mf:
            raise HTTPException(
                status_code=400,
                detail="Bambu Lab приймає лише .3mf файли",
            )

        # slot_map → ams_mapping list (Bambu format: [target_for_file_slot_0, ...]).
        # -1 marks unused slots so Bambu doesn't try to load them.
        meta = row.filament_meta or {}
        slot_count = max(
            len(meta.get("colors") or []),
            len(meta.get("types") or []),
            1,
        )
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
            ftp_name = await asyncio.to_thread(
                bambu_svc.upload_3mf,
                printer.bambu_dev_ip,
                printer.bambu_access_code,
                src,
                row.original_name,
            )
            await asyncio.to_thread(
                bambu_svc.start_print,
                printer.bambu_dev_id,
                ftp_name,
                row.original_name,
                ams_mapping,
                use_ams,
            )
            return SendResult(ok=True, printer_name=printer.name, message="Файл надіслано на Bambu")
        except bambu_svc.BambuError as e:
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

    # Auto-derive which filament slots the print actually consumes so we can
    # drop preheat/auto-feed/flow-calibrate for unused ones — those just waste
    # time and material. Only filter when there's something to filter out
    # (i.e. at least one slot has used_g == 0); when everything is used the
    # file goes through unchanged.
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

        if working is not None:
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
