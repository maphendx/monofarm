from __future__ import annotations

from decimal import Decimal
from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.organization import OrgPlan
from app.models.warehouse import Product


@pytest.fixture(autouse=True)
def _warehouse_full_plan(test_org, db_session: Session) -> None:
    test_org.plan = OrgPlan.farm
    test_org.plan_expires_at = None
    db_session.commit()


def _create_product(
    client: TestClient,
    headers: dict[str, str],
    *,
    name: str,
    sku: str,
    unit: str,
) -> dict:
    response = client.post(
        "/api/warehouse/products",
        json={"name": name, "sku": sku, "unit": unit},
        headers=headers,
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_ordage_spec_import_links_component_by_material_sku(
    client: TestClient,
    auth_headers: dict[str, str],
    db_session: Session,
) -> None:
    finished = _create_product(client, auth_headers, name="Готовий виріб", sku="FG-001", unit="шт")
    material = _create_product(client, auth_headers, name="PLA Black", sku="MAT-PLA-BLK", unit="г")
    material_row = db_session.get(Product, material["id"])
    assert material_row is not None
    material_row.cost_price = Decimal("0.7500")
    db_session.commit()

    header = [
        "Назва виробу", "SKU виробу", "Од. вим. виробу",
        "Пряма собівартість виробу", "Повна собівартість виробу",
        "Назва матеріалу", "SKU матеріалу", "К-сть матеріалу", "Одиниця виміру матеріалу",
        "Сер.зважена ціна матеріалу", "Назва роботи", "К-сть роботи", "Одиниця виміру роботи",
        "Ціна роботи", "Додаткові витрати", "Вартість витрати",
    ]
    product_row = ["Готовий виріб", "FG-001", "шт", "", "", "", "", "", "", "", "", "", "", "", "", ""]
    component_row = ["", "FG-001", "", "", "", "PLA Black from Ordage", "MAT-PLA-BLK", "12.5", "", "", "", "", "", "", "", ""]
    content = "\n".join("\t".join(row) for row in [header, product_row, component_row]).encode("utf-8-sig")

    response = client.post(
        "/api/warehouse/specs/import",
        files={"file": ("specs.tsv", BytesIO(content), "text/tab-separated-values")},
        headers=auth_headers,
    )

    assert response.status_code == 200, response.text
    assert response.json()["updated"] == 1

    specs = client.get(f"/api/warehouse/products/{finished['id']}/specs", headers=auth_headers).json()
    component = specs[0]["components"][0]
    assert component["product_id"] == material["id"]
    assert component["product_name"] == "PLA Black"
    assert component["name"] == "PLA Black"
    assert component["unit"] == "г"
    assert component["unit_price"] == "0.7500"


def test_ordage_spec_import_creates_product_for_unknown_material(
    client: TestClient,
    auth_headers: dict[str, str],
) -> None:
    finished = _create_product(client, auth_headers, name="Корпус", sku="FG-002", unit="шт")

    header = [
        "Назва виробу", "SKU виробу", "Од. вим. виробу",
        "Пряма собівартість виробу", "Повна собівартість виробу",
        "Назва матеріалу", "SKU матеріалу", "К-сть матеріалу", "Одиниця виміру матеріалу",
        "Сер.зважена ціна матеріалу", "Назва роботи", "К-сть роботи", "Одиниця виміру роботи",
        "Ціна роботи", "Додаткові витрати", "Вартість витрати",
    ]
    product_row = ["Корпус", "FG-002", "шт", "", "", "", "", "", "", "", "", "", "", "", "", ""]
    component_row = ["", "FG-002", "", "", "", "Новий матеріал", "", "2", "шт", "7.25", "", "", "", "", "", ""]
    content = "\n".join("\t".join(row) for row in [header, product_row, component_row]).encode("utf-8-sig")

    response = client.post(
        "/api/warehouse/specs/import",
        files={"file": ("specs.tsv", BytesIO(content), "text/tab-separated-values")},
        headers=auth_headers,
    )

    assert response.status_code == 200, response.text
    assert response.json()["errors"] == []

    specs = client.get(f"/api/warehouse/products/{finished['id']}/specs", headers=auth_headers).json()
    component = specs[0]["components"][0]
    assert component["product_id"] is not None
    assert component["product_name"] == "Новий матеріал"
    assert component["unit_price"] == "7.2500"

    products = client.get("/api/warehouse/products", headers=auth_headers).json()
    created = next(p for p in products if p["id"] == component["product_id"])
    assert created["name"] == "Новий матеріал"
    assert created["sku"].startswith("COMP-")
    assert created["cost_price"] == "7.2500"


def test_ordage_spec_import_creates_missing_finished_product(
    client: TestClient,
    auth_headers: dict[str, str],
) -> None:
    header = [
        "Назва виробу", "SKU виробу", "Од. вим. виробу",
        "Пряма собівартість виробу", "Повна собівартість виробу",
        "Назва матеріалу", "SKU матеріалу", "К-сть матеріалу", "Одиниця виміру матеріалу",
        "Сер.зважена ціна матеріалу", "Назва роботи", "К-сть роботи", "Одиниця виміру роботи",
        "Ціна роботи", "Додаткові витрати", "Вартість витрати",
    ]
    product_row = ["Новий виріб", "FG-NEW", "шт", "", "", "", "", "", "", "", "", "", "", "", "", ""]
    component_row = ["", "FG-NEW", "", "", "", "Новий матеріал", "", "2", "шт", "7.25", "", "", "", "", "", ""]
    operation_row = ["", "FG-NEW", "", "", "", "", "", "", "", "", "Друк", "10", "хв", "0.10", "", ""]
    content = "\n".join("\t".join(row) for row in [header, product_row, component_row, operation_row]).encode("utf-8-sig")

    response = client.post(
        "/api/warehouse/specs/import",
        files={"file": ("specs.tsv", BytesIO(content), "text/tab-separated-values")},
        headers=auth_headers,
    )

    assert response.status_code == 200, response.text
    assert response.json() == {"updated": 1, "skipped": 0, "errors": []}

    products = client.get("/api/warehouse/products", headers=auth_headers).json()
    finished = next(p for p in products if p["sku"] == "FG-NEW")
    assert finished["name"] == "Новий виріб"
    assert finished["unit"] == "шт"

    specs = client.get(f"/api/warehouse/products/{finished['id']}/specs", headers=auth_headers).json()
    assert len(specs) == 1
    assert specs[0]["components"][0]["product_name"] == "Новий матеріал"
    assert specs[0]["operations"][0]["name"] == "Друк"


def test_add_spec_component_creates_product_when_not_selected(
    client: TestClient,
    auth_headers: dict[str, str],
) -> None:
    finished = _create_product(client, auth_headers, name="Кришка", sku="FG-003", unit="шт")
    spec_response = client.post(
        f"/api/warehouse/products/{finished['id']}/specs",
        json={"name": "Основна"},
        headers=auth_headers,
    )
    assert spec_response.status_code == 201, spec_response.text
    spec = spec_response.json()

    response = client.post(
        f"/api/warehouse/specs/{spec['id']}/components",
        json={
            "name": "Гвинт M3",
            "quantity": "4",
            "unit": "шт",
            "unit_price": "0.5",
            "waste_pct": "0",
            "sort_order": 0,
        },
        headers=auth_headers,
    )

    assert response.status_code == 201, response.text
    component = response.json()["components"][0]
    assert component["product_id"] is not None
    assert component["product_name"] == "Гвинт M3"
    assert component["name"] == "Гвинт M3"
    assert component["unit_price"] == "0.5000"
