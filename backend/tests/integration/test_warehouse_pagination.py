"""Pagination contract for warehouse collections."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.main import app
from app.models.organization import OrgPlan


@pytest.fixture(autouse=True)
def _warehouse_full_plan(test_org, db_session: Session) -> None:
    test_org.plan = OrgPlan.farm
    test_org.plan_expires_at = None
    db_session.commit()


def test_product_pages_are_stable_and_keep_filters(
    client: TestClient,
    auth_headers: dict[str, str],
) -> None:
    for index in range(5):
        response = client.post(
            "/api/warehouse/products",
            json={"name": f"Paged {index}", "sku": f"PAGE-{index}", "unit": "шт"},
            headers=auth_headers,
        )
        assert response.status_code == 201, response.text

    first = client.get(
        "/api/warehouse/products?search=Paged&skip=0&limit=2",
        headers=auth_headers,
    )
    second = client.get(
        "/api/warehouse/products?search=Paged&skip=2&limit=2",
        headers=auth_headers,
    )

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    first_items = first.json()
    second_items = second.json()
    assert [row["name"] for row in first_items] == ["Paged 0", "Paged 1"]
    assert [row["name"] for row in second_items] == ["Paged 2", "Paged 3"]
    assert {row["id"] for row in first_items}.isdisjoint(row["id"] for row in second_items)


def test_warehouse_page_bounds_are_uniform() -> None:
    schema = app.openapi()
    collection_paths = (
        "/api/warehouse/products",
        "/api/warehouse/products/options",
        "/api/warehouse/counterparties",
        "/api/warehouse/orders",
        "/api/warehouse/batches",
        "/api/warehouse/assembly/sessions",
        "/api/warehouse/cashflow",
        "/api/warehouse/purchases",
        "/api/warehouse/stocktakes",
        "/api/warehouse/stock",
        "/api/warehouse/stock/summary",
        "/api/warehouse/specs/defaults",
        "/api/warehouse/specs/defaults/summary",
        "/api/warehouse/products/{product_id}/cell-history",
    )

    for path in collection_paths:
        params = {
            parameter["name"]: parameter["schema"]
            for parameter in schema["paths"][path]["get"]["parameters"]
        }
        assert params["skip"]["default"] == 0
        assert params["skip"]["minimum"] == 0
        assert params["limit"]["default"] == 100
        assert params["limit"]["minimum"] == 1
        assert params["limit"]["maximum"] == 500


@pytest.mark.parametrize("query", ["skip=-1", "limit=0", "limit=501"])
def test_invalid_product_page_is_rejected(
    query: str,
    client: TestClient,
    auth_headers: dict[str, str],
) -> None:
    response = client.get(f"/api/warehouse/products?{query}", headers=auth_headers)
    assert response.status_code == 422
