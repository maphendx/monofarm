"""Operator-configured production links: gcode file → products per run.

The links describe what one run of a file is expected to produce. At send time
they are frozen into ``BambuCloudJob.output_plan`` so later edits never change
an already dispatched or finished print.
"""
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.gcode_file import GcodeFile
from app.models.gcode_file_output import GcodeFileOutput
from app.models.organization import Organization
from app.models.task import PrintTask
from app.models.warehouse import (
    BatchStatus, Product, ProductionBatch, Warehouse, WarehouseType,
)
from app.schemas.file_output import FileOutputSet

TERMINAL_BATCH_STATUSES = (BatchStatus.done, BatchStatus.cancelled)


def get_file_outputs(db: Session, org_id: int, file_id: int) -> list[GcodeFileOutput]:
    return db.query(GcodeFileOutput).filter_by(
        organization_id=org_id, gcode_file_id=file_id,
    ).all()


def set_file_outputs(db: Session, org: Organization, file: GcodeFile, payload: FileOutputSet) -> None:
    """Replace the whole production configuration of the file in the caller's transaction."""
    file = db.query(GcodeFile).filter_by(id=file.id, organization_id=org.id).with_for_update().populate_existing().one()
    if payload.warehouse_id:
        warehouse = db.query(Warehouse).filter_by(
            id=payload.warehouse_id, organization_id=org.id, is_active=True,
        ).first()
        if not warehouse or warehouse.type != WarehouseType.finished:
            raise HTTPException(400, "Оберіть активний склад готової продукції")

    ids = sorted({item.product_id for item in payload.items})
    products = {
        p.id: p
        for p in db.query(Product).filter(
            Product.organization_id == org.id,
            Product.id.in_(ids),
            Product.is_active.is_(True),
        ).all()
    }
    if len(products) != len(ids):
        raise HTTPException(400, "Товар не знайдено або архівовано")

    file.output_warehouse_id = payload.warehouse_id
    file.outputs = [
        GcodeFileOutput(
            organization_id=org.id,
            gcode_file_id=file.id,
            product_id=item.product_id,
            qty_per_run=item.qty_per_run,
            plate=item.plate,
        )
        for item in payload.items
    ]
    db.flush()


def build_output_plan(
    db: Session,
    org_id: int,
    file_id: int,
    *,
    task_id: int | None = None,
    plate: int | None = None,
) -> dict | None:
    """Freeze the file's production links into a per-run plan dict.

    Called once at dispatch time; the result is stored on the run's job and is
    never recomputed. Returns None when the file has no configured outputs or
    the requested plate has no matching positions.
    """
    file = db.query(GcodeFile).filter_by(id=file_id, organization_id=org_id).with_for_update().populate_existing().first()
    if file is None:
        return None
    rows = get_file_outputs(db, org_id, file_id)
    if not rows:
        return None
    # One dispatch executes one plate. Never aggregate all numbered plates.
    if plate is None:
        import re
        file = db.query(GcodeFile).filter_by(id=file_id, organization_id=org_id).first()
        match = re.search(r"plate_(\d+)\.gcode$", (file.filament_meta or {}).get("bambu_plate_gcode", "")) if file else None
        if file and file.original_name.lower().endswith(".3mf") and not match:
            from app.services.print_plates import file_plates
            plate = file_plates(file, org_id)[0]
        else:
            plate = int(match.group(1)) if match else 1
    selected = [row for row in rows if row.plate is None or row.plate == plate]
    if not selected:
        return None

    products = {
        p.id: p
        for p in db.query(Product).filter(
            Product.organization_id == org_id,
            Product.id.in_({row.product_id for row in selected}),
        ).all()
    }
    items = [
        {
            "product_id": row.product_id,
            "product_name": (
                f"{products[row.product_id].sku} · {products[row.product_id].name}"
                if row.product_id in products else None
            ),
            "planned_qty": row.qty_per_run,
        }
        for row in selected
    ]
    combined = {}
    for item in items:
        if item["product_id"] in combined:
            combined[item["product_id"]]["planned_qty"] += item["planned_qty"]
        else:
            combined[item["product_id"]] = item
    items = list(combined.values())

    batch_id: int | None = None
    resolved_task_id: int | None = None
    if task_id is not None:
        task = db.query(PrintTask).filter_by(id=task_id, organization_id=org_id).first()
        if task:
            resolved_task_id = task.id
            batch = (
                db.query(ProductionBatch)
                .filter(
                    ProductionBatch.organization_id == org_id,
                    ProductionBatch.print_task_id == task.id,
                    ProductionBatch.status.notin_(TERMINAL_BATCH_STATUSES),
                )
                .first()
            )
            batch_id = batch.id if batch else None

    file = db.query(GcodeFile).filter_by(id=file_id, organization_id=org_id).first()
    return {
        "file_id": file_id,
        "plate": plate,
        "warehouse_id": file.output_warehouse_id if file else None,
        "print_task_id": resolved_task_id,
        "production_batch_id": batch_id,
        "items": items,
    }
