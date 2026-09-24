"""Automatic filament consumption & warehouse write-off — the accounting pipeline.

Covers the source-of-truth hierarchy per printer kind, spool deduction,
warehouse WRITE_OFF through the ledger, material cost, idempotency across
finalization paths and the task-closing rules (tracked runs vs planned
fallback). All external I/O (Moonraker, Bambu, Telegram) is mocked.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone


from app.models.bambu_cloud_job import BambuCloudJob
from app.models.filament import Filament, FilamentLog
from app.models.print_history import PrintHistory
from app.models.printer import Printer, PrinterKind
from app.models.printer_slot import PrinterSlot
from app.models.task import PrintTask
from app.models.warehouse import Product, StockEntry, Warehouse, WarehouseMovement, WarehouseType
from app.services import print_costing


# ── fixtures ─────────────────────────────────────────────────────────────────


def _moonraker_printer(db_session, org, name="U1-acc"):
    printer = Printer(organization_id=org.id, name=name, kind=PrinterKind.snapmaker_u1,
                      moonraker_url="http://u1.local", is_active=True)
    db_session.add(printer)
    db_session.flush()
    return printer


def _bambu_printer(db_session, org, name="P1S-acc"):
    printer = Printer(organization_id=org.id, name=name, kind=PrinterKind.bambu, is_active=True)
    db_session.add(printer)
    db_session.flush()
    return printer


def _spool(db_session, org, label, grams=1000, cost=500, product=None, min_grams=0):
    fil = Filament(organization_id=org.id, material="PLA", color=label,
                   grams_remaining=grams, cost_per_kg=cost, min_grams=min_grams,
                   warehouse_product_id=product.id if product else None)
    db_session.add(fil)
    db_session.flush()
    return fil


def _slot(db_session, printer, index, fil):
    db_session.add(PrinterSlot(printer_id=printer.id, slot_index=index,
                               state="loaded", filament_id=fil.id))
    db_session.flush()


def _run(db_session, org, printer, filename="part.gcode", result="in_progress", job=None):
    history = PrintHistory(organization_id=org.id, printer_id=printer.id,
                           printer_name=printer.name, printer_kind=printer.kind.value,
                           file_name=filename, result=result,
                           started_at=datetime.now(timezone.utc) - timedelta(minutes=30),
                           bambu_cloud_job_id=job.id if job else None)
    db_session.add(history)
    db_session.flush()
    return history


def _mock_moonraker(monkeypatch, *, used_mm=None, filename="part.gcode", used_g=None,
                    diameters=None, densities=None):
    from app.services import moonraker
    live = {"state": "operational", "filename": filename,
            "filament_used_mm": used_mm}
    meta = {}
    if used_g:
        meta["used_g"] = used_g
    if diameters:
        meta["filament_diameter"] = diameters
    if densities:
        meta["filament_density"] = densities
    monkeypatch.setattr(moonraker, "get_live_status", lambda url, org_id=None: dict(live))
    monkeypatch.setattr(moonraker, "get_remote_file_meta",
                        lambda url, filename, org_id=None: dict(meta))
    return moonraker


# ── Moonraker / U1 ───────────────────────────────────────────────────────────


def test_completed_u1_deducts_actual_telemetry_scaled_by_planned_ratios(
    db_session, test_org, monkeypatch,
):
    """Actual 50 g on an 80/20 plan → 40 + 10, never the planned 100."""
    printer = _moonraker_printer(db_session, test_org)
    spool_a = _spool(db_session, test_org, "Red", grams=1000, cost=500)
    spool_b = _spool(db_session, test_org, "White", grams=1000, cost=400)
    _slot(db_session, printer, 0, spool_a)
    _slot(db_session, printer, 1, spool_b)
    _mock_moonraker(monkeypatch, used_mm=16765, used_g=[80, 20])  # 50 g of PLA 1.75
    history = _run(db_session, test_org, printer)

    print_costing.finalize_print(db_session, history, printer, "completed")

    db_session.refresh(spool_a)
    db_session.refresh(spool_b)
    assert spool_a.grams_remaining == 960
    assert spool_b.grams_remaining == 990
    assert db_session.query(FilamentLog).filter(
        FilamentLog.reason.like(f"print_history:{history.id}:%")).count() == 2
    assert abs(history.filament_g - 50.0) < 0.01


def test_cancelled_u1_consumes_only_actual_partial_usage(db_session, test_org, monkeypatch):
    """A print scrapped at ~12.5 g must not deduct the full planned amount."""
    printer = _moonraker_printer(db_session, test_org)
    spool = _spool(db_session, test_org, "Red", grams=1000, cost=500)
    _slot(db_session, printer, 0, spool)
    _mock_moonraker(monkeypatch, used_mm=4191, used_g=[100])  # ~12.5 g actual
    history = _run(db_session, test_org, printer)

    print_costing.finalize_print(db_session, history, printer, "cancelled")

    db_session.refresh(spool)
    assert spool.grams_remaining == 988  # 12.5 → 12 after rounding
    assert history.material_cost is not None


def test_u1_completed_without_telemetry_falls_back_to_planned(db_session, test_org, monkeypatch):
    printer = _moonraker_printer(db_session, test_org)
    spool_a = _spool(db_session, test_org, "Red")
    spool_b = _spool(db_session, test_org, "White")
    _slot(db_session, printer, 0, spool_a)
    _slot(db_session, printer, 1, spool_b)
    _mock_moonraker(monkeypatch, used_mm=None, used_g=[80, 20])  # no filament_used_mm
    history = _run(db_session, test_org, printer)

    print_costing.finalize_print(db_session, history, printer, "completed")

    db_session.refresh(spool_a)
    db_session.refresh(spool_b)
    assert spool_a.grams_remaining == 920
    assert spool_b.grams_remaining == 980


def test_u1_actual_without_planned_metadata_splits_across_loaded_slots(
    db_session, test_org, monkeypatch,
):
    printer = _moonraker_printer(db_session, test_org)
    spool_a = _spool(db_session, test_org, "Red")
    spool_b = _spool(db_session, test_org, "White")
    _slot(db_session, printer, 0, spool_a)
    _slot(db_session, printer, 1, spool_b)
    _mock_moonraker(monkeypatch, used_mm=16765, used_g=None)  # 50 g, no plan
    history = _run(db_session, test_org, printer)

    print_costing.finalize_print(db_session, history, printer, "completed")

    db_session.refresh(spool_a)
    db_session.refresh(spool_b)
    assert spool_a.grams_remaining == 975 and spool_b.grams_remaining == 975
    assert abs(history.filament_g - 50.0) < 0.01


def test_u1_multi_material_uses_planned_ratios_not_equal_split(db_session, test_org, monkeypatch):
    printer = _moonraker_printer(db_session, test_org)
    support = _spool(db_session, test_org, "Support")
    body = _spool(db_session, test_org, "Body")
    _slot(db_session, printer, 0, support)
    _slot(db_session, printer, 1, body)
    _mock_moonraker(monkeypatch, used_mm=33530, used_g=[160, 40])  # 100 g actual, 80/20
    history = _run(db_session, test_org, printer)

    print_costing.finalize_print(db_session, history, printer, "completed")

    db_session.refresh(support)
    db_session.refresh(body)
    assert support.grams_remaining == 920  # 80 g
    assert body.grams_remaining == 980     # 20 g


def test_u1_telemetry_of_next_print_is_not_charged_to_previous_run(
    db_session, test_org, monkeypatch,
):
    """A printer that started a new job resets print_stats — never charge it back."""
    printer = _moonraker_printer(db_session, test_org)
    spool = _spool(db_session, test_org, "Red", grams=1000)
    _slot(db_session, printer, 0, spool)
    _mock_moonraker(monkeypatch, used_mm=999999, filename="next_job.gcode", used_g=[100])
    history = _run(db_session, test_org, printer, filename="part.gcode")

    print_costing.finalize_print(db_session, history, printer, "completed")

    db_session.refresh(spool)
    assert spool.grams_remaining == 900  # planned 100, not the next job's usage


# ── Bambu ────────────────────────────────────────────────────────────────────


def _bambu_run(db_session, org, printer, *, progress=None, result="in_progress", used_g=(80, 20)):
    file = None
    if used_g:
        from app.models.gcode_file import GcodeFile
        from uuid import uuid4
        file = GcodeFile(organization_id=org.id, original_name="box.3mf",
                         stored_name=f"uuid-{uuid4().hex}", size_bytes=1024,
                         filament_meta={"used_g": list(used_g)})
        db_session.add(file)
        db_session.flush()
    job = BambuCloudJob(organization_id=org.id, printer_id=printer.id,
                        gcode_file_id=file.id if file else None,
                        file_name="box.3mf", progress_pct=progress,
                        correlation_id="test-correlation", idempotency_key="test-idem")
    db_session.add(job)
    db_session.flush()
    return _run(db_session, org, printer, filename="box.3mf", result=result, job=job)


def test_bambu_completed_consumes_full_planned_amount(db_session, test_org, monkeypatch):
    from app.services import moonraker
    monkeypatch.setattr(moonraker, "get_live_status", lambda url, org_id=None: {"state": "unknown"})
    monkeypatch.setattr(moonraker, "get_remote_file_meta", lambda url, filename, org_id=None: {})

    printer = _bambu_printer(db_session, test_org)
    spool_a = _spool(db_session, test_org, "Red")
    spool_b = _spool(db_session, test_org, "White")
    _slot(db_session, printer, 0, spool_a)
    _slot(db_session, printer, 1, spool_b)
    history = _bambu_run(db_session, test_org, printer, progress=None, used_g=(80, 20))

    print_costing.finalize_print(db_session, history, printer, "completed")

    db_session.refresh(spool_a)
    db_session.refresh(spool_b)
    assert spool_a.grams_remaining == 920
    assert spool_b.grams_remaining == 980
    assert history.filament_g == 100.0
    assert history.material_cost is not None


def test_bambu_cancelled_at_40_percent_consumes_40_percent_of_plan(db_session, test_org):
    printer = _bambu_printer(db_session, test_org)
    spool_a = _spool(db_session, test_org, "Red")
    spool_b = _spool(db_session, test_org, "White")
    _slot(db_session, printer, 0, spool_a)
    _slot(db_session, printer, 1, spool_b)
    history = _bambu_run(db_session, test_org, printer, progress=40, used_g=(80, 20))

    print_costing.finalize_print(db_session, history, printer, "cancelled")

    db_session.refresh(spool_a)
    db_session.refresh(spool_b)
    assert spool_a.grams_remaining == 968  # 80 × 0.4 = 32
    assert spool_b.grams_remaining == 992  # 20 × 0.4 = 8
    assert history.filament_g == 40.0


def test_bambu_without_plan_and_progress_deducts_nothing(db_session, test_org):
    printer = _bambu_printer(db_session, test_org)
    spool = _spool(db_session, test_org, "Red")
    _slot(db_session, printer, 0, spool)
    history = _bambu_run(db_session, test_org, printer, progress=None, used_g=None)

    print_costing.finalize_print(db_session, history, printer, "cancelled")

    db_session.refresh(spool)
    assert spool.grams_remaining == 1000
    assert db_session.query(FilamentLog).count() == 0


# ── Spool + warehouse accounting ─────────────────────────────────────────────


def _material(db_session, org, grams=1000):
    wh = Warehouse(organization_id=org.id, name="Сировина", type=WarehouseType.raw)
    product = Product(organization_id=org.id, name="PLA Red", sku="MAT-1", unit="г")
    db_session.add_all([wh, product])
    db_session.flush()
    db_session.add(StockEntry(organization_id=org.id, product_id=product.id,
                              warehouse_id=wh.id, quantity=grams))
    db_session.flush()
    return wh, product


def test_linked_spool_writes_off_warehouse_stock_exactly_once(db_session, test_org, monkeypatch):
    printer = _moonraker_printer(db_session, test_org)
    _, product = _material(db_session, test_org, grams=1000)
    spool = _spool(db_session, test_org, "Red", grams=500, product=product)
    _slot(db_session, printer, 0, spool)
    _mock_moonraker(monkeypatch, used_mm=None, used_g=[120])
    history = _run(db_session, test_org, printer)

    print_costing.finalize_print(db_session, history, printer, "completed")
    # Replay the same run through the mutation layer directly (cloud-sync path).
    from app.services import print_accounting
    print_accounting.apply_consumption(
        db_session, history, printer,
        print_accounting.Consumption(grams_by_slot={0: 120.0}),
    )

    db_session.refresh(spool)
    assert spool.grams_remaining == 380
    movements = db_session.query(WarehouseMovement).filter(
        WarehouseMovement.type == "WRITE_OFF").all()
    assert len(movements) == 1
    assert float(movements[0].quantity) == 120
    assert movements[0].print_history_id == history.id
    entry = db_session.query(StockEntry).one()
    assert float(entry.quantity) == 880


def test_unlinked_spool_does_not_touch_warehouse(db_session, test_org, monkeypatch):
    printer = _moonraker_printer(db_session, test_org)
    spool = _spool(db_session, test_org, "Red", grams=500)
    _slot(db_session, printer, 0, spool)
    _mock_moonraker(monkeypatch, used_mm=None, used_g=[50])
    history = _run(db_session, test_org, printer)

    print_costing.finalize_print(db_session, history, printer, "completed")

    db_session.refresh(spool)
    assert spool.grams_remaining == 450
    assert db_session.query(WarehouseMovement).count() == 0


def test_warehouse_write_off_clamps_to_book_stock(db_session, test_org, monkeypatch):
    """Spool keeps the physical truth; the ledger never goes negative."""
    printer = _moonraker_printer(db_session, test_org)
    _, product = _material(db_session, test_org, grams=100)
    spool = _spool(db_session, test_org, "Red", grams=500, product=product)
    _slot(db_session, printer, 0, spool)
    _mock_moonraker(monkeypatch, used_mm=None, used_g=[300])
    history = _run(db_session, test_org, printer)

    print_costing.finalize_print(db_session, history, printer, "completed")

    db_session.refresh(spool)
    assert spool.grams_remaining == 200  # full actual deduction
    assert float(db_session.query(StockEntry).one().quantity) == 0


def test_repeated_finalize_is_idempotent(db_session, test_org, monkeypatch):
    printer = _moonraker_printer(db_session, test_org)
    _, product = _material(db_session, test_org)
    spool = _spool(db_session, test_org, "Red", grams=1000, product=product)
    _slot(db_session, printer, 0, spool)
    _mock_moonraker(monkeypatch, used_mm=None, used_g=[70])
    history = _run(db_session, test_org, printer)

    print_costing.finalize_print(db_session, history, printer, "completed")
    cost_after_first = history.material_cost
    # Simulate a tracker retry / cloud sync replay of the same physical run:
    # the entry is observed in_progress again and finalized once more.
    history.result = "in_progress"
    print_costing.finalize_print(db_session, history, printer, "completed")

    db_session.refresh(spool)
    assert spool.grams_remaining == 930
    assert db_session.query(FilamentLog).count() == 1
    assert db_session.query(WarehouseMovement).count() == 1
    assert history.material_cost == cost_after_first


# ── Task closing ─────────────────────────────────────────────────────────────


def test_task_close_with_tracked_runs_aggregates_without_double_deduction(
    db_session, test_org, admin_user, monkeypatch,
):
    """Runs already deducted the plastic; task close only records the actuals."""
    printer = _moonraker_printer(db_session, test_org)
    _, product = _material(db_session, test_org)
    spool = _spool(db_session, test_org, "Red", grams=1000, product=product)
    _slot(db_session, printer, 0, spool)
    _mock_moonraker(monkeypatch, used_mm=None, used_g=[100])

    task = PrintTask(organization_id=test_org.id, title="Tracked", quantity=10,
                     file_name="part.gcode")
    db_session.add(task)
    db_session.flush()
    history = _run(db_session, test_org, printer)
    print_costing.finalize_print(db_session, history, printer, "completed")
    db_session.refresh(spool)
    assert spool.grams_remaining == 900

    from fastapi import HTTPException  # noqa: F401 — update_task needs an org/user context
    # Close the task through the API layer (auth via client would duplicate
    # fixtures; the endpoint logic under test is the status transition block).
    from app.api.tasks import update_task
    from app.schemas.task import PrintTaskUpdate, FilamentConsumption

    class _Org:
        id = test_org.id
        plan = "farm"

    updated = update_task(
        task.id,
        PrintTaskUpdate(status="done", pieces_ok=8, pieces_defective=0,
                        filament_consumptions=[FilamentConsumption(filament_id=spool.id, grams=100)]),
        db=db_session, org=_Org(), user=admin_user,
    )
    assert updated.pieces_ok == 8

    db_session.refresh(spool)
    assert spool.grams_remaining == 900  # no second deduction
    assert db_session.query(FilamentLog).count() == 1
    assert db_session.query(WarehouseMovement).filter(WarehouseMovement.type == "WRITE_OFF").count() == 1
    stored = db_session.get(PrintTask, task.id).filament_consumptions
    assert stored[0]["source"] == "tracked_runs" and stored[0]["grams"] == 100


def test_task_close_without_tracked_runs_uses_planned_fallback(db_session, test_org, admin_user):
    printer = _moonraker_printer(db_session, test_org)
    _, product = _material(db_session, test_org)
    spool = _spool(db_session, test_org, "Red", grams=1000, product=product)
    _slot(db_session, printer, 0, spool)

    task = PrintTask(organization_id=test_org.id, title="Manual", quantity=10,
                     file_name="never_printed.gcode")
    db_session.add(task)
    db_session.flush()

    from app.api.tasks import update_task
    from app.schemas.task import PrintTaskUpdate, FilamentConsumption

    class _Org:
        id = test_org.id
        plan = "farm"

    update_task(
        task.id,
        PrintTaskUpdate(status="done", pieces_ok=10, pieces_defective=0,
                        filament_consumptions=[FilamentConsumption(filament_id=spool.id, grams=150)]),
        db=db_session, org=_Org(), user=admin_user,
    )

    db_session.refresh(spool)
    assert spool.grams_remaining == 850
    movements = db_session.query(WarehouseMovement).filter(WarehouseMovement.type == "WRITE_OFF").all()
    assert len(movements) == 1
    assert movements[0].reason.startswith("task:")


def test_repeated_task_close_is_idempotent(db_session, test_org, admin_user, monkeypatch):
    """Reopen → close again must not deduct the planned grams twice."""
    printer = _moonraker_printer(db_session, test_org)
    _, product = _material(db_session, test_org)
    spool = _spool(db_session, test_org, "Red", grams=1000, product=product)
    _slot(db_session, printer, 0, spool)
    _mock_moonraker(monkeypatch, used_mm=None, used_g=[0])

    task = PrintTask(organization_id=test_org.id, title="Reopen", quantity=10,
                     file_name="never.gcode")
    db_session.add(task)
    db_session.flush()

    from app.api.tasks import update_task
    from app.schemas.task import PrintTaskUpdate, FilamentConsumption

    class _Org:
        id = test_org.id
        plan = "farm"

    class _User:
        id = 1

    payload = PrintTaskUpdate(
        status="done", pieces_ok=10, pieces_defective=0,
        filament_consumptions=[FilamentConsumption(filament_id=spool.id, grams=90)],
    )
    update_task(task.id, payload, db=db_session, org=_Org(), user=admin_user)
    update_task(task.id, PrintTaskUpdate(status="in_progress"), db=db_session, org=_Org(), user=admin_user)
    update_task(task.id, payload, db=db_session, org=_Org(), user=admin_user)

    db_session.refresh(spool)
    assert spool.grams_remaining == 910
    assert db_session.query(WarehouseMovement).filter(WarehouseMovement.type == "WRITE_OFF").count() == 1


def test_old_warehouse_movement_import_is_gone(db_session, test_org):
    """Regression: the removed filaments._warehouse_movement must not be referenced."""
    import app.api.tasks  # imports cleanly = no broken import at close time
    import inspect
    source = inspect.getsource(app.api.tasks)
    assert "_warehouse_movement" not in source
