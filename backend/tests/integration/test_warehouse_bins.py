"""Bin-level (cell) reconciliation tests.

Invariant under test: for each (product, warehouse),
    sum(CellStock) <= StockEntry.quantity
maintained automatically through every stock movement.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.models.organization import OrgPlan


@pytest.fixture(autouse=True)
def _warehouse_full_plan(test_org, db_session):
    """All bin/cell endpoints sit behind require_warehouse_full — grant the
    test org a paid plan so these tests exercise the full warehouse module."""
    test_org.plan = OrgPlan.farm
    test_org.plan_expires_at = None
    db_session.commit()


@pytest.fixture
def setup(client: TestClient, auth_headers: dict[str, str]) -> dict:
    """Create one warehouse, one product, and a 2x2 zone (4 cells)."""
    wh = client.post("/api/warehouse/warehouses",
                     json={"name": "Main", "type": "finished"}, headers=auth_headers).json()
    prod = client.post("/api/warehouse/products",
                       json={"name": "Widget", "sku": "W-1", "unit": "шт"}, headers=auth_headers).json()
    zone = client.post(f"/api/warehouse/warehouses/{wh['id']}/zones",
                       json={"name": "Z", "rows": 2, "cols": 2}, headers=auth_headers).json()
    cells = client.get(f"/api/warehouse/zones/{zone['id']}/cells", headers=auth_headers).json()["cells"]
    return {"wh": wh, "product": prod, "zone": zone, "cells": cells}


def _move(client, headers, **kw):
    r = client.post("/api/warehouse/movements", json=kw, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()


def _stock(client, headers, wh_id, pid):
    rows = client.get(f"/api/warehouse/stock?warehouse_id={wh_id}&product_id={pid}", headers=headers).json()
    return rows[0] if rows else None


def test_inbound_lands_unassigned(setup, client, auth_headers):
    wh, p = setup["wh"], setup["product"]
    _move(client, auth_headers, type="PURCHASE_IN", product_id=p["id"],
          warehouse_to_id=wh["id"], quantity=100, unit_cost=5)

    s = _stock(client, auth_headers, wh["id"], p["id"])
    assert float(s["quantity"]) == 100
    assert float(s["assigned_qty"]) == 0
    assert float(s["unassigned_qty"]) == 100

    un = client.get(f"/api/warehouse/warehouses/{wh['id']}/unassigned", headers=auth_headers).json()
    assert len(un) == 1 and float(un[0]["unassigned"]) == 100


def test_product_update_persists_cell_limit(setup, client, auth_headers):
    p = setup["product"]

    response = client.patch(
        f"/api/warehouse/products/{p['id']}",
        json={"cell_limit": 24},
        headers=auth_headers,
    )

    assert response.status_code == 200, response.text
    assert response.json()["cell_limit"] == 24

    fetched = client.get(f"/api/warehouse/products/{p['id']}", headers=auth_headers)
    assert fetched.status_code == 200, fetched.text
    assert fetched.json()["cell_limit"] == 24


def test_scan_cell_returns_batched_stock_detail(setup, client, auth_headers):
    wh, p, cells = setup["wh"], setup["product"], setup["cells"]
    _move(client, auth_headers, type="PURCHASE_IN", product_id=p["id"],
          warehouse_to_id=wh["id"], quantity=25, unit_cost=5)
    putaway = client.post(f"/api/warehouse/cells/{cells[0]['id']}/putaway",
                          json={"product_id": p["id"], "quantity": 12}, headers=auth_headers)
    assert putaway.status_code == 200, putaway.text

    response = client.get(f"/api/warehouse/scan?q=CELL:{cells[0]['id']}", headers=auth_headers)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["type"] == "cell"
    assert body["cell"]["warehouse_id"] == wh["id"]
    assert body["cell"]["zone_id"] == setup["zone"]["id"]
    assert body["cell"]["stock"] == [{
        "product_id": p["id"],
        "product_name": "Widget",
        "product_sku": "W-1",
        "product_unit": "шт",
        "quantity": "12.0000",
        "image_url": None,
    }]


def test_order_payment_updates_order_and_cashflow(setup, client, auth_headers):
    p = setup["product"]
    order = client.post("/api/warehouse/orders", json={
        "customer_name": "Payment Buyer",
        "items": [{"product_id": p["id"], "quantity": 2, "unit_price": 15}],
    }, headers=auth_headers)
    assert order.status_code == 201, order.text
    order_id = order.json()["id"]

    payment = client.post(f"/api/warehouse/orders/{order_id}/payments",
                          json={"amount": 20, "method": "cash"}, headers=auth_headers)

    assert payment.status_code == 201, payment.text
    assert payment.json()["amount"] == "20.0000"

    fetched = client.get(f"/api/warehouse/orders/{order_id}", headers=auth_headers)
    assert fetched.status_code == 200, fetched.text
    assert fetched.json()["paid_amount"] == "20.0000"

    cashflow = client.get("/api/warehouse/cashflow?limit=10", headers=auth_headers)
    assert cashflow.status_code == 200, cashflow.text
    payment_rows = [row for row in cashflow.json() if row["order_id"] == order_id]
    assert len(payment_rows) == 1
    assert payment_rows[0]["amount"] == "20.0000"
    assert payment_rows[0]["type"] == "income"


def test_putaway_then_clamp_on_oversell(setup, client, auth_headers):
    wh, p, cells = setup["wh"], setup["product"], setup["cells"]
    _move(client, auth_headers, type="PURCHASE_IN", product_id=p["id"],
          warehouse_to_id=wh["id"], quantity=100, unit_cost=5)

    # Put 60 into the first cell → 40 unassigned
    r = client.post(f"/api/warehouse/cells/{cells[0]['id']}/putaway",
                    json={"product_id": p["id"], "quantity": 60}, headers=auth_headers)
    assert r.status_code == 200, r.text
    s = _stock(client, auth_headers, wh["id"], p["id"])
    assert float(s["assigned_qty"]) == 60 and float(s["unassigned_qty"]) == 40

    # Sell 70 (no cell hint). Total → 30, so cells must clamp 60 → 30.
    _move(client, auth_headers, type="SALE_OUT", product_id=p["id"],
          warehouse_from_id=wh["id"], quantity=70)
    s = _stock(client, auth_headers, wh["id"], p["id"])
    assert float(s["quantity"]) == 30
    assert float(s["assigned_qty"]) == 30   # clamped down
    assert float(s["unassigned_qty"]) == 0


def test_putaway_cannot_exceed_unassigned(setup, client, auth_headers):
    wh, p, cells = setup["wh"], setup["product"], setup["cells"]
    _move(client, auth_headers, type="PURCHASE_IN", product_id=p["id"],
          warehouse_to_id=wh["id"], quantity=10, unit_cost=5)
    r = client.post(f"/api/warehouse/cells/{cells[0]['id']}/putaway",
                    json={"product_id": p["id"], "quantity": 25}, headers=auth_headers)
    assert r.status_code == 400


def test_relocate_between_cells(setup, client, auth_headers):
    wh, p, cells = setup["wh"], setup["product"], setup["cells"]
    _move(client, auth_headers, type="PURCHASE_IN", product_id=p["id"],
          warehouse_to_id=wh["id"], quantity=50, unit_cost=5)
    client.post(f"/api/warehouse/cells/{cells[0]['id']}/putaway",
                json={"product_id": p["id"], "quantity": 50}, headers=auth_headers)

    r = client.post("/api/warehouse/cells/relocate",
                    json={"product_id": p["id"], "from_cell_id": cells[0]["id"],
                          "to_cell_id": cells[1]["id"], "quantity": 20}, headers=auth_headers)
    assert r.status_code == 204, r.text

    loc = client.get(f"/api/warehouse/products/{p['id']}/locations", headers=auth_headers).json()
    cells_out = {c["cell_id"]: float(c["quantity"]) for c in loc["warehouses"][0]["cells"]}
    assert cells_out[cells[0]["id"]] == 30
    assert cells_out[cells[1]["id"]] == 20


def test_return_in_and_write_off_movements(setup, client, auth_headers):
    """Regression: RETURN_IN / WRITE_OFF used to AttributeError in create_movement."""
    wh, p = setup["wh"], setup["product"]
    _move(client, auth_headers, type="PURCHASE_IN", product_id=p["id"],
          warehouse_to_id=wh["id"], quantity=20, unit_cost=5)
    _move(client, auth_headers, type="RETURN_IN", product_id=p["id"],
          warehouse_to_id=wh["id"], quantity=5)
    _move(client, auth_headers, type="WRITE_OFF", product_id=p["id"],
          warehouse_from_id=wh["id"], quantity=8)
    s = _stock(client, auth_headers, wh["id"], p["id"])
    assert float(s["quantity"]) == 17


def test_movement_with_target_cell_hint(setup, client, auth_headers):
    wh, p, cells = setup["wh"], setup["product"], setup["cells"]
    _move(client, auth_headers, type="PURCHASE_IN", product_id=p["id"],
          warehouse_to_id=wh["id"], quantity=30, unit_cost=5, cell_to_id=cells[0]["id"])
    loc = client.get(f"/api/warehouse/products/{p['id']}/locations", headers=auth_headers).json()
    wh_loc = loc["warehouses"][0]
    assert float(wh_loc["cells"][0]["quantity"]) == 30
    assert float(wh_loc["unassigned"]) == 0


def test_cell_history_logged(setup, client, auth_headers):
    wh, p, cells = setup["wh"], setup["product"], setup["cells"]
    _move(client, auth_headers, type="PURCHASE_IN", product_id=p["id"],
          warehouse_to_id=wh["id"], quantity=40, unit_cost=5)
    client.post(f"/api/warehouse/cells/{cells[0]['id']}/putaway",
                json={"product_id": p["id"], "quantity": 40}, headers=auth_headers)
    client.post("/api/warehouse/cells/relocate",
                json={"product_id": p["id"], "from_cell_id": cells[0]["id"],
                      "to_cell_id": cells[1]["id"], "quantity": 10}, headers=auth_headers)
    hist = client.get(f"/api/warehouse/products/{p['id']}/cell-history", headers=auth_headers).json()
    kinds = [h["kind"] for h in hist]
    assert "putaway" in kinds and "relocate" in kinds


def test_relocate_does_not_change_stock_entry(setup, client, auth_headers):
    """Relocating between cells must not alter StockEntry.quantity or reserved_qty."""
    wh, p, cells = setup["wh"], setup["product"], setup["cells"]
    _move(client, auth_headers, type="PURCHASE_IN", product_id=p["id"],
          warehouse_to_id=wh["id"], quantity=50, unit_cost=5)
    client.post(f"/api/warehouse/cells/{cells[0]['id']}/putaway",
                json={"product_id": p["id"], "quantity": 50}, headers=auth_headers)

    s_before = _stock(client, auth_headers, wh["id"], p["id"])

    r = client.post("/api/warehouse/cells/relocate",
                    json={"product_id": p["id"], "from_cell_id": cells[0]["id"],
                          "to_cell_id": cells[1]["id"], "quantity": 20}, headers=auth_headers)
    assert r.status_code == 204

    s_after = _stock(client, auth_headers, wh["id"], p["id"])
    assert float(s_after["quantity"]) == float(s_before["quantity"])
    assert float(s_after["reserved_qty"]) == float(s_before["reserved_qty"])
    assert float(s_after["assigned_qty"]) == float(s_before["assigned_qty"])
    assert float(s_after["unassigned_qty"]) == float(s_before["unassigned_qty"])


def test_ship_order_clamps_cells(setup, client, auth_headers):
    """Shipping an order (confirmed → shipped) must clamp cell allocations."""
    wh, p, cells = setup["wh"], setup["product"], setup["cells"]

    # 1. Stock up and put into cell
    _move(client, auth_headers, type="PURCHASE_IN", product_id=p["id"],
          warehouse_to_id=wh["id"], quantity=100, unit_cost=10)
    client.post(f"/api/warehouse/cells/{cells[0]['id']}/putaway",
                json={"product_id": p["id"], "quantity": 80}, headers=auth_headers)

    # 2. Create order for 60 items
    order = client.post("/api/warehouse/orders", json={
        "customer_name": "Test Buyer",
        "items": [{"product_id": p["id"], "quantity": 60, "unit_price": 20}],
    }, headers=auth_headers).json()

    # 3. Reserve
    r = client.post(f"/api/warehouse/orders/{order['id']}/reserve",
                    json={"warehouse_id": wh["id"]}, headers=auth_headers)
    assert r.status_code == 200

    s = _stock(client, auth_headers, wh["id"], p["id"])
    assert float(s["reserved_qty"]) == 60
    assert float(s["assigned_qty"]) == 80  # cells untouched by reserve

    # 4. Ship — this triggers _clamp_cells_to_stock
    r = client.post(f"/api/warehouse/orders/{order['id']}/ship", headers=auth_headers)
    assert r.status_code == 200, r.text

    s = _stock(client, auth_headers, wh["id"], p["id"])
    assert float(s["quantity"]) == 40       # 100 - 60
    assert float(s["reserved_qty"]) == 0    # released
    # Cells must be clamped: was 80, total now 40, so max in cells = 40
    assert float(s["assigned_qty"]) <= 40
    assert float(s["unassigned_qty"]) >= 0
    # Invariant
    assert float(s["assigned_qty"]) + float(s["unassigned_qty"]) == float(s["quantity"])


def test_reserved_qty_and_cells_coexist(setup, client, auth_headers):
    """reserved_qty is orthogonal to cell allocation: reserving stock doesn't affect cells."""
    wh, p, cells = setup["wh"], setup["product"], setup["cells"]

    _move(client, auth_headers, type="PURCHASE_IN", product_id=p["id"],
          warehouse_to_id=wh["id"], quantity=50, unit_cost=5)
    # Put 40 into cell, 10 unassigned
    client.post(f"/api/warehouse/cells/{cells[0]['id']}/putaway",
                json={"product_id": p["id"], "quantity": 40}, headers=auth_headers)

    # Reserve 30 via an order — should not touch cell allocation
    order = client.post("/api/warehouse/orders", json={
        "customer_name": "Reservation Test",
        "items": [{"product_id": p["id"], "quantity": 30, "unit_price": 10}],
    }, headers=auth_headers).json()
    r = client.post(f"/api/warehouse/orders/{order['id']}/reserve",
                    json={"warehouse_id": wh["id"]}, headers=auth_headers)
    assert r.status_code == 200

    s = _stock(client, auth_headers, wh["id"], p["id"])
    assert float(s["quantity"]) == 50       # unchanged
    assert float(s["reserved_qty"]) == 30
    assert float(s["available"]) == 20
    assert float(s["assigned_qty"]) == 40   # cells untouched
    assert float(s["unassigned_qty"]) == 10

    # Putaway the remaining 10 into another cell — should still work
    r = client.post(f"/api/warehouse/cells/{cells[1]['id']}/putaway",
                    json={"product_id": p["id"], "quantity": 10}, headers=auth_headers)
    assert r.status_code == 200

    s = _stock(client, auth_headers, wh["id"], p["id"])
    assert float(s["assigned_qty"]) == 50
    assert float(s["unassigned_qty"]) == 0


def test_full_lifecycle_invariant(setup, client, auth_headers):
    """End-to-end: purchase → putaway → sale → return → write_off,
    checking sum(cells) <= StockEntry at every step."""
    wh, p, cells = setup["wh"], setup["product"], setup["cells"]

    def invariant():
        s = _stock(client, auth_headers, wh["id"], p["id"])
        if s is None:
            return  # no stock yet — invariant trivially holds
        assigned = float(s["assigned_qty"])
        unassigned = float(s["unassigned_qty"])
        total = float(s["quantity"])
        assert assigned + unassigned == total, f"drift: assigned={assigned}+unassigned={unassigned} != total={total}"
        assert assigned >= 0 and unassigned >= 0
        return s

    # Step 1: Purchase 100
    _move(client, auth_headers, type="PURCHASE_IN", product_id=p["id"],
          warehouse_to_id=wh["id"], quantity=100, unit_cost=5)
    s = invariant()
    assert float(s["quantity"]) == 100

    # Step 2: Putaway 70 into cell A, 20 into cell B → 10 unassigned
    client.post(f"/api/warehouse/cells/{cells[0]['id']}/putaway",
                json={"product_id": p["id"], "quantity": 70}, headers=auth_headers)
    client.post(f"/api/warehouse/cells/{cells[1]['id']}/putaway",
                json={"product_id": p["id"], "quantity": 20}, headers=auth_headers)
    s = invariant()
    assert float(s["assigned_qty"]) == 90
    assert float(s["unassigned_qty"]) == 10

    # Step 3: Order 40, reserve, ship → total drops to 60, cells clamped
    order = client.post("/api/warehouse/orders", json={
        "customer_name": "E2E Buyer",
        "items": [{"product_id": p["id"], "quantity": 40, "unit_price": 15}],
    }, headers=auth_headers).json()
    client.post(f"/api/warehouse/orders/{order['id']}/reserve",
                json={"warehouse_id": wh["id"]}, headers=auth_headers)
    invariant()  # reserve doesn't change totals or cells
    client.post(f"/api/warehouse/orders/{order['id']}/ship", headers=auth_headers)
    s = invariant()
    assert float(s["quantity"]) == 60

    # Step 4: Return 5
    _move(client, auth_headers, type="RETURN_IN", product_id=p["id"],
          warehouse_to_id=wh["id"], quantity=5)
    s = invariant()
    assert float(s["quantity"]) == 65

    # Step 5: Write off 10
    _move(client, auth_headers, type="WRITE_OFF", product_id=p["id"],
          warehouse_from_id=wh["id"], quantity=10)
    s = invariant()
    assert float(s["quantity"]) == 55

    # Step 6: Transfer 15 to a second warehouse
    wh2 = client.post("/api/warehouse/warehouses",
                      json={"name": "Secondary", "type": "raw"}, headers=auth_headers).json()
    _move(client, auth_headers, type="TRANSFER", product_id=p["id"],
          warehouse_from_id=wh["id"], warehouse_to_id=wh2["id"], quantity=15)
    s = invariant()
    assert float(s["quantity"]) == 40

    # Final: assigned must not exceed 40
    assert float(s["assigned_qty"]) <= 40


def test_ship_with_explicit_picks(setup, client, auth_headers):
    """Operator-specified picks pull from the chosen cell (no FIFO teleportation)."""
    wh, p, cells = setup["wh"], setup["product"], setup["cells"]
    _move(client, auth_headers, type="PURCHASE_IN", product_id=p["id"],
          warehouse_to_id=wh["id"], quantity=20, unit_cost=5)
    # A=10 (older), B=10 (newer)
    client.post(f"/api/warehouse/cells/{cells[0]['id']}/putaway",
                json={"product_id": p["id"], "quantity": 10}, headers=auth_headers)
    client.post(f"/api/warehouse/cells/{cells[1]['id']}/putaway",
                json={"product_id": p["id"], "quantity": 10}, headers=auth_headers)

    order = client.post("/api/warehouse/orders", json={
        "customer_name": "Pick Buyer",
        "items": [{"product_id": p["id"], "quantity": 6, "unit_price": 10}],
    }, headers=auth_headers).json()
    client.post(f"/api/warehouse/orders/{order['id']}/reserve",
                json={"warehouse_id": wh["id"]}, headers=auth_headers)

    # Pick all 6 from cell B (newer) — FIFO alone would have hit A first.
    r = client.post(f"/api/warehouse/orders/{order['id']}/ship", headers=auth_headers,
                    json={"picks": [{"product_id": p["id"], "cell_id": cells[1]["id"], "quantity": 6}]})
    assert r.status_code == 200, r.text

    loc = client.get(f"/api/warehouse/products/{p['id']}/locations", headers=auth_headers).json()
    by_cell = {c["cell_id"]: float(c["quantity"]) for c in loc["warehouses"][0]["cells"]}
    assert by_cell.get(cells[0]["id"]) == 10   # A untouched
    assert by_cell.get(cells[1]["id"]) == 4    # B drew the 6


def test_set_cell_stock_capped_to_unassigned(setup, client, auth_headers):
    wh, p, cells = setup["wh"], setup["product"], setup["cells"]
    _move(client, auth_headers, type="PURCHASE_IN", product_id=p["id"],
          warehouse_to_id=wh["id"], quantity=10, unit_cost=5)
    r = client.put(f"/api/warehouse/cells/{cells[0]['id']}/stock",
                   json={"product_id": p["id"], "quantity": 15}, headers=auth_headers)
    assert r.status_code == 400


def test_cell_notes_patch(setup, client, auth_headers):
    cells = setup["cells"]
    r = client.patch(f"/api/warehouse/cells/{cells[0]['id']}",
                     json={"notes": "верхня полиця"}, headers=auth_headers)
    assert r.status_code == 200, r.text
    assert r.json()["notes"] == "верхня полиця"


def test_cell_numbering_row_letter_col_number(client, auth_headers):
    """Codes are row-letter + column-number, in row-major grid order."""
    wh = client.post("/api/warehouse/warehouses",
                     json={"name": "Num", "type": "finished"}, headers=auth_headers).json()
    zone = client.post(f"/api/warehouse/warehouses/{wh['id']}/zones",
                       json={"name": "Z", "rows": 2, "cols": 3}, headers=auth_headers).json()
    cells = client.get(f"/api/warehouse/zones/{zone['id']}/cells", headers=auth_headers).json()["cells"]
    assert [c["code"] for c in cells] == ["A1", "A2", "A3", "B1", "B2", "B3"]


def test_all_zones_overview(setup, client, auth_headers):
    rows = client.get("/api/warehouse/zones", headers=auth_headers).json()
    assert len(rows) >= 1
    z = rows[0]
    assert "warehouse_name" in z and "cell_count" in z and "filled_cells" in z
