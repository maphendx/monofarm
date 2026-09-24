"""Record one operator report and optional stock receipts in the caller's transaction.

Single accounting path for every reporting surface:
- ``record_output`` — bed-clear confirmation on a printer (printer lock held by the API);
- ``attach_history_output`` — late accounting for a finished run from the history page.

One physical unit is received exactly once: runs linked to a live production
batch update the batch counters (the batch close owns receipts), runs linked to
a task receive stock once (``PrintTask.output_accounted_from_runs`` guards the
task-done path), direct file prints receipt on confirmation.
"""
from datetime import datetime, timezone
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.bambu_cloud_job import BambuCloudJob
from app.models.gcode_file import GcodeFile
from app.models.print_history import PrintHistory
from app.models.printer import Printer
from app.models.task import PrintTask, PrintTaskStatus
from app.models.warehouse import (
    MovementType, Product, ProductionBatch, Warehouse,
    WarehouseMovement, WarehouseType,
)
from app.services.file_outputs import TERMINAL_BATCH_STATUSES
from app.schemas.print_output import (
    ClearBedPayload, HistoryOutputPayload, PrintOutputContext, PrintOutputCreate,
    PrintOutputPlanOut,
)


def latest_history(db: Session, printer: Printer) -> PrintHistory | None:
    history = db.query(PrintHistory).filter_by(
        organization_id=printer.organization_id, printer_id=printer.id,
    ).order_by(PrintHistory.started_at.desc(), PrintHistory.id.desc()).first()
    if history and history.id == printer.last_cleared_history_id:
        return None
    return history


def run_plan(db: Session, history: PrintHistory | None) -> PrintOutputPlanOut | None:
    """Frozen production plan of the run, resolved via its dispatch job."""
    if history is None or history.bambu_cloud_job_id is None:
        return None
    job = db.query(BambuCloudJob).filter_by(
        id=history.bambu_cloud_job_id, organization_id=history.organization_id,
    ).first()
    plan = job.output_plan if job else None
    if not plan or not plan.get("items"):
        return None
    try:
        parsed = PrintOutputPlanOut.model_validate(plan)
        # Older snapshots may contain both a common and a plate-specific row
        # for the same product. One receipt row must include their combined qty.
        combined = {}
        for item in parsed.items:
            if item.product_id in combined:
                combined[item.product_id].planned_qty += item.planned_qty
            else:
                combined[item.product_id] = item
        parsed.items = list(combined.values())
        return parsed
    except Exception:
        return None


def output_context(db: Session, printer: Printer) -> PrintOutputContext:
    history = latest_history(db, printer)
    file_name = history.file_name if history else printer.manual_job
    if not file_name and printer.last_gcode_file_id:
        file = db.query(GcodeFile).filter_by(
            organization_id=printer.organization_id, id=printer.last_gcode_file_id,
        ).first()
        file_name = file.original_name if file else None
    return PrintOutputContext(
        history_id=history.id if history else None,
        file_name=file_name,
        output=history.output_report if history else None,
        plan=run_plan(db, history),
        filament_g=history.filament_g if history else None,
        material_cost=float(history.material_cost) if history and history.material_cost else None,
    )


def _same_report(stored: dict, output: PrintOutputCreate) -> bool:
    old = PrintOutputCreate.model_validate(stored)
    return old.model_dump() == output.model_dump()


def pending_output(report: dict | None) -> bool:
    return report is None or report.get("accounting_state") == "pending" or (
        "accounting_state" not in report and not report.get("warehouse_id")
        and not report.get("plan") and any(item.get("pieces_ok", 0) > 0 for item in report.get("items", []))
    )


def replayed_output(db: Session, printer: Printer, payload: ClearBedPayload) -> bool:
    if not payload.output or not payload.request_id:
        return False
    previous = db.query(PrintHistory).filter(
        PrintHistory.organization_id == printer.organization_id,
        PrintHistory.printer_id == printer.id,
        PrintHistory.output_report["request_id"].astext == str(payload.request_id),
    ).first()
    if previous:
        if not _same_report(previous.output_report, payload.output):
            raise HTTPException(409, "Цей запит уже збережено з іншим результатом")
        return True
    return False


def replayed_history_output(history: PrintHistory, payload: HistoryOutputPayload) -> bool:
    """True when the payload is an exact replay of the stored report; 409 otherwise."""
    if not history.output_report:
        return False
    if history.output_report.get("request_id") == str(payload.request_id) and _same_report(
        history.output_report, payload.output,
    ):
        return True
    if history.output_report.get("request_id") == str(payload.request_id):
        raise HTTPException(409, "Цей запит уже збережено з іншим результатом")
    if pending_output(history.output_report):
        return False
    raise HTTPException(409, "Результат цього друку вже збережено")


def record_output(db: Session, printer: Printer, payload: ClearBedPayload, user_id: int) -> None:
    """Caller holds the printer lock; retries never create a second stock receipt."""
    output = payload.output
    if output is None:
        return
    history = latest_history(db, printer)
    if (history.id if history else None) != payload.history_id:
        raise HTTPException(409, "Друк змінився. Закрийте форму й відкрийте її знову")
    if history is None and printer.bed_cleared_at is not None:
        raise HTTPException(409, "Стіл уже звільнено. Результат доступний в історії друку")
    if history:
        history = db.query(PrintHistory).filter_by(id=history.id, organization_id=printer.organization_id).with_for_update().populate_existing().one()
    if history and history.output_report:
        raise HTTPException(409, "Результат цього друку вже збережено")

    if history is None:
        # No tracker observation: preserve the reported filename, but do not
        # invent a duration, filament usage, or production task.
        now = datetime.now(timezone.utc)
        history = PrintHistory(
            organization_id=printer.organization_id, printer_id=printer.id,
            printer_name=printer.name, printer_kind=printer.kind.value,
            file_name=payload.file_name, started_at=now, finished_at=now,
            result="completed", source="manual", created_by_user_id=user_id,
        )
        db.add(history)
        db.flush()

    _apply_output(db, printer.organization_id, history, output, user_id, payload.request_id)
    printer.last_cleared_history_id = history.id
    db.flush()


def attach_history_output(
    db: Session, org_id: int, history: PrintHistory, payload: HistoryOutputPayload, user_id: int,
) -> None:
    """Late accounting for a finished run that was never reported at bed-clear.

    The caller holds a FOR UPDATE lock on the history row; the physical bed
    state is not touched — clearing the bed and accounting are separate states.
    """
    if history.result == "in_progress":
        raise HTTPException(409, "Друк ще триває. Дочекайтеся завершення")
    if history.output_report and not pending_output(history.output_report):
        raise HTTPException(409, "Результат цього друку вже збережено")
    _apply_output(db, org_id, history, payload.output, user_id, payload.request_id)
    db.flush()


def _apply_output(
    db: Session,
    org_id: int,
    history: PrintHistory,
    output: PrintOutputCreate,
    user_id: int,
    request_id,
) -> None:
    plan = run_plan(db, history)
    # Consistent lock order: history -> task -> batch -> products. Both reporting
    # surfaces use this path, and task completion locks the task before accounting.
    batch, task = _run_targets(db, org_id, plan)

    warehouse = None
    if output.warehouse_id:
        warehouse = db.query(Warehouse).filter_by(
            id=output.warehouse_id, organization_id=org_id, is_active=True,
        ).first()
        if not warehouse or warehouse.type != WarehouseType.finished:
            raise HTTPException(400, "Оберіть активний склад готової продукції")

    # Lock products in ID order to serialize receipts/cost updates across printers.
    ids = sorted({item.product_id for item in output.items if item.product_id is not None})
    products = {p.id: p for p in db.query(Product).filter(
        Product.organization_id == org_id,
        Product.id.in_(ids), Product.is_active.is_(True),
    ).order_by(Product.id).with_for_update().populate_existing().all()}
    if len(products) != len(ids):
        raise HTTPException(400, "Товар не знайдено або архівовано")

    now = datetime.now(timezone.utc)
    report = output.model_dump(mode="json")
    report.update(recorded_at=now.isoformat(), recorded_by_id=user_id, request_id=str(request_id))
    planned_by_product = {item.product_id: item.planned_qty for item in plan.items} if plan else {}
    if plan:
        report["plan"] = {
            "file_id": plan.file_id,
            "warehouse_id": plan.warehouse_id,
            "items": [
                {"product_id": item.product_id, "planned_qty": item.planned_qty}
                for item in plan.items
            ],
        }
    for item in report["items"]:
        product = products.get(item["product_id"])
        item["product_name"] = f"{product.sku} · {product.name}" if product else None
        if item["product_id"] in planned_by_product:
            item["planned_qty"] = planned_by_product[item["product_id"]]

    if history.output_report:
        report["previous_report"] = history.output_report
    report["accounting_state"] = _reconcile_stock(db, org_id, history, plan, output, products, warehouse, user_id, batch, task)
    history.output_report = report


def _run_targets(
    db: Session, org_id: int, plan: PrintOutputPlanOut | None,
) -> tuple[ProductionBatch | None, PrintTask | None]:
    if plan is None:
        return None, None
    task = None
    if plan.print_task_id:
        task = db.query(PrintTask).filter_by(
            id=plan.print_task_id, organization_id=org_id,
        ).with_for_update().populate_existing().first()
    batch = None
    if plan.production_batch_id:
        batch = db.query(ProductionBatch).filter_by(
            id=plan.production_batch_id, organization_id=org_id,
        ).with_for_update().populate_existing().first()
        if batch is None or batch.status in TERMINAL_BATCH_STATUSES:
            raise HTTPException(409, "Партію закрито або видалено. Потрібне окреме узгодження обліку")
    # Never silently attach a historical run to a batch created after dispatch.
    return batch, task


def _reconcile_stock(
    db: Session,
    org_id: int,
    history: PrintHistory,
    plan: PrintOutputPlanOut | None,
    output: PrintOutputCreate,
    products: dict[int, Product],
    warehouse: Warehouse | None,
    user_id: int,
    batch: ProductionBatch | None,
    task: PrintTask | None,
) -> str:
    """Deliver the reported output to exactly one accounting destination."""
    total_ok = sum(item.pieces_ok for item in output.items)
    total_defective = sum(item.pieces_defective for item in output.items)

    if task is not None and (task.output_accounting_mode == "task" or (
        task.status == PrintTaskStatus.done and not task.output_accounted_from_runs
        and task.product_id is not None and db.query(WarehouseMovement.id).filter_by(
            organization_id=org_id, reason=f"Задача #{task.id}: {task.title}",
            type=MovementType.PRODUCTION_IN,
        ).first() is not None
    )):
        task.output_accounting_mode = "task"
        return "task"

    if batch is not None:
        if any(item.product_id != batch.product_id for item in output.items):
            raise HTTPException(400, "Номенклатура результату не відповідає виробничій партії")
        # Live production batch: mirrors the task-done path. The batch close
        # policy owns stock receipts, so only actuals are updated here.
        batch.printed_qty += total_ok + total_defective
        batch.good_qty += total_ok
        batch.defect_qty += total_defective
        if task is not None:
            _accumulate_task(db, task, output, total_ok, total_defective, received=False)
        return "batch"

    if task is not None:
        if total_ok > 0 and warehouse is None:
            return "pending"
        received = False
        if total_ok > 0 and warehouse is not None:
            _create_receipts(db, org_id, history, output, products, warehouse, user_id)
            received = True
        _accumulate_task(db, task, output, total_ok, total_defective, received)
        return "stock" if received else "no_output"

    # Direct file print (or untracked run): receipt on confirmation.
    if total_ok > 0 and warehouse is not None:
        _create_receipts(db, org_id, history, output, products, warehouse, user_id)
        return "stock"
    return "pending" if total_ok > 0 else "no_output"


def _accumulate_task(
    db: Session, task: PrintTask, output: PrintOutputCreate,
    total_ok: int, total_defective: int, received: bool,
) -> None:
    """Mirror run actuals onto the task; mark it so task-done never re-accounts."""
    task.pieces_ok = (task.pieces_ok or 0) + total_ok
    task.pieces_defective = (task.pieces_defective or 0) + total_defective
    if total_defective and output.defect_reason:
        task.defect_reason = output.defect_reason[:255]
    if received or total_ok + total_defective > 0:
        # Batch counters were updated above (received=False) or stock was
        # received — either way the run delivered this task's output.
        task.output_accounted_from_runs = True
        task.output_accounting_mode = "runs"
    db.flush()


def _create_receipts(
    db: Session,
    org_id: int,
    history: PrintHistory,
    output: PrintOutputCreate,
    products: dict[int, Product],
    warehouse: Warehouse,
    user_id: int,
) -> None:
    for item in output.items:
        product = products.get(item.product_id)
        if product is None or item.pieces_ok <= 0:
            continue
        # No guessed cost allocation across different products. Use the
        # existing ledger path without inventing unit costs or deducting
        # filament a second time (print_tracker owns consumption).
        movement = WarehouseMovement(
            organization_id=org_id,
            type=MovementType.PRODUCTION_IN, product_id=product.id,
            warehouse_to_id=warehouse.id, quantity=Decimal(item.pieces_ok),
            reason=f"Результат друку #{history.id}: {history.printer_name}",
            created_by_id=user_id,
            print_history_id=history.id,
            unit_cost=(Decimal(str(history.material_cost)) / Decimal(item.pieces_ok)
                       if len(output.items) == 1 and history.material_cost is not None
                       and history.material_cost > 0 else None),
        )
        db.add(movement)
        try:
            db.flush()
        except IntegrityError:
            # Lost a race against a concurrent confirmation of the same run —
            # the unique run-receipt index is the last line of defense.
            raise HTTPException(409, "Результат цього друку вже збережено") from None
        from app.api.warehouse_modules.common import _apply_movement
        _apply_movement(movement, db)
