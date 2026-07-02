"""Stocktake session lifecycle tests.

Flow under test: create (full/partial) → count (by id / barcode, set/add) →
confirm (surplus → ADJUSTMENT, shortage → WRITE_OFF, uncounted skip|zero) →
session frozen; one open session per warehouse.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.models.organization import OrgPlan


@pytest.fixture(autouse=True)
def _warehouse_full_plan(test_org, db_session):
    test_org.plan = OrgPlan.farm
    test_org.plan_expires_at = None
    db_session.commit()


@pytest.fixture
def setup(client: TestClient, auth_headers: dict[str, str]) -> dict:
    """One warehouse + two products with stock: A=10 (cost 5), B=4."""
    wh = client.post("/api/warehouse/warehouses",
                     json={"name": "Main", "type": "finished"}, headers=auth_headers).json()
    a = client.post("/api/warehouse/products",
                    json={"name": "Alpha", "sku": "A-1", "unit": "шт", "barcode": "111"},
                    headers=auth_headers).json()
    b = client.post("/api/warehouse/products",
                    json={"name": "Beta", "sku": "B-1", "unit": "шт", "barcode": "222"},
                    headers=auth_headers).json()
    for pid, qty in ((a["id"], 10), (b["id"], 4)):
        r = client.post("/api/warehouse/movements",
                        json={"type": "PURCHASE_IN", "product_id": pid,
                              "warehouse_to_id": wh["id"], "quantity": qty, "unit_cost": 5},
                        headers=auth_headers)
        assert r.status_code == 201, r.text
    return {"wh": wh, "a": a, "b": b}


def _stock_qty(client, headers, wh_id, pid) -> float:
    rows = client.get(f"/api/warehouse/stock?warehouse_id={wh_id}&product_id={pid}",
                      headers=headers).json()
    return float(rows[0]["quantity"]) if rows else 0.0


def test_full_stocktake_snapshot_and_confirm(setup, client, auth_headers):
    wh, a, b = setup["wh"], setup["a"], setup["b"]

    r = client.post("/api/warehouse/stocktakes",
                    json={"warehouse_id": wh["id"], "scope": "full"}, headers=auth_headers)
    assert r.status_code == 201, r.text
    st = r.json()
    assert st["status"] == "open"
    assert st["lines_total"] == 2

    # Count Alpha by barcode: found 7 (shortage 3). Beta by id: 6 (surplus 2).
    r = client.post(f"/api/warehouse/stocktakes/{st['id']}/count",
                    json={"code": "111", "quantity": 7}, headers=auth_headers)
    assert r.status_code == 200, r.text
    assert float(r.json()["diff"]) == -3

    r = client.post(f"/api/warehouse/stocktakes/{st['id']}/count",
                    json={"product_id": b["id"], "quantity": 6}, headers=auth_headers)
    assert float(r.json()["diff"]) == 2

    r = client.post(f"/api/warehouse/stocktakes/{st['id']}/confirm",
                    json={"uncounted": "skip"}, headers=auth_headers)
    assert r.status_code == 200, r.text
    done = r.json()
    assert done["status"] == "confirmed"
    assert done["diff_lines"] == 2

    assert _stock_qty(client, auth_headers, wh["id"], a["id"]) == 7
    assert _stock_qty(client, auth_headers, wh["id"], b["id"]) == 6

    # Ledger has the two correction movements with the session reference.
    moves = client.get("/api/warehouse/movements", headers=auth_headers).json()["items"]
    reasons = [m["reason"] for m in moves if m["reason"] and "Інвентаризація" in m["reason"]]
    assert any("нестача" in r for r in reasons)
    assert any("надлишок" in r for r in reasons)


def test_add_mode_accumulates(setup, client, auth_headers):
    wh, a = setup["wh"], setup["a"]
    st = client.post("/api/warehouse/stocktakes",
                     json={"warehouse_id": wh["id"], "scope": "full"}, headers=auth_headers).json()
    client.post(f"/api/warehouse/stocktakes/{st['id']}/count",
                json={"product_id": a["id"], "quantity": 4}, headers=auth_headers)
    r = client.post(f"/api/warehouse/stocktakes/{st['id']}/count",
                    json={"product_id": a["id"], "quantity": 6, "mode": "add"}, headers=auth_headers)
    assert float(r.json()["counted_qty"]) == 10
    assert float(r.json()["diff"]) == 0


def test_uncounted_zero_writes_off_everything(setup, client, auth_headers):
    wh, a, b = setup["wh"], setup["a"], setup["b"]
    st = client.post("/api/warehouse/stocktakes",
                     json={"warehouse_id": wh["id"], "scope": "full"}, headers=auth_headers).json()
    # Count only Alpha at expected qty; Beta left uncounted → zeroed.
    client.post(f"/api/warehouse/stocktakes/{st['id']}/count",
                json={"product_id": a["id"], "quantity": 10}, headers=auth_headers)
    r = client.post(f"/api/warehouse/stocktakes/{st['id']}/confirm",
                    json={"uncounted": "zero"}, headers=auth_headers)
    assert r.status_code == 200, r.text
    assert _stock_qty(client, auth_headers, wh["id"], a["id"]) == 10
    assert _stock_qty(client, auth_headers, wh["id"], b["id"]) == 0


def test_single_open_session_per_warehouse(setup, client, auth_headers):
    wh = setup["wh"]
    r1 = client.post("/api/warehouse/stocktakes",
                     json={"warehouse_id": wh["id"], "scope": "full"}, headers=auth_headers)
    assert r1.status_code == 201
    r2 = client.post("/api/warehouse/stocktakes",
                     json={"warehouse_id": wh["id"], "scope": "full"}, headers=auth_headers)
    assert r2.status_code == 400

    # Cancel unlocks the warehouse for a new session.
    client.post(f"/api/warehouse/stocktakes/{r1.json()['id']}/cancel", headers=auth_headers)
    r3 = client.post("/api/warehouse/stocktakes",
                     json={"warehouse_id": wh["id"], "scope": "full"}, headers=auth_headers)
    assert r3.status_code == 201


def test_partial_scope_requires_products(setup, client, auth_headers):
    wh, a = setup["wh"], setup["a"]
    r = client.post("/api/warehouse/stocktakes",
                    json={"warehouse_id": wh["id"], "scope": "partial"}, headers=auth_headers)
    assert r.status_code == 400

    r = client.post("/api/warehouse/stocktakes",
                    json={"warehouse_id": wh["id"], "scope": "partial",
                          "product_ids": [a["id"]]},
                    headers=auth_headers)
    assert r.status_code == 201
    assert r.json()["lines_total"] == 1


def test_confirmed_session_is_frozen(setup, client, auth_headers):
    wh, a = setup["wh"], setup["a"]
    st = client.post("/api/warehouse/stocktakes",
                     json={"warehouse_id": wh["id"], "scope": "full"}, headers=auth_headers).json()
    client.post(f"/api/warehouse/stocktakes/{st['id']}/confirm",
                json={"uncounted": "skip"}, headers=auth_headers)
    r = client.post(f"/api/warehouse/stocktakes/{st['id']}/count",
                    json={"product_id": a["id"], "quantity": 1}, headers=auth_headers)
    assert r.status_code == 400
