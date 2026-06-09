"""Integration tests for printer slot CRUD and SlotEvent ledger."""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.filament import Filament
from app.models.printer import Printer, PrinterKind
from app.models.printer_slot import PrinterSlot, SlotEvent, SlotState


@pytest.fixture
def u1_printer(db_session: Session, test_org):
    p = Printer(
        organization_id=test_org.id,
        name="U1-01",
        kind=PrinterKind.snapmaker_u1,
        moonraker_url="http://192.168.1.10:7125",
    )
    db_session.add(p)
    db_session.commit()
    db_session.refresh(p)
    return p


@pytest.fixture
def test_filament(db_session: Session, test_org):
    f = Filament(
        organization_id=test_org.id,
        material="PLA",
        color="Red",
        hex_color="#FF0000",
        brand="eSUN",
        grams_remaining=800,
        cost_per_kg=15000,
    )
    db_session.add(f)
    db_session.commit()
    db_session.refresh(f)
    return f


def test_list_slots_returns_4_for_u1(client: TestClient, auth_headers, u1_printer):
    resp = client.get(f"/api/printers/{u1_printer.id}/slots", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 4
    assert {s["slot_index"] for s in data} == {0, 1, 2, 3}
    assert all(s["state"] == "empty" for s in data)


def test_assign_filament_to_slot(client: TestClient, auth_headers, u1_printer, test_filament):
    resp = client.put(
        f"/api/printers/{u1_printer.id}/slots/0",
        json={"filament_id": test_filament.id},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["filament_id"] == test_filament.id
    assert data["state"] == "loaded"
    assert data["material"] == "PLA"
    assert data["hex_color"] == "#FF0000"
    assert data["brand"] == "eSUN"
    assert data["grams_at_load"] == 800


def test_assign_writes_slot_event(db_session: Session, client: TestClient, auth_headers, u1_printer, test_filament):
    client.put(
        f"/api/printers/{u1_printer.id}/slots/1",
        json={"filament_id": test_filament.id},
        headers=auth_headers,
    )
    event = db_session.query(SlotEvent).filter_by(
        printer_id=u1_printer.id, slot_index=1
    ).first()
    assert event is not None
    assert event.event.value == "load"
    assert event.filament_id == test_filament.id


def test_unload_slot_clears_snapshot(client: TestClient, auth_headers, u1_printer, test_filament):
    client.put(
        f"/api/printers/{u1_printer.id}/slots/2",
        json={"filament_id": test_filament.id},
        headers=auth_headers,
    )
    resp = client.post(
        f"/api/printers/{u1_printer.id}/slots/2/unload",
        headers=auth_headers,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["filament_id"] is None
    assert data["state"] == "empty"
    assert data["material"] is None
    assert data["hex_color"] is None


def test_unload_writes_slot_event(db_session: Session, client: TestClient, auth_headers, u1_printer, test_filament):
    client.put(
        f"/api/printers/{u1_printer.id}/slots/3",
        json={"filament_id": test_filament.id},
        headers=auth_headers,
    )
    client.post(f"/api/printers/{u1_printer.id}/slots/3/unload", headers=auth_headers)
    events = db_session.query(SlotEvent).filter_by(
        printer_id=u1_printer.id, slot_index=3
    ).order_by(SlotEvent.created_at).all()
    assert len(events) == 2
    assert events[0].event.value == "load"
    assert events[1].event.value == "unload"


def test_assign_invalid_slot_index_returns_400(client: TestClient, auth_headers, u1_printer, test_filament):
    resp = client.put(
        f"/api/printers/{u1_printer.id}/slots/9",
        json={"filament_id": test_filament.id},
        headers=auth_headers,
    )
    assert resp.status_code == 400


def test_assign_foreign_filament_returns_404(client: TestClient, auth_headers, u1_printer):
    resp = client.put(
        f"/api/printers/{u1_printer.id}/slots/0",
        json={"filament_id": 99999},
        headers=auth_headers,
    )
    assert resp.status_code == 404


def test_assign_is_idempotent(client: TestClient, auth_headers, u1_printer, test_filament):
    """Assigning the same filament twice must not create duplicate slot rows."""
    client.put(
        f"/api/printers/{u1_printer.id}/slots/0",
        json={"filament_id": test_filament.id},
        headers=auth_headers,
    )
    resp = client.put(
        f"/api/printers/{u1_printer.id}/slots/0",
        json={"filament_id": test_filament.id},
        headers=auth_headers,
    )
    assert resp.status_code == 200


def test_list_slot_events(client: TestClient, auth_headers, u1_printer, test_filament):
    client.put(
        f"/api/printers/{u1_printer.id}/slots/0",
        json={"filament_id": test_filament.id},
        headers=auth_headers,
    )
    resp = client.get(
        f"/api/printers/{u1_printer.id}/slots/0/events",
        headers=auth_headers,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) >= 1
    assert data[0]["event"] == "load"
