"""Physical bed collection must never lose or double-count operator output."""
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from app.models.filament import FilamentLog
from app.models.organization import Organization, OrgPlan
from app.models.print_history import PrintHistory
from app.models.printer import Printer, PrinterKind
from app.models.warehouse import Product, Warehouse, WarehouseType, WarehouseMovement, StockEntry


@pytest.fixture
def completed_print(db_session, test_org):
    printer = Printer(organization_id=test_org.id, name="Output U1", kind=PrinterKind.other,
                      manual_status="operational", manual_job="parts.gcode")
    db_session.add(printer)
    db_session.flush()
    now = datetime.now(timezone.utc)
    history = PrintHistory(organization_id=test_org.id, printer_id=printer.id,
                           printer_name=printer.name, file_name="parts.gcode", result="completed",
                           started_at=now - timedelta(hours=1), finished_at=now)
    db_session.add(history)
    db_session.commit()
    return printer, history


def report(history_id, *, product_id=None, warehouse_id=None, good=7, defective=2):
    return {"request_id": str(uuid4()), "history_id": history_id, "file_name": "parts.gcode",
            "output": {"items": [{"product_id": product_id, "pieces_ok": good, "pieces_defective": defective}],
                       "warehouse_id": warehouse_id, "defect_reason": "Warping"}}


def test_file_print_records_outcome_without_creating_task_or_deducting_filament(
    client, auth_headers, db_session, completed_print,
):
    printer, history = completed_print
    context = client.get(f"/api/printers/{printer.id}/print/output-context", headers=auth_headers)
    assert context.json()["history_id"] == history.id
    result = client.post(f"/api/printers/{printer.id}/print/clear-bed", headers=auth_headers, json=report(history.id))
    assert result.status_code == 200, result.text
    db_session.refresh(history)
    db_session.refresh(printer)
    assert history.output_report["items"][0]["pieces_ok"] == 7
    assert history.output_report["items"][0]["pieces_defective"] == 2
    assert printer.manual_status == "idle"
    assert printer.last_cleared_history_id == history.id
    assert db_session.query(FilamentLog).count() == 0
    result = client.get(f"/api/history?printer_id={printer.id}", headers=auth_headers)
    assert result.json()[0]["output_report"]["defect_reason"] == "Warping"


def test_receipt_is_atomic_and_retries_do_not_clear_a_subsequent_print(
    client, auth_headers, db_session, completed_print, test_org,
):
    printer, history = completed_print
    test_org.plan = OrgPlan.farm
    product = Product(organization_id=test_org.id, name="Part", sku="PART", unit="pcs")
    warehouse = Warehouse(organization_id=test_org.id, name="Finished", type=WarehouseType.finished)
    db_session.add_all([product, warehouse])
    db_session.commit()
    payload = report(history.id, product_id=product.id, warehouse_id=warehouse.id)
    path = f"/api/printers/{printer.id}/print/clear-bed"
    response = client.post(path, headers=auth_headers, json=payload)
    assert response.status_code == 200, response.text
    # Simulate lost HTTP response and a new print starting before retry.
    db_session.refresh(printer)
    printer.manual_status = "printing"
    printer.manual_job = "next.gcode"
    printer.bed_cleared_at = None
    db_session.commit()
    response = client.post(path, headers=auth_headers, json=payload)
    assert response.status_code == 200, response.text
    db_session.refresh(printer)
    assert printer.manual_status == "printing"
    assert printer.bed_cleared_at is None
    assert db_session.query(WarehouseMovement).count() == 1
    assert db_session.query(StockEntry).one().quantity == 7


def test_invalid_foreign_product_rolls_back_all_positions_and_bed_clear(
    client, auth_headers, db_session, completed_print, test_org,
):
    printer, history = completed_print
    test_org.plan = OrgPlan.farm
    foreign = Organization(name="Other", slug="other-output")
    db_session.add(foreign)
    db_session.flush()
    own_product = Product(organization_id=test_org.id, name="Own", sku="OWN", unit="pcs")
    other_product = Product(organization_id=foreign.id, name="Private", sku="OTHER", unit="pcs")
    warehouse = Warehouse(organization_id=test_org.id, name="Finished", type=WarehouseType.finished)
    db_session.add_all([own_product, other_product, warehouse])
    db_session.commit()
    payload = report(history.id, product_id=own_product.id, warehouse_id=warehouse.id)
    payload["output"]["items"].append({"product_id": other_product.id, "pieces_ok": 4, "pieces_defective": 0})
    response = client.post(f"/api/printers/{printer.id}/print/clear-bed", headers=auth_headers, json=payload)
    assert response.status_code == 400
    db_session.refresh(printer)
    db_session.refresh(history)
    assert history.output_report is None
    assert printer.bed_cleared_at is None
    assert db_session.query(WarehouseMovement).count() == 0


def test_stale_form_cannot_report_a_new_run(client, auth_headers, db_session, completed_print, test_org):
    printer, history = completed_print
    newer = PrintHistory(organization_id=test_org.id, printer_id=printer.id, printer_name=printer.name,
                         file_name="new.gcode", result="completed", started_at=datetime.now(timezone.utc))
    db_session.add(newer)
    db_session.commit()
    response = client.post(f"/api/printers/{printer.id}/print/clear-bed", headers=auth_headers, json=report(history.id))
    assert response.status_code == 409
    db_session.refresh(newer)
    assert newer.output_report is None


@pytest.mark.parametrize("good, defective", [(-1, 0), (1.5, 0), (1, -2), (True, 0), (1_000_001, 0)])
def test_invalid_quantities_do_not_clear_bed(client, auth_headers, completed_print, good, defective):
    printer, history = completed_print
    response = client.post(f"/api/printers/{printer.id}/print/clear-bed", headers=auth_headers,
                           json=report(history.id, good=good, defective=defective))
    assert response.status_code == 422


def test_all_defective_and_untracked_print_can_be_recorded(client, auth_headers, db_session, test_org):
    printer = Printer(organization_id=test_org.id, name="Untracked", kind=PrinterKind.other,
                      manual_status="operational", manual_job="parts.gcode")
    db_session.add(printer)
    db_session.commit()
    payload = report(None, good=0, defective=9)
    path = f"/api/printers/{printer.id}/print/clear-bed"
    assert client.post(path, headers=auth_headers, json=payload).status_code == 200
    assert client.post(path, headers=auth_headers, json=payload).status_code == 200
    assert db_session.query(PrintHistory).count() == 1
    history = db_session.query(PrintHistory).one()
    assert history.output_report["items"][0]["pieces_defective"] == 9
    assert history.duration_minutes is None
    # Another tab must not create a second history row for the same cleared bed.
    assert client.post(path, headers=auth_headers, json=report(None)).status_code == 409


def test_free_plan_can_report_but_cannot_receive_stock(client, auth_headers, completed_print):
    printer, history = completed_print
    response = client.post(f"/api/printers/{printer.id}/print/clear-bed", headers=auth_headers,
                           json=report(history.id, product_id=1, warehouse_id=1))
    assert response.status_code == 403


def test_active_print_cannot_be_cleared(client, auth_headers, db_session, completed_print):
    printer, history = completed_print
    printer.manual_status = "printing"
    db_session.commit()
    response = client.post(f"/api/printers/{printer.id}/print/clear-bed", headers=auth_headers, json=report(history.id))
    assert response.status_code == 409


def test_output_endpoints_are_tenant_scoped(client, auth_headers, db_session):
    other = Organization(name="Other", slug="private-output")
    db_session.add(other)
    db_session.flush()
    printer = Printer(organization_id=other.id, name="Private", kind=PrinterKind.other)
    db_session.add(printer)
    db_session.commit()
    assert client.get(f"/api/printers/{printer.id}/print/output-context", headers=auth_headers).status_code == 404
    assert client.post(f"/api/printers/{printer.id}/print/clear-bed", headers=auth_headers, json=report(None)).status_code == 404
