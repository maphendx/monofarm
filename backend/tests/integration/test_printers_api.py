"""Printer CRUD + listing. External integrations (SimplyPrint / Bambu / Moonraker)
are mocked at the fixture level."""
from __future__ import annotations


def test_list_printers_empty(client, auth_headers):
    resp = client.get("/api/printers", headers=auth_headers)
    assert resp.status_code == 200
    assert resp.json() == []


def test_list_printers_requires_auth(client):
    resp = client.get("/api/printers")
    assert resp.status_code == 401


def test_create_manual_printer(client, auth_headers):
    resp = client.post(
        "/api/printers",
        headers=auth_headers,
        json={"name": "U1-01", "kind": "snapmaker_u1", "moonraker_url": "http://192.168.0.10"},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["name"] == "U1-01"
    assert body["kind"] == "snapmaker_u1"
    assert body["moonraker_url"] == "http://192.168.0.10"


def test_create_printer_forbidden_for_operator(client, operator_user):
    from app.core.security import create_access_token

    token = create_access_token(str(operator_user.id), operator_user.role.value, org_id=operator_user.organization_id)
    resp = client.post(
        "/api/printers",
        headers={"Authorization": f"Bearer {token}"},
        json={"name": "OP-CREATED"},
    )
    assert resp.status_code == 403


def test_update_printer(client, auth_headers):
    create = client.post(
        "/api/printers",
        headers=auth_headers,
        json={"name": "Before", "kind": "snapmaker_u1"},
    )
    printer_id = create.json()["id"]

    resp = client.patch(
        f"/api/printers/{printer_id}",
        headers=auth_headers,
        json={"name": "After", "moonraker_url": "http://192.168.0.20"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "After"
    assert body["moonraker_url"] == "http://192.168.0.20"


def test_delete_printer(client, auth_headers):
    create = client.post(
        "/api/printers",
        headers=auth_headers,
        json={"name": "Doomed", "kind": "other"},
    )
    printer_id = create.json()["id"]

    resp = client.delete(f"/api/printers/{printer_id}", headers=auth_headers)
    assert resp.status_code == 204

    # Subsequent list shows it's gone.
    listing = client.get("/api/printers", headers=auth_headers)
    assert all(p["id"] != printer_id for p in listing.json())


def test_claim_bambu_printer_stores_firmware_version(client, auth_headers, monkeypatch):
    from app.services import bambu

    monkeypatch.setattr(
        bambu,
        "list_devices",
        lambda org_id: [
            {
                "dev_id": "BAMBU-CLAIM-1",
                "name": "P1S Office",
                "online": True,
                "dev_model_name": "C12",
                "dev_product_name": "P1S",
                "dev_access_code": "12345678",
            }
        ],
    )
    monkeypatch.setattr(bambu, "get_device_firmware_version", lambda org_id, dev_id: "01.08.02.00")
    monkeypatch.setattr(bambu, "subscribe_device", lambda dev_id, org_id: None)

    resp = client.post("/api/printers/bambu/claim", headers=auth_headers, json={"dev_id": "BAMBU-CLAIM-1"})

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["kind"] == "bambu"
    assert body["bambu_model"] == "P1S"
    assert body["firmware_version"] == "01.08.02.00"


def test_list_printers_includes_moonraker_offline_state(client, auth_headers, mock_external_services):
    create = client.post(
        "/api/printers",
        headers=auth_headers,
        json={"name": "U1-99", "kind": "snapmaker_u1", "moonraker_url": "http://192.168.99.99"},
    )
    assert create.status_code == 201

    resp = client.get("/api/printers", headers=auth_headers)
    assert resp.status_code == 200
    rows = resp.json()
    assert len(rows) == 1
    # The mock returns {"state": "offline"} for every moonraker URL.
    assert rows[0]["state"] == "offline"
    # And get_live_status was called for the moonraker_url-bearing row.
    mock_external_services["moonraker_status"].assert_called()
