"""Integration tests for printer slot CRUD and SlotEvent ledger."""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.filament import Filament
from app.models.printer import Printer, PrinterKind
from app.models.printer_slot import SlotEvent


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


def test_bambu_loaded_filaments_sync_to_mqtt(client, auth_headers, test_org, monkeypatch):
    from app.services import bambu

    captured = []
    refreshes = []
    monkeypatch.setattr(bambu, "_publish", lambda dev_id, payload, qos=0: captured.append((dev_id, payload, qos)))
    monkeypatch.setattr(
        bambu,
        "publish_printer_refresh",
        lambda org_id, dev_id, reason: refreshes.append((org_id, dev_id, reason)),
        raising=False,
    )
    # The test fixture's DB session is injected by the request; create the row through the API.
    created = client.post(
        "/api/printers",
        headers=auth_headers,
        json={"name": "Bambu A1", "kind": "bambu", "bambu_dev_id": "BAMBU-SYNC"},
    )
    assert created.status_code == 201
    printer_id = created.json()["id"]

    assert created.json()["bambu_has_ams"] is None
    no_ams = client.patch(
        f"/api/printers/{printer_id}",
        headers=auth_headers,
        json={"bambu_has_ams": False},
    )
    assert no_ams.status_code == 200
    assert no_ams.json()["bambu_has_ams"] is False
    auto = client.patch(
        f"/api/printers/{printer_id}",
        headers=auth_headers,
        json={"bambu_has_ams": None},
    )
    assert auto.status_code == 200
    assert auto.json()["bambu_has_ams"] is None

    resp = client.put(
        f"/api/printers/{printer_id}/loaded-filaments",
        headers=auth_headers,
        json=[{"slot": 0, "color": "#ff0000", "color_name": "Red", "type": "PLA", "empty": False, "unit_id": 0}],
    )
    assert resp.status_code == 200, resp.text
    assert captured[0][0] == "BAMBU-SYNC"
    assert captured[0][1]["print"]["tray_color"] == "FF0000FF"
    assert captured[-1][1]["pushing"]["command"] == "pushall"
    assert captured[-1][1]["pushing"]["push_target"] == 1
    assert refreshes == [(test_org.id, "BAMBU-SYNC", "slot_assignment")]


def test_bambu_slot_list_does_not_fabricate_u1_slots(client, auth_headers):
    created = client.post(
        "/api/printers",
        headers=auth_headers,
        json={"name": "Bambu A1", "kind": "bambu", "bambu_dev_id": "BAMBU-SLOTS"},
    )
    assert created.status_code == 201

    resp = client.get(
        f"/api/printers/{created.json()['id']}/slots",
        headers=auth_headers,
    )
    assert resp.status_code == 200
    assert resp.json() == []


def test_assign_bambu_slot_syncs_to_handy(client, auth_headers, test_filament, test_org, monkeypatch):
    from app.services import bambu

    captured = []
    refreshes = []
    monkeypatch.setattr(bambu, "_publish", lambda dev_id, payload, qos=0: captured.append((dev_id, payload, qos)))
    monkeypatch.setattr(
        bambu,
        "publish_printer_refresh",
        lambda org_id, dev_id, reason: refreshes.append((org_id, dev_id, reason)),
        raising=False,
    )
    created = client.post(
        "/api/printers",
        headers=auth_headers,
        json={"name": "Bambu A1", "kind": "bambu", "bambu_dev_id": "BAMBU-HANDY"},
    )
    assert created.status_code == 201

    resp = client.put(
        f"/api/printers/{created.json()['id']}/slots/254",
        headers=auth_headers,
        json={"filament_id": test_filament.id},
    )
    assert resp.status_code == 200, resp.text
    assert captured[0][0] == "BAMBU-HANDY"
    payload = captured[0][1]["print"]
    assert payload["ams_id"] == 255
    assert payload["tray_id"] == 254
    assert payload["tray_color"] == "FF0000FF"
    assert captured[-1][1]["pushing"]["command"] == "pushall"
    assert resp.json()["unit_index"] is None
    assert resp.json()["is_external"] is True
    assert refreshes == [(test_org.id, "BAMBU-HANDY", "slot_assignment")]


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
