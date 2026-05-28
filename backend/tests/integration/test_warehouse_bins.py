"""Bin-level (cell) reconciliation tests.

Invariant under test: for each (product, warehouse),
    sum(CellStock) <= StockEntry.quantity
maintained automatically through every stock movement.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


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
