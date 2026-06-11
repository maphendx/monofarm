from datetime import date
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, Depends, File, HTTPException, UploadFile, status
from pydantic import BaseModel
from fastapi.responses import FileResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles
from app.core.db import get_db
from app.models.gcode_file import GcodeFile
from app.models.organization import Organization
from app.models.plan import PlanEntry
from app.models.printer import Printer
from app.models.task import PrintTask, PrintTaskStatus
from app.models.user import User, UserRole
from app.schemas.task import PrintTaskCreate, PrintTaskOut, PrintTaskUpdate
from app.services.gcode_meta import parse_gcode


# Files live under data/uploads/<task_id>/<original_filename>
UPLOADS_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "uploads"
ALLOWED_EXTS = {".gcode", ".gco", ".g", ".3mf", ".bgcode"}
MAX_FILE_BYTES = 200 * 1024 * 1024  # 200 MB


router = APIRouter(prefix="/queue", tags=["queue"])


def _enrich(task: PrintTask, db: Session, org_id: int) -> dict[str, Any]:
    """Return extra computed fields for PrintTaskOut."""
    # created_by_name
    created_by_name: str | None = None
    if task.created_by_id:
        u = db.get(User, task.created_by_id)
        created_by_name = u.name if u else None

    from app.services import storage as storage_svc

    # gcode_file_id / has_thumbnail
    gcode_file_id = task.gcode_file_id
    has_thumbnail = False
    if gcode_file_id:
        gf = db.query(GcodeFile).filter(GcodeFile.id == gcode_file_id, GcodeFile.organization_id == org_id).first()
        if gf:
            has_thumbnail = bool((gf.filament_meta or {}).get("has_thumbnail"))
            if not has_thumbnail:
                has_thumbnail = storage_svc.exists(gf.stored_name + ".thumb.png", org_id)
    elif task.file_name:
        # fallback: find GcodeFile by original_name
        gf = db.query(GcodeFile).filter(
            GcodeFile.original_name == task.file_name,
            GcodeFile.organization_id == org_id,
        ).order_by(GcodeFile.id.desc()).first()
        if gf:
            gcode_file_id = gf.id
            has_thumbnail = bool((gf.filament_meta or {}).get("has_thumbnail"))
            if not has_thumbnail:
                has_thumbnail = storage_svc.exists(gf.stored_name + ".thumb.png", org_id)

    # printed_count — tasks with the same file_name + done in this org
    printed_count = 0
    if task.file_name:
        printed_count = (
            db.query(func.count(PrintTask.id))
            .filter(
                PrintTask.organization_id == org_id,
                PrintTask.file_name == task.file_name,
                PrintTask.status == PrintTaskStatus.done,
                PrintTask.id != task.id,
            )
            .scalar()
            or 0
        )

    # assigned_printer — first PlanEntry for today
    today = date.today()
    entry = (
        db.query(PlanEntry)
        .filter(
            PlanEntry.task_id == task.id,
            PlanEntry.organization_id == org_id,
            PlanEntry.plan_date == today,
        )
        .first()
    )
    assigned_printer_id = None
    assigned_printer_name = None
    if entry:
        printer = db.get(Printer, entry.printer_id)
        assigned_printer_id = entry.printer_id
        assigned_printer_name = printer.name if printer else None

    product_name: str | None = None
    if task.product_id:
        from app.models.warehouse import Product
        prod = db.get(Product, task.product_id)
        product_name = f"{prod.sku} · {prod.name}" if prod else None

    return {
        "gcode_file_id": gcode_file_id,
        "has_thumbnail": has_thumbnail,
        "created_by_name": created_by_name,
        "printed_count": printed_count,
        "assigned_printer_id": assigned_printer_id,
        "assigned_printer_name": assigned_printer_name,
        "product_name": product_name,
    }


def _to_out(task: PrintTask, db: Session, org_id: int) -> PrintTaskOut:
    extra = _enrich(task, db, org_id)
    return PrintTaskOut.model_validate({
        **{c.name: getattr(task, c.name) for c in task.__table__.columns},
        **extra,
    })


@router.get("", response_model=list[PrintTaskOut])
def list_tasks(
    status: PrintTaskStatus | None = None,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[PrintTaskOut]:
    q = db.query(PrintTask).filter(PrintTask.organization_id == org.id)
    if status:
        q = q.filter(PrintTask.status == status)
    else:
        q = q.filter(PrintTask.status.notin_([PrintTaskStatus.cancelled]))
    tasks = q.order_by(PrintTask.deadline.asc().nullslast(), PrintTask.created_at).all()
    return [_to_out(t, db, org.id) for t in tasks]


@router.post("", response_model=PrintTaskOut, status_code=status.HTTP_201_CREATED)
def create_task(
    payload: PrintTaskCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(UserRole.admin, UserRole.operator, UserRole.manager)),
    org: Organization = Depends(get_current_org),
) -> PrintTaskOut:
    task = PrintTask(**payload.model_dump(), created_by_id=user.id, organization_id=org.id)
    db.add(task)
    db.commit()
    db.refresh(task)
    return _to_out(task, db, org.id)


class _FromLibraryPayload(BaseModel):
    gcode_file_id: int
    quantity: int = 1
    title: str | None = None


@router.post("/from-library", response_model=PrintTaskOut, status_code=status.HTTP_201_CREATED)
def create_task_from_library(
    payload: _FromLibraryPayload,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(UserRole.admin, UserRole.operator, UserRole.manager)),
    org: Organization = Depends(get_current_org),
) -> PrintTaskOut:
    gfile = db.query(GcodeFile).filter(GcodeFile.id == payload.gcode_file_id, GcodeFile.organization_id == org.id).first()
    if not gfile:
        raise HTTPException(status_code=404, detail="File not found")
    meta = gfile.filament_meta or {}
    task = PrintTask(
        title=payload.title or gfile.original_name,
        quantity=max(1, payload.quantity),
        file_name=gfile.original_name,
        filament_meta=gfile.filament_meta,
        estimated_minutes=meta.get("estimated_minutes"),
        gcode_file_id=gfile.id,
        created_by_id=user.id,
        organization_id=org.id,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return _to_out(task, db, org.id)


class _BulkDistributePayload(BaseModel):
    task_ids: list[int] | None = None


class _DistributeEntry(BaseModel):
    task_id: int
    printer_id: int
    printer_name: str


class BulkDistributeResult(BaseModel):
    sent: list[_DistributeEntry]
    skipped: list[dict]


@router.post("/bulk-distribute", response_model=BulkDistributeResult)
def bulk_distribute(
    payload: _BulkDistributePayload = Body(default=_BulkDistributePayload()),
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> BulkDistributeResult:
    """Assign queued tasks to free compatible printers and create today's PlanEntries."""
    today = date.today()

    # Get tasks to distribute
    q = db.query(PrintTask).filter(
        PrintTask.organization_id == org.id,
        PrintTask.status == PrintTaskStatus.queued,
    )
    if payload.task_ids:
        q = q.filter(PrintTask.id.in_(payload.task_ids))
    tasks = q.order_by(PrintTask.deadline.asc().nullslast(), PrintTask.created_at).all()

    # Get all idle printers for this org
    all_printers = db.query(Printer).filter(
        Printer.organization_id == org.id,
        Printer.is_active,
    ).all()

    # Track which printer IDs are already being used in this batch
    claimed: set[int] = set()

    sent: list[_DistributeEntry] = []
    skipped: list[dict] = []

    for task in tasks:
        if not task.gcode_file_id and not task.file_name:
            skipped.append({"task_id": task.id, "reason": "Немає файлу"})
            continue

        # Infer file type for Bambu vs Moonraker compatibility
        fname = task.file_name or ""
        is_3mf = ".3mf" in fname.lower()

        # Find first free compatible printer not already claimed
        chosen: Printer | None = None
        for p in all_printers:
            if p.id in claimed:
                continue
            # Already has a plan entry for today → skip
            existing = db.query(PlanEntry).filter(
                PlanEntry.printer_id == p.id,
                PlanEntry.plan_date == today,
                PlanEntry.organization_id == org.id,
            ).first()
            if existing:
                continue
            if is_3mf and p.kind.value != "bambu":
                continue
            if not is_3mf and p.kind.value == "bambu":
                continue
            chosen = p
            break

        if not chosen:
            skipped.append({"task_id": task.id, "reason": "Немає вільного принтера"})
            continue

        # Create PlanEntry for today
        seq = (
            db.query(func.count(PlanEntry.id))
            .filter(PlanEntry.printer_id == chosen.id, PlanEntry.plan_date == today, PlanEntry.organization_id == org.id)
            .scalar()
            or 0
        )
        entry = PlanEntry(
            organization_id=org.id,
            plan_date=today,
            printer_id=chosen.id,
            task_id=task.id,
            sequence=seq,
        )
        db.add(entry)
        claimed.add(chosen.id)
        sent.append(_DistributeEntry(task_id=task.id, printer_id=chosen.id, printer_name=chosen.name))

    db.commit()
    return BulkDistributeResult(sent=sent, skipped=skipped)


@router.patch("/{task_id}", response_model=PrintTaskOut)
def update_task(
    task_id: int,
    payload: PrintTaskUpdate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    user: User = Depends(require_roles(UserRole.admin, UserRole.operator, UserRole.manager)),
) -> PrintTaskOut:
    task = db.query(PrintTask).filter(PrintTask.id == task_id, PrintTask.organization_id == org.id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    consumptions = payload.filament_consumptions
    pieces_ok = payload.pieces_ok
    pieces_defective = payload.pieces_defective or 0
    old_status = task.status  # capture before setattr overwrites it
    exclude_fields = {"filament_consumptions", "pieces_ok", "pieces_defective", "defect_reason"}
    update_data = payload.model_dump(exclude_none=True, exclude=exclude_fields)
    for field, val in update_data.items():
        setattr(task, field, val)

    if payload.pieces_ok is not None:
        task.pieces_ok = payload.pieces_ok
    if payload.pieces_defective is not None:
        task.pieces_defective = payload.pieces_defective
    if payload.defect_reason is not None:
        task.defect_reason = payload.defect_reason

    # deduct filaments and calculate cost on first transition to done only
    if payload.status == PrintTaskStatus.done and old_status != PrintTaskStatus.done and consumptions:
        from app.models.filament import Filament, FilamentLog
        from app.api.filaments import _warehouse_movement

        planned_qty = task.quantity or 1
        actual_printed = (pieces_ok or 0) + pieces_defective
        scale = actual_printed / planned_qty if actual_printed and planned_qty else 1.0

        total_cost = 0.0
        stored = []
        for c in consumptions:
            fil = db.query(Filament).filter(Filament.id == c.filament_id, Filament.organization_id == org.id).first()
            if not fil:
                continue
            actual_grams = round(c.grams * scale)
            fil.grams_remaining = max(0, fil.grams_remaining - actual_grams)
            reason = f"Списання по задачі #{task_id}"
            if pieces_defective:
                reason += f" (з них брак: {pieces_defective} шт.)"
            if payload.defect_reason:
                reason += f" — {payload.defect_reason}"
            db.add(FilamentLog(
                organization_id=org.id,
                filament_id=fil.id,
                delta_grams=-actual_grams,
                grams_after=fil.grams_remaining,
                reason=reason,
                task_id=task_id,
                user_id=user.id,
            ))
            _warehouse_movement(fil, -actual_grams, reason, user.id, db)
            if fil.cost_per_kg:
                total_cost += actual_grams * fil.cost_per_kg / 1000.0
            stored.append({"filament_id": fil.id, "grams": actual_grams})

        task.filament_consumptions = stored
        if total_cost > 0:
            task.material_cost_uah = round(total_cost, 2)

    # warehouse sync when task → done
    transitioning_to_done = (
        payload.status == PrintTaskStatus.done
        and old_status != PrintTaskStatus.done
    )
    if transitioning_to_done and (pieces_ok or 0) > 0 and task.product_id:
        from decimal import Decimal
        from app.models.warehouse import (
            BatchStatus as WBatchStatus, ProductionBatch,
            Warehouse, WarehouseMovement, WarehouseType, MovementType,
        )
        from app.api.warehouse import _apply_movement, _update_avco

        # if there is a live batch linked to this task, update its counters —
        # PRODUCTION_IN will fire when the batch is closed (prevents double-counting)
        linked_batch = (
            db.query(ProductionBatch)
            .filter(
                ProductionBatch.print_task_id == task_id,
                ProductionBatch.organization_id == org.id,
                ProductionBatch.status.notin_([WBatchStatus.done, WBatchStatus.cancelled]),
            )
            .first()
        )

        if linked_batch:
            linked_batch.printed_qty += (pieces_ok or 0) + pieces_defective
            linked_batch.good_qty    += pieces_ok or 0
            linked_batch.defect_qty  += pieces_defective
        else:
            # standalone task: immediate PRODUCTION_IN to finished warehouse
            finished_wh = (
                db.query(Warehouse)
                .filter(
                    Warehouse.organization_id == org.id,
                    Warehouse.type == WarehouseType.finished,
                    Warehouse.is_active,
                )
                .order_by(Warehouse.id)
                .first()
            )
            if finished_wh:
                qty = Decimal(pieces_ok)
                unit_cost: Decimal | None = None
                total_cost_uah = task.material_cost_uah
                if total_cost_uah and pieces_ok:
                    unit_cost = Decimal(str(round(total_cost_uah / pieces_ok, 4)))
                if unit_cost:
                    _update_avco(task.product_id, qty, unit_cost, db)
                m = WarehouseMovement(
                    organization_id=org.id,
                    type=MovementType.PRODUCTION_IN,
                    product_id=task.product_id,
                    warehouse_to_id=finished_wh.id,
                    quantity=qty,
                    unit_cost=unit_cost,
                    total_cost=Decimal(str(total_cost_uah)) if total_cost_uah else None,
                    reason=f"Задача #{task_id}: {task.title}",
                    created_by_id=user.id,
                )
                db.add(m)
                db.flush()
                _apply_movement(m, db)

    db.commit()
    db.refresh(task)
    return _to_out(task, db, org.id)


@router.delete("/{task_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_task(
    task_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> None:
    task = db.query(PrintTask).filter(PrintTask.id == task_id, PrintTask.organization_id == org.id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    _delete_task_file(task)
    # manually delete calendar entries to avoid foreign key violation
    db.query(PlanEntry).filter(PlanEntry.task_id == task_id).delete()
    db.delete(task)
    db.commit()


# ── file attachment ─────────────────────────────────────────────────────────

def _task_dir(task_id: int) -> Path:
    return UPLOADS_DIR / str(task_id)


def _safe_filename(name: str) -> str:
    name = Path(name).name  # strip any path
    return name.replace("/", "_").replace("\\", "_").replace("\x00", "")


def _delete_task_file(task: PrintTask) -> None:
    if not task.file_ref:
        return
    p = _task_dir(task.id) / task.file_ref
    if p.exists():
        p.unlink(missing_ok=True)
    d = _task_dir(task.id)
    if d.exists() and not any(d.iterdir()):
        d.rmdir()


@router.post("/{task_id}/file", response_model=PrintTaskOut)
async def upload_task_file(
    task_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator, UserRole.manager)),
) -> PrintTaskOut:
    task = db.query(PrintTask).filter(PrintTask.id == task_id, PrintTask.organization_id == org.id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    fname = _safe_filename(file.filename or "upload.bin")
    ext = Path(fname).suffix.lower()
    if ext not in ALLOWED_EXTS:
        raise HTTPException(
            status_code=400,
            detail=f"Дозволені формати: {', '.join(sorted(ALLOWED_EXTS))}",
        )

    _delete_task_file(task)

    target_dir = _task_dir(task_id)
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / fname

    written = 0
    with target_path.open("wb") as out:
        while chunk := await file.read(1024 * 1024):
            written += len(chunk)
            if written > MAX_FILE_BYTES:
                out.close()
                target_path.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail="Файл занадто великий (макс. 200 МБ)")
            out.write(chunk)

    task.file_ref = fname
    task.file_name = fname
    task.file_size = written

    try:
        meta = parse_gcode(target_path)
        if meta:
            task.filament_meta = meta
            if not task.estimated_minutes and meta.get("estimated_minutes"):
                task.estimated_minutes = meta["estimated_minutes"]
    except Exception:  # noqa: BLE001
        pass

    db.commit()
    db.refresh(task)
    return _to_out(task, db, org.id)


@router.get("/{task_id}/file")
def download_task_file(
    task_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> FileResponse:
    task = db.query(PrintTask).filter(PrintTask.id == task_id, PrintTask.organization_id == org.id).first()
    if not task or not task.file_ref:
        raise HTTPException(status_code=404, detail="Файл не знайдено")
    path = _task_dir(task_id) / task.file_ref
    if not path.exists():
        raise HTTPException(status_code=404, detail="Файл не знайдено на диску")
    return FileResponse(path, filename=task.file_name or task.file_ref)


@router.delete("/{task_id}/file", response_model=PrintTaskOut)
def delete_task_file(
    task_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> PrintTaskOut:
    task = db.query(PrintTask).filter(PrintTask.id == task_id, PrintTask.organization_id == org.id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    _delete_task_file(task)
    task.file_ref = None
    task.file_name = None
    task.file_size = None
    task.filament_meta = None
    db.commit()
    db.refresh(task)
    return _to_out(task, db, org.id)
