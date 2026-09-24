"""End-to-end file → product → run → stock accounting.

One physical unit must be received exactly once, the run plan is frozen at
send time, and late accounting from history never touches the printer state.
"""
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from app.models.gcode_file_output import GcodeFileOutput
from app.models.gcode_file import GcodeFile
from app.models.organization import Organization, OrgPlan
from app.models.print_history import PrintHistory
from app.models.printer import Printer, PrinterKind
from app.models.task import PrintTask
from app.models.warehouse import (
    Product, ProductionBatch, StockEntry, Warehouse, WarehouseMovement, WarehouseType,
)
from app.services import bambu_dispatch, file_outputs


@pytest.fixture
def catalog(db_session, test_org):
    test_org.plan = OrgPlan.farm
    body = Product(organization_id=test_org.id, name="Корпус", sku="CASE-001", unit="pcs")
    lid = Product(organization_id=test_org.id, name="Кришка", sku="LID-001", unit="pcs")
    warehouse = Warehouse(organization_id=test_org.id, name="Готова продукція", type=WarehouseType.finished)
    db_session.add_all([body, lid, warehouse])
    db_session.commit()
    return {"body": body, "lid": lid, "warehouse": warehouse}


@pytest.fixture
def gcode_file(db_session, test_org):
    row = GcodeFile(
        organization_id=test_org.id, original_name="case_plate.gcode",
        stored_name=f"uuid-{uuid4().hex}", size_bytes=1024,
        output_warehouse_id=None,
    )
    db_session.add(row)
    db_session.commit()
    return row


def configure_outputs(client, auth_headers, file_id, catalog, **overrides):
    payload = {
        "warehouse_id": catalog["warehouse"].id,
        "items": [{"product_id": catalog["body"].id, "qty_per_run": 8}],
        **overrides,
    }
    return client.put(f"/api/files/{file_id}/outputs", json=payload, headers=auth_headers)


# ── File output configuration ────────────────────────────────────────────────

def test_file_outputs_round_trip_and_summary(client, auth_headers, catalog, gcode_file):
    response = configure_outputs(client, auth_headers, gcode_file.id, catalog, items=[
        {"product_id": catalog["body"].id, "qty_per_run": 8, "plate": 1},
        {"product_id": catalog["lid"].id, "qty_per_run": 4},
    ])
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["output_warehouse_id"] == catalog["warehouse"].id
    assert len(data["outputs"]) == 2
    assert data["outputs"][0]["product_name"].startswith("CASE-001")

    listing = client.get("/api/files", headers=auth_headers).json()
    summary = next(f for f in listing if f["id"] == gcode_file.id)
    assert len(summary["outputs"]) == 2

    # Empty items clear the configuration entirely.
    cleared = client.put(f"/api/files/{gcode_file.id}/outputs", json={"items": []}, headers=auth_headers)
    assert cleared.status_code == 200
    assert cleared.json()["outputs"] == []
    assert cleared.json()["output_warehouse_id"] is None


def test_file_outputs_reject_foreign_and_archived_products(client, auth_headers, db_session, test_org, catalog, gcode_file):
    foreign_org = Organization(name="Other", slug="outputs-foreign")
    db_session.add(foreign_org)
    db_session.flush()
    foreign = Product(organization_id=foreign_org.id, name="Private", sku="OTHER", unit="pcs")
    archived = Product(organization_id=test_org.id, name="Old", sku="OLD", unit="pcs", is_active=False)
    db_session.add_all([foreign, archived])
    db_session.commit()

    assert client.put(f"/api/files/{gcode_file.id}/outputs", json={
        "items": [{"product_id": foreign.id, "qty_per_run": 1}],
    }, headers=auth_headers).status_code == 400
    assert client.put(f"/api/files/{gcode_file.id}/outputs", json={
        "items": [{"product_id": archived.id, "qty_per_run": 1}],
    }, headers=auth_headers).status_code == 400
    # Duplicate product+plate positions are rejected.
    assert client.put(f"/api/files/{gcode_file.id}/outputs", json={
        "items": [
            {"product_id": catalog["body"].id, "qty_per_run": 1},
            {"product_id": catalog["body"].id, "qty_per_run": 2},
        ],
    }, headers=auth_headers).status_code == 422


def test_file_outputs_require_paid_plan(client, auth_headers, test_org, catalog, gcode_file):
    test_org.plan = OrgPlan.free
    response = configure_outputs(client, auth_headers, gcode_file.id, catalog)
    assert response.status_code == 403


def test_product_delete_blocked_by_file_links(client, auth_headers, db_session, catalog, gcode_file):
    configure_outputs(client, auth_headers, gcode_file.id, catalog)
    response = client.delete(f"/api/warehouse/products/{catalog['body'].id}", headers=auth_headers)
    assert response.status_code == 409
    assert "файл" in response.json()["detail"]


# ── Run plan snapshot ────────────────────────────────────────────────────────

def test_plan_is_frozen_at_send_time(client, auth_headers, db_session, test_org, catalog, gcode_file):
    configure_outputs(client, auth_headers, gcode_file.id, catalog)
    job = bambu_dispatch.create_cloud_job(
        db_session, org_id=test_org.id, printer_id=_printer(db_session, test_org).id,
        printer_bambu_dev_id=None, gcode_file_id=gcode_file.id,
        file_name=gcode_file.original_name, dispatch_mode="moonraker",
        output_plan=file_outputs.build_output_plan(db_session, test_org.id, gcode_file.id),
    )
    assert job.output_plan["items"] == [{
        "product_id": catalog["body"].id,
        "product_name": "CASE-001 · Корпус",
        "planned_qty": 8,
    }]
    assert job.output_plan["warehouse_id"] == catalog["warehouse"].id

    # Changing the file links afterwards never alters an existing run.
    configure_outputs(client, auth_headers, gcode_file.id, catalog, items=[
        {"product_id": catalog["lid"].id, "qty_per_run": 99},
    ])
    db_session.refresh(job)
    assert job.output_plan["items"][0]["product_id"] == catalog["body"].id
    assert job.output_plan["items"][0]["planned_qty"] == 8


def test_plan_plate_selection(db_session, test_org, catalog, gcode_file):
    db_session.add_all([
        GcodeFileOutput(organization_id=test_org.id, gcode_file_id=gcode_file.id,
                        product_id=catalog["body"].id, qty_per_run=8, plate=1),
        GcodeFileOutput(organization_id=test_org.id, gcode_file_id=gcode_file.id,
                        product_id=catalog["lid"].id, qty_per_run=4, plate=2),
        GcodeFileOutput(organization_id=test_org.id, gcode_file_id=gcode_file.id,
                        product_id=catalog["body"].id, qty_per_run=1, plate=None),
    ])
    db_session.commit()

    whole = file_outputs.build_output_plan(db_session, test_org.id, gcode_file.id)
    assert len(whole["items"]) == 1
    assert whole["plate"] == 1
    plate_one = file_outputs.build_output_plan(db_session, test_org.id, gcode_file.id, plate=1)
    assert {(i["product_id"], i["planned_qty"]) for i in plate_one["items"]} == {
        (catalog["body"].id, 9),
    }
    plate_two = file_outputs.build_output_plan(db_session, test_org.id, gcode_file.id, plate=2)
    # A NULL-plate row applies to every plate.
    assert {i["product_id"] for i in plate_two["items"]} == {catalog["lid"].id, catalog["body"].id}


def _printer(db_session, org, name="Plan U1") -> Printer:
    printer = Printer(organization_id=org.id, name=name, kind=PrinterKind.other,
                      manual_status="operational", manual_job="case_plate.gcode")
    db_session.add(printer)
    db_session.commit()
    return printer


def _job_with_plan(db_session, org, printer, file, catalog, *, task_id=None, batch_id=None):
    job = bambu_dispatch.create_cloud_job(
        db_session, org_id=org.id, printer_id=printer.id, printer_bambu_dev_id=None,
        gcode_file_id=file.id, file_name=file.original_name, dispatch_mode="moonraker",
        output_plan={
            "file_id": file.id,
            "plate": None,
            "warehouse_id": catalog["warehouse"].id,
            "print_task_id": task_id,
            "production_batch_id": batch_id,
            "items": [{
                "product_id": catalog["body"].id,
                "product_name": "CASE-001 · Корпус",
                "planned_qty": 8,
            }],
        },
    )
    now = datetime.now(timezone.utc)
    history = PrintHistory(
        organization_id=org.id, printer_id=printer.id, printer_name=printer.name,
        file_name=file.original_name, result="completed",
        started_at=now - timedelta(hours=1), finished_at=now,
        bambu_cloud_job_id=job.id,
    )
    db_session.add(history)
    db_session.commit()
    return job, history


# ── Clear-bed with a plan ────────────────────────────────────────────────────

def test_context_prefills_plan(client, auth_headers, db_session, test_org, catalog, gcode_file):
    printer = _printer(db_session, test_org)
    _job_with_plan(db_session, test_org, printer, gcode_file, catalog)
    context = client.get(f"/api/printers/{printer.id}/print/output-context", headers=auth_headers).json()
    assert context["plan"] is not None
    assert context["plan"]["items"][0]["product_id"] == catalog["body"].id
    assert context["plan"]["items"][0]["planned_qty"] == 8
    assert context["plan"]["warehouse_id"] == catalog["warehouse"].id


def test_direct_file_print_receipts_planned_product(
    client, auth_headers, db_session, test_org, catalog, gcode_file,
):
    printer = _printer(db_session, test_org)
    _, history = _job_with_plan(db_session, test_org, printer, gcode_file, catalog)
    payload = {
        "request_id": str(uuid4()), "history_id": history.id, "file_name": "case_plate.gcode",
        "output": {"items": [{"product_id": catalog["body"].id, "pieces_ok": 7, "pieces_defective": 1}],
                   "warehouse_id": catalog["warehouse"].id, "defect_reason": "Warp"},
    }
    response = client.post(f"/api/printers/{printer.id}/print/clear-bed", headers=auth_headers, json=payload)
    assert response.status_code == 200, response.text
    movement = db_session.query(WarehouseMovement).one()
    assert movement.print_history_id is not None
    assert db_session.query(StockEntry).one().quantity == 7


def test_batch_linked_run_updates_batch_without_movements(
    client, auth_headers, db_session, test_org, catalog, gcode_file,
):
    printer = _printer(db_session, test_org)
    task = PrintTask(organization_id=test_org.id, title="Batch run", quantity=32)
    db_session.add(task)
    db_session.flush()
    batch = ProductionBatch(
        organization_id=test_org.id, product_id=catalog["body"].id,
        target_qty=32, print_task_id=task.id,
    )
    db_session.add(batch)
    db_session.commit()
    _, history = _job_with_plan(db_session, test_org, printer, gcode_file, catalog,
                                task_id=task.id, batch_id=batch.id)

    payload = {
        "request_id": str(uuid4()), "history_id": history.id, "file_name": "case_plate.gcode",
        "output": {"items": [{"product_id": catalog["body"].id, "pieces_ok": 7, "pieces_defective": 1}],
                   "warehouse_id": catalog["warehouse"].id, "defect_reason": None},
    }
    response = client.post(f"/api/printers/{printer.id}/print/clear-bed", headers=auth_headers, json=payload)
    assert response.status_code == 200, response.text
    db_session.expire_all()
    assert db_session.query(WarehouseMovement).count() == 0
    updated = db_session.get(ProductionBatch, batch.id)
    assert (updated.printed_qty, updated.good_qty, updated.defect_qty) == (8, 7, 1)

    # Completing the linked task afterwards must not double-count the batch.
    done = client.patch(f"/api/queue/{task.id}", headers=auth_headers,
                        json={"status": "done", "pieces_ok": 7, "pieces_defective": 1})
    assert done.status_code == 200, done.text
    db_session.expire_all()
    updated = db_session.get(ProductionBatch, batch.id)
    assert (updated.printed_qty, updated.good_qty, updated.defect_qty) == (8, 7, 1)
    assert db_session.query(WarehouseMovement).count() == 0


def test_task_run_receipts_once_and_task_done_does_not_double(
    client, auth_headers, db_session, test_org, catalog, gcode_file,
):
    printer = _printer(db_session, test_org)
    task = PrintTask(organization_id=test_org.id, title="Standalone", quantity=8,
                     product_id=catalog["body"].id)
    db_session.add(task)
    db_session.commit()
    _, history = _job_with_plan(db_session, test_org, printer, gcode_file, catalog, task_id=task.id)

    payload = {
        "request_id": str(uuid4()), "history_id": history.id, "file_name": "case_plate.gcode",
        "output": {"items": [{"product_id": catalog["body"].id, "pieces_ok": 7, "pieces_defective": 1}],
                   "warehouse_id": catalog["warehouse"].id, "defect_reason": "Warp"},
    }
    response = client.post(f"/api/printers/{printer.id}/print/clear-bed", headers=auth_headers, json=payload)
    assert response.status_code == 200, response.text
    assert db_session.query(WarehouseMovement).count() == 1

    # Operator later completes the task — must not create a second receipt.
    done = client.patch(f"/api/queue/{task.id}", headers=auth_headers,
                        json={"status": "done", "pieces_ok": 7, "pieces_defective": 1})
    assert done.status_code == 200, done.text
    assert db_session.query(WarehouseMovement).count() == 1
    assert db_session.query(StockEntry).one().quantity == 7


# ── Late accounting from history ─────────────────────────────────────────────

def _attach_payload(catalog, *, ok=7, defective=1):
    return {
        "request_id": str(uuid4()),
        "output": {"items": [{"product_id": catalog["body"].id, "pieces_ok": ok, "pieces_defective": defective}],
                   "warehouse_id": catalog["warehouse"].id, "defect_reason": "Warp"},
    }


def test_history_attach_receipts_without_touching_printer(
    client, auth_headers, db_session, test_org, catalog, gcode_file,
):
    printer = _printer(db_session, test_org)
    _, history = _job_with_plan(db_session, test_org, printer, gcode_file, catalog)
    payload = _attach_payload(catalog)

    response = client.post(f"/api/history/{history.id}/output", headers=auth_headers, json=payload)
    assert response.status_code == 200, response.text
    movement = db_session.query(WarehouseMovement).one()
    assert movement.print_history_id == history.id
    db_session.expire_all()
    assert db_session.get(Printer, printer.id).bed_cleared_at is None

    # Exact replay (lost response) is idempotent; anything else is a conflict.
    assert client.post(f"/api/history/{history.id}/output", headers=auth_headers, json=payload).status_code == 200
    assert db_session.query(WarehouseMovement).count() == 1
    conflict = _attach_payload(catalog)
    conflict["request_id"] = payload["request_id"]
    conflict["output"]["items"][0]["pieces_ok"] = 6
    assert client.post(f"/api/history/{history.id}/output", headers=auth_headers, json=conflict).status_code == 409
    assert client.post(f"/api/history/{history.id}/output", headers=auth_headers,
                       json=_attach_payload(catalog)).status_code == 409
    assert db_session.query(WarehouseMovement).count() == 1

    report = db_session.get(PrintHistory, history.id).output_report
    assert report["recorded_by_id"] is not None
    assert report["items"][0]["planned_qty"] == 8


def test_history_attach_rejects_in_progress_and_foreign_rows(
    client, auth_headers, db_session, test_org, catalog,
):
    printer = _printer(db_session, test_org)
    running = PrintHistory(organization_id=test_org.id, printer_id=printer.id,
                           printer_name=printer.name, result="in_progress",
                           started_at=datetime.now(timezone.utc))
    db_session.add(running)
    db_session.commit()
    assert client.post(f"/api/history/{running.id}/output", headers=auth_headers,
                       json=_attach_payload(catalog)).status_code == 409

    other = Organization(name="Other", slug="history-private")
    db_session.add(other)
    db_session.flush()
    foreign = PrintHistory(organization_id=other.id, printer_id=printer.id,
                           printer_name=printer.name, result="completed",
                           started_at=datetime.now(timezone.utc))
    db_session.add(foreign)
    db_session.commit()
    assert client.get(f"/api/history/{foreign.id}/output-context", headers=auth_headers).status_code == 404
    assert client.post(f"/api/history/{foreign.id}/output", headers=auth_headers,
                       json=_attach_payload(catalog)).status_code == 404


def test_free_plan_cannot_attach_with_warehouse(client, auth_headers, db_session, test_org, catalog, gcode_file):
    test_org.plan = OrgPlan.free
    printer = _printer(db_session, test_org)
    _, history = _job_with_plan(db_session, test_org, printer, gcode_file, catalog)
    assert client.post(f"/api/history/{history.id}/output", headers=auth_headers,
                       json=_attach_payload(catalog)).status_code == 403


@pytest.mark.parametrize("first_good,first_bad", [(7, 1), (0, 8)])
def test_each_task_run_receives_its_own_actuals(
    client, auth_headers, db_session, test_org, catalog, gcode_file, first_good, first_bad,
):
    task = PrintTask(organization_id=test_org.id, title="Multiple runs", quantity=24,
                     product_id=catalog["body"].id)
    db_session.add(task)
    db_session.commit()
    for index, (ok, bad) in enumerate([(first_good, first_bad), (8, 0), (6, 2)]):
        printer = _printer(db_session, test_org, name=f"Run {index}")
        _, history = _job_with_plan(db_session, test_org, printer, gcode_file, catalog, task_id=task.id)
        payload = _attach_payload(catalog, ok=ok, defective=bad)
        response = client.post(f"/api/history/{history.id}/output", headers=auth_headers, json=payload)
        assert response.status_code == 200, response.text
        assert client.post(f"/api/history/{history.id}/output", headers=auth_headers, json=payload).status_code == 200
    assert db_session.query(StockEntry).one().quantity == first_good + 14
    done = client.patch(f"/api/queue/{task.id}", headers=auth_headers,
                        json={"status": "done", "pieces_ok": 24, "pieces_defective": 0})
    assert done.status_code == 200, done.text
    db_session.refresh(task)
    assert (task.pieces_ok, task.pieces_defective) == (first_good + 14, first_bad + 2)
    assert db_session.query(StockEntry).one().quantity == first_good + 14


def test_fully_defective_run_then_successful_run_accounts_only_the_success(
    client, auth_headers, db_session, test_org, catalog, gcode_file,
):
    """Acceptance: a scrapped run leaves no receipt; the next run of the same task does."""
    task = PrintTask(organization_id=test_org.id, title="Scrap first", quantity=12,
                     product_id=catalog["body"].id)
    db_session.add(task)
    db_session.commit()

    printer = _printer(db_session, test_org, name="Scrap run")
    _, failed = _job_with_plan(db_session, test_org, printer, gcode_file, catalog, task_id=task.id)
    scrapped = _attach_payload(catalog, ok=0, defective=8)
    assert client.post(f"/api/history/{failed.id}/output", headers=auth_headers, json=scrapped).status_code == 200
    assert db_session.query(WarehouseMovement).count() == 0
    # Fully defective run needs no warehouse later — it is already final (no_output).
    assert client.get("/api/history?unreported=true", headers=auth_headers).json() == []

    _, good = _job_with_plan(db_session, test_org, printer, gcode_file, catalog, task_id=task.id)
    success = _attach_payload(catalog, ok=6, defective=0)
    assert client.post(f"/api/history/{good.id}/output", headers=auth_headers, json=success).status_code == 200
    assert db_session.query(StockEntry).one().quantity == 6

    db_session.refresh(task)
    assert (task.pieces_ok, task.pieces_defective) == (6, 8)
    done = client.patch(f"/api/queue/{task.id}", headers=auth_headers,
                        json={"status": "done", "pieces_ok": 12, "pieces_defective": 0})
    assert done.status_code == 200, done.text
    db_session.refresh(task)
    assert (task.pieces_ok, task.pieces_defective) == (6, 8)
    assert db_session.query(StockEntry).one().quantity == 6


def test_counts_only_can_be_received_later_and_preserve_audit(
    client, auth_headers, db_session, test_org, catalog, gcode_file,
):
    task = PrintTask(organization_id=test_org.id, title="Pending", quantity=8,
                     product_id=catalog["body"].id)
    db_session.add(task)
    db_session.commit()
    printer = _printer(db_session, test_org)
    _, history = _job_with_plan(db_session, test_org, printer, gcode_file, catalog, task_id=task.id)
    payload = _attach_payload(catalog)
    payload["output"]["warehouse_id"] = None
    assert client.post(f"/api/history/{history.id}/output", headers=auth_headers, json=payload).status_code == 200
    assert db_session.query(WarehouseMovement).count() == 0
    pending = client.get("/api/history?unreported=true", headers=auth_headers)
    assert pending.status_code == 200, pending.text
    assert [row["id"] for row in pending.json()] == [history.id]
    assert pending.json()[0]["output_report"]["accounting_state"] == "pending"
    # Reusing the same UUID with changed data must conflict even while pending.
    payload["output"]["warehouse_id"] = catalog["warehouse"].id
    assert client.post(f"/api/history/{history.id}/output", headers=auth_headers, json=payload).status_code == 409
    payload["request_id"] = str(uuid4())
    received = client.post(f"/api/history/{history.id}/output", headers=auth_headers, json=payload)
    assert received.status_code == 200, received.text
    db_session.refresh(task)
    db_session.refresh(history)
    assert (task.pieces_ok, task.pieces_defective) == (7, 1)
    assert history.output_report["previous_report"]["accounting_state"] == "pending"
    assert client.get("/api/history?unreported=true", headers=auth_headers).json() == []
    assert db_session.query(StockEntry).one().quantity == 7


def test_defer_untracked_print_and_replay_during_next_run(
    client, auth_headers, db_session, test_org, catalog,
):
    printer = _printer(db_session, test_org)
    path = f"/api/printers/{printer.id}/print/clear-bed"
    payload = {"request_id": str(uuid4()), "history_id": None, "file_name": "external.gcode"}
    response = client.post(path, headers=auth_headers, json=payload)
    assert response.status_code == 200, response.text
    history = db_session.query(PrintHistory).one()
    assert history.output_report is None
    assert history.file_name == "external.gcode"
    db_session.refresh(printer)
    printer.bed_cleared_at = None
    printer.manual_status = "printing"
    db_session.commit()
    assert client.post(path, headers=auth_headers, json=payload).status_code == 200
    db_session.refresh(printer)
    assert printer.bed_cleared_at is None
    assert printer.manual_status == "printing"
    assert db_session.query(PrintHistory).count() == 1
    pending = client.get("/api/history?unreported=true", headers=auth_headers)
    assert [row["id"] for row in pending.json()] == [history.id]


@pytest.mark.parametrize("closed", [True, False])
def test_batch_rejects_closed_or_mismatched_output(
    client, auth_headers, db_session, test_org, catalog, gcode_file, closed,
):
    from app.models.warehouse import BatchStatus
    printer = _printer(db_session, test_org)
    batch = ProductionBatch(organization_id=test_org.id, product_id=catalog["body"].id,
                            target_qty=8, status=BatchStatus.done if closed else BatchStatus.active)
    db_session.add(batch)
    db_session.commit()
    _, history = _job_with_plan(db_session, test_org, printer, gcode_file, catalog, batch_id=batch.id)
    payload = _attach_payload(catalog)
    if not closed:
        payload["output"]["items"][0]["product_id"] = catalog["lid"].id
    response = client.post(f"/api/history/{history.id}/output", headers=auth_headers, json=payload)
    assert response.status_code == (409 if closed else 400), response.text
    assert db_session.query(WarehouseMovement).count() == 0
    db_session.refresh(batch)
    assert batch.good_qty == 0


def test_single_product_receipt_uses_actual_material_cost(
    client, auth_headers, db_session, test_org, catalog, gcode_file,
):
    from decimal import Decimal
    printer = _printer(db_session, test_org)
    _, history = _job_with_plan(db_session, test_org, printer, gcode_file, catalog)
    history.material_cost = 70
    db_session.commit()
    response = client.post(f"/api/history/{history.id}/output", headers=auth_headers, json=_attach_payload(catalog))
    assert response.status_code == 200, response.text
    assert db_session.query(WarehouseMovement).one().unit_cost == Decimal(10)
    db_session.refresh(catalog["body"])
    assert catalog["body"].cost_price == Decimal(10)


def test_manual_task_receipt_before_reports_stays_single(
    client, auth_headers, db_session, test_org, catalog, gcode_file,
):
    task = PrintTask(organization_id=test_org.id, title="Manual total", quantity=16,
                     product_id=catalog["body"].id)
    db_session.add(task)
    db_session.commit()
    done = client.patch(f"/api/queue/{task.id}", headers=auth_headers,
                        json={"status": "done", "pieces_ok": 14, "pieces_defective": 2})
    assert done.status_code == 200, done.text
    for index in range(2):
        printer = _printer(db_session, test_org, f"Manual {index}")
        _, history = _job_with_plan(db_session, test_org, printer, gcode_file, catalog, task_id=task.id)
        response = client.post(f"/api/history/{history.id}/output", headers=auth_headers, json=_attach_payload(catalog))
        assert response.status_code == 200, response.text
    db_session.refresh(task)
    assert (task.pieces_ok, task.pieces_defective) == (14, 2)
    assert db_session.query(StockEntry).one().quantity == 14
    assert db_session.query(WarehouseMovement).count() == 1


def test_bambu_lan_dispatch_sends_selected_physical_plate(
    db_session, test_org, catalog, gcode_file, monkeypatch,
):
    import asyncio
    import io
    import zipfile
    from contextlib import contextmanager
    from unittest.mock import AsyncMock
    from app.core import db as core_db
    from app.services import bambu_lan_dispatch, storage, tunnel
    from app.models.bambu_cloud_job import BambuCloudJobStatus

    printer = _printer(db_session, test_org)
    printer.kind = PrinterKind.bambu
    printer.bambu_dev_id = "TEST-DEVICE"
    printer.bambu_dev_ip = "192.0.2.1"
    printer.bambu_access_code = "test-only"
    printer.bambu_model = "A1"
    gcode_file.original_name = "plates.3mf"
    db_session.commit()
    job = bambu_dispatch.create_cloud_job(
        db_session, org_id=test_org.id, printer_id=printer.id,
        printer_bambu_dev_id=printer.bambu_dev_id, gcode_file_id=gcode_file.id,
        file_name=gcode_file.original_name, dispatch_mode="lan", request_payload={"plate": 2},
    )
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("Metadata/plate_1.gcode", "G28\n")
        zf.writestr("Metadata/plate_2.gcode", "G28\n")

    @contextmanager
    def session():
        yield db_session

    monkeypatch.setattr(core_db, "SessionLocal", session)
    monkeypatch.setattr(storage, "get_bytes", lambda *args: archive.getvalue())
    monkeypatch.setattr(storage, "presigned_url", lambda *args, **kwargs: None)
    monkeypatch.setattr(tunnel, "has_tunnel", lambda *args: True)
    upload = AsyncMock(return_value="sdcard/plates.3mf")
    mqtt = AsyncMock()
    monkeypatch.setattr(tunnel, "send_bambu_upload", upload)
    monkeypatch.setattr(tunnel, "send_bambu_mqtt", mqtt)
    result = asyncio.run(bambu_lan_dispatch.dispatch_lan_job(job.id))
    assert result.status == BambuCloudJobStatus.task_created, result.error_msg
    assert mqtt.await_args.args[-1]["print"]["param"] == "Metadata/plate_2.gcode"


def test_plate_metadata_and_plan_follow_actual_archive(
    client, auth_headers, db_session, test_org, catalog, gcode_file, monkeypatch, tmp_path,
):
    import zipfile
    from contextlib import contextmanager
    from app.services import storage
    path = tmp_path / "plates.3mf"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("Metadata/plate_2.gcode", "; filament_type = PLA\n; filament used [g] = 8\n")
        zf.writestr("Metadata/plate_3.gcode", "; filament_type = PETG\n; filament used [g] = 14\n")

    @contextmanager
    def local_path(*args):
        yield path

    monkeypatch.setattr(storage, "local_path_for", local_path)
    gcode_file.original_name = "plates.3mf"
    db_session.commit()
    configure_outputs(client, auth_headers, gcode_file.id, catalog)
    assert client.get(f"/api/files/{gcode_file.id}/plates", headers=auth_headers).json() == [2, 3]
    meta = client.get(f"/api/files/{gcode_file.id}/plates/3", headers=auth_headers).json()
    assert meta["types"] == ["PETG"]
    assert meta["used_g"] == [14]
    assert file_outputs.build_output_plan(db_session, test_org.id, gcode_file.id)["plate"] == 2
    assert client.get(f"/api/files/{gcode_file.id}/plates/1", headers=auth_headers).status_code == 400
