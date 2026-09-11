"""Bill-of-materials specifications, costing, and import/export endpoints."""
from decimal import Decimal

import csv
import io

import openpyxl
from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles, require_warehouse_full
from app.core.db import get_db
from app.models.organization import Organization
from app.models.user import User, UserRole
from app.models.warehouse import (
    SpecComponent, SpecOperation,
    SpecOpType, Specification, Product,
)
from app.schemas.warehouse import (
    CostBreakdown, OrdageSpecImportResult, SpecComponentCreate, SpecCreate,
    SpecDefaultSummaryOut, SpecOperationCreate, SpecOut,
)

public_router = APIRouter(tags=["warehouse"])

_ELECTRICITY_RATE = Decimal("4.5")  # ₴/кВт·год
_LABOR_RATE = Decimal("150")  # ₴/год
_PRINTER_WATTS = 200  # Вт

# All routes that require Starter plan or above (full warehouse access).
# Free plan can only access /products and /categories.
full_router = APIRouter(dependencies=[Depends(require_warehouse_full)])

from app.api.warehouse_modules.common import (_calc_cost, _ensure_component_product, _get_product, _get_spec, _norm_lookup, _spec_to_out, _specs_to_out)
from app.api.warehouse_modules.pagination import DEFAULT_PAGE_SIZE, PageLimit, PageOffset

# ── Specifications ────────────────────────────────────────────────────────────

@full_router.get("/products/{product_id}/specs", response_model=list[SpecOut])
def list_specs(
    product_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[SpecOut]:
    _get_product(product_id, org, db)
    specs = db.query(Specification).filter(Specification.product_id == product_id).order_by(Specification.version).all()
    return [_spec_to_out(s, db, org.id) for s in specs]


@full_router.post("/products/{product_id}/specs", response_model=SpecOut, status_code=status.HTTP_201_CREATED)
def create_spec(
    product_id: int,
    payload:    SpecCreate,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin)),
) -> SpecOut:
    _get_product(product_id, org, db)
    existing = db.query(Specification).filter(Specification.product_id == product_id).count()
    spec = Specification(product_id=product_id, name=payload.name, notes=payload.notes, version=existing + 1)
    if existing == 0:
        spec.is_default = True
    db.add(spec)
    db.commit()
    db.refresh(spec)
    return _spec_to_out(spec, db, org.id)


_SPEC_TSV_HEADER = "\t".join([
    "Назва виробу", "SKU виробу", "Од. вим. виробу",
    "Пряма собівартість виробу", "Повна собівартість виробу",
    "Назва матеріалу", "SKU матеріалу", "К-сть матеріалу", "Одиниця виміру матеріалу", "Сер.зважена ціна матеріалу",
    "Назва роботи", "К-сть роботи", "Одиниця виміру роботи", "Ціна роботи", "Додаткові витрати", "Вартість витрати",
])


@full_router.get("/specs/export")
def export_ordage_specs(
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> Response:
    products = (
        db.query(Product)
        .filter(Product.organization_id == org.id, Product.is_active)
        .order_by(Product.name)
        .all()
    )
    rows = [_SPEC_TSV_HEADER]
    blank16 = [""] * 16

    for p in products:
        spec = db.query(Specification).filter_by(product_id=p.id, is_default=True).first()
        if not spec:
            continue
        components = (
            db.query(SpecComponent).filter_by(specification_id=spec.id)
            .order_by(SpecComponent.sort_order).all()
        )
        component_product_ids = {c.product_id for c in components if c.product_id is not None}
        component_skus: dict[int, str] = {}
        if component_product_ids:
            component_skus = {
                product_id: sku
                for product_id, sku in (
                    db.query(Product.id, Product.sku)
                    .filter(Product.organization_id == org.id, Product.id.in_(component_product_ids))
                    .all()
                )
            }
        operations = (
            db.query(SpecOperation).filter_by(specification_id=spec.id)
            .order_by(SpecOperation.sort_order).all()
        )

        row = blank16.copy()
        row[0]  = p.name
        row[1]  = p.sku
        row[2]  = p.unit
        row[3]  = str(p.direct_cost or "")
        row[4]  = str(p.full_cost   or "")
        rows.append("\t".join(row))

        for c in components:
            r = blank16.copy()
            r[1]  = p.sku
            r[5]  = c.name
            r[6]  = component_skus.get(c.product_id, "") if c.product_id else ""
            r[7]  = str(c.quantity)
            r[8]  = c.unit
            r[9]  = str(c.unit_price or "")
            rows.append("\t".join(r))

        for op in operations:
            total = op.explicit_cost or Decimal("0")
            if op.type.value == "print" and op.print_time_min:
                kwh    = Decimal(op.power_watts or _PRINTER_WATTS) * op.print_time_min / 60 / 1000
                total += kwh * _ELECTRICITY_RATE
            if op.labor_minutes:
                total += (op.labor_minutes / 60) * (op.labor_rate_per_hour or _LABOR_RATE)
            r = blank16.copy()
            r[1]  = p.sku
            r[10] = op.name
            r[11] = "1"
            r[13] = str(total.quantize(Decimal("0.0001")))
            rows.append("\t".join(r))

    content = "\n".join(rows).encode("utf-8-sig")
    return Response(
        content=content,
        media_type="text/tab-separated-values; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="specs.tsv"'},
    )


@full_router.get("/specs/defaults", response_model=list[SpecOut])
def list_default_specs(
    skip: PageOffset = 0,
    limit: PageLimit = DEFAULT_PAGE_SIZE,
    db:    Session      = Depends(get_db),
    org:   Organization = Depends(get_current_org),
) -> list[SpecOut]:
    specs = (
        db.query(Specification)
        .join(Product, Product.id == Specification.product_id)
        .filter(
            Product.organization_id == org.id,
            Product.is_active.is_(True),
            Specification.is_default.is_(True),
        )
        .order_by(Product.name, Specification.id)
        .offset(skip)
        .limit(limit)
        .all()
    )
    return _specs_to_out(specs, db, org.id)


@full_router.get("/specs/defaults/summary", response_model=list[SpecDefaultSummaryOut])
def list_default_specs_summary(
    skip: PageOffset = 0,
    limit: PageLimit = DEFAULT_PAGE_SIZE,
    db:    Session      = Depends(get_db),
    org:   Organization = Depends(get_current_org),
) -> list[SpecDefaultSummaryOut]:
    """Lightweight default-spec data for the specifications table."""
    specs = (
        db.query(Specification)
        .join(Product, Product.id == Specification.product_id)
        .filter(
            Product.organization_id == org.id,
            Product.is_active.is_(True),
            Specification.is_default.is_(True),
        )
        .order_by(Product.name, Specification.id)
        .offset(skip)
        .limit(limit)
        .all()
    )
    spec_ids = [s.id for s in specs]
    if not spec_ids:
        return []

    components_by_spec: dict[int, list[str]] = {sid: [] for sid in spec_ids}
    operations_by_spec: dict[int, list[SpecOperation]] = {sid: [] for sid in spec_ids}

    components = (
        db.query(SpecComponent)
        .filter(SpecComponent.specification_id.in_(spec_ids))
        .order_by(SpecComponent.specification_id, SpecComponent.sort_order)
        .all()
    )
    for component in components:
        components_by_spec.setdefault(component.specification_id, []).append(
            f"{component.name} {component.quantity} {component.unit}"
        )

    operations = (
        db.query(SpecOperation)
        .filter(SpecOperation.specification_id.in_(spec_ids))
        .order_by(SpecOperation.specification_id, SpecOperation.sort_order)
        .all()
    )
    for operation in operations:
        operations_by_spec.setdefault(operation.specification_id, []).append(operation)

    rows: list[SpecDefaultSummaryOut] = []
    for spec in specs:
        operations = operations_by_spec.get(spec.id, [])
        rows.append(SpecDefaultSummaryOut(
            product_id=spec.product_id,
            material_labels=components_by_spec.get(spec.id, []),
            work_labels=[op.name for op in operations],
            extra_labels=[
                f"{op.name}: {op.explicit_cost}"
                for op in operations
                if op.explicit_cost is not None and op.explicit_cost > 0
            ],
        ))
    return rows


def _parse_spec_rows(rows: list[list[str]]) -> list[dict]:
    """Shared parser for both TSV and XLSX rows (after normalisation to str lists)."""
    products: list[dict] = []
    current: dict | None = None

    for row in rows[1:]:          # skip header
        while len(row) < 16:
            row.append("")
        product_name = row[0].strip()
        sku          = row[1].strip()
        if not sku:
            continue
        if product_name:
            current = {
                "name": product_name,
                "sku": sku,
                "unit": row[2].strip(),
                "components": [],
                "operations": [],
            }
            products.append(current)
        elif current:
            mat_name = row[5].strip()
            op_name  = row[10].strip()
            if mat_name:
                qty   = row[7].strip()
                price = row[9].strip()
                current["components"].append({
                    "name":       mat_name,
                    "sku":        row[6].strip(),
                    "quantity":   Decimal(qty)   if qty   else Decimal("0"),
                    "unit":       row[8].strip(),
                    "unit_price": Decimal(price) if price else None,
                })
            elif op_name:
                qty   = row[11].strip()
                price = row[13].strip()
                q     = Decimal(qty)   if qty   else Decimal("0")
                p     = Decimal(price) if price else Decimal("0")
                current["operations"].append({
                    "name": op_name,
                    "cost": (q * p) if (q and p) else None,
                    "is_print": "друк" in op_name.lower() or "print" in op_name.lower(),
                })
    return products


def _parse_ordage_spec(content: bytes) -> list[dict]:
    """Parse Ordage spec TSV."""
    text   = content.decode("utf-8-sig")
    reader = csv.reader(io.StringIO(text), delimiter="\t")
    return _parse_spec_rows(list(reader))


def _parse_ordage_xlsx(content: bytes) -> list[dict]:
    """Parse Ordage spec XLSX."""
    wb   = openpyxl.load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    ws   = wb.active
    rows = [
        [str(c).strip() if c is not None else "" for c in row]
        for row in ws.iter_rows(values_only=True)
    ]
    wb.close()
    return _parse_spec_rows(rows)


@full_router.post("/specs/import", response_model=OrdageSpecImportResult)
def import_ordage_specs(
    file: UploadFile      = File(...),
    db:   Session         = Depends(get_db),
    org:  Organization    = Depends(get_current_org),
    user: User            = Depends(require_roles(UserRole.admin)),
) -> OrdageSpecImportResult:
    content  = file.file.read()
    filename = (file.filename or "").lower()
    parsed   = _parse_ordage_xlsx(content) if filename.endswith(".xlsx") else _parse_ordage_spec(content)
    updated, skipped = 0, 0
    errors: list[dict] = []

    org_products = db.query(Product).filter(Product.organization_id == org.id).all()
    product_by_sku = {_norm_lookup(p.sku): p for p in org_products if p.sku}
    product_by_name = {_norm_lookup(p.name): p for p in org_products if p.name}

    for item in parsed:
        product = product_by_sku.get(_norm_lookup(item["sku"]))
        if not product:
            product = Product(
                organization_id=org.id,
                name=item["name"] or item["sku"],
                sku=item["sku"],
                unit=item["unit"] or "шт",
                created_by_id=user.id,
            )
            db.add(product)
            db.flush()
            product_by_sku[_norm_lookup(product.sku)] = product
            product_by_name[_norm_lookup(product.name)] = product

        spec = db.query(Specification).filter_by(product_id=product.id, is_default=True).first()
        if not spec:
            ver  = db.query(Specification).filter_by(product_id=product.id).count()
            spec = Specification(product_id=product.id, name="Основна", is_default=True, version=ver + 1)
            db.add(spec)
            db.flush()

        db.query(SpecComponent).filter_by(specification_id=spec.id).delete()
        for i, c in enumerate(item["components"]):
            component_product = _ensure_component_product(
                db=db,
                org=org,
                user=user,
                name=c["name"],
                sku=c.get("sku"),
                unit=c["unit"],
                unit_price=c["unit_price"],
                product_by_sku=product_by_sku,
                product_by_name=product_by_name,
            )
            component_name = component_product.name
            component_unit = c["unit"] or (component_product.unit if component_product else "шт")
            component_price = c["unit_price"]
            if component_price is None and component_product and component_product.cost_price is not None:
                component_price = component_product.cost_price

            db.add(SpecComponent(
                specification_id=spec.id,
                product_id=component_product.id,
                name=component_name, quantity=c["quantity"],
                unit=component_unit, unit_price=component_price,
                waste_pct=Decimal("0"), sort_order=i,
            ))

        db.query(SpecOperation).filter_by(specification_id=spec.id).delete()
        for i, op in enumerate(item["operations"]):
            n = op["name"].lower()
            t = (SpecOpType.print       if ("друк" in n or "print" in n) else
                 SpecOpType.postprocess if ("постобр" in n or "post" in n) else
                 SpecOpType.manual)
            db.add(SpecOperation(
                specification_id=spec.id,
                type=t, name=op["name"], sort_order=i,
                explicit_cost=op["cost"],
            ))

        db.flush()
        cost = _calc_cost(spec, db, electricity_rate=org.electricity_rate or _ELECTRICITY_RATE, labor_rate=org.labor_rate or _LABOR_RATE)
        product.direct_cost = cost.material_cost + cost.electricity_cost
        product.full_cost   = cost.total
        db.commit()
        updated += 1

    return OrdageSpecImportResult(updated=updated, skipped=skipped, errors=errors)


@full_router.get("/specs/{spec_id}", response_model=SpecOut)
def get_spec(
    spec_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> SpecOut:
    return _spec_to_out(_get_spec(spec_id, org, db), db, org.id)


@full_router.post("/specs/{spec_id}/set-default", response_model=SpecOut)
def set_default_spec(
    spec_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin)),
) -> SpecOut:
    spec = _get_spec(spec_id, org, db)
    db.query(Specification).filter(Specification.product_id == spec.product_id).update({"is_default": False})
    spec.is_default = True
    db.commit()
    db.refresh(spec)
    return _spec_to_out(spec, db, org.id)


@full_router.post("/specs/{spec_id}/components", response_model=SpecOut, status_code=status.HTTP_201_CREATED)
def add_component(
    spec_id: int,
    payload: SpecComponentCreate,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    user: User        = Depends(require_roles(UserRole.admin)),
) -> SpecOut:
    spec = _get_spec(spec_id, org, db)
    if payload.product_id is not None:
        product = _get_product(payload.product_id, org, db)
    else:
        product = _ensure_component_product(
            db=db,
            org=org,
            user=user,
            name=payload.name,
            sku=None,
            unit=payload.unit,
            unit_price=payload.unit_price,
        )
    data = payload.model_dump()
    data["name"] = data["name"].strip()
    data["product_id"] = product.id
    unit = (data["unit"] or "").strip()
    data["name"] = product.name
    data["unit"] = unit or product.unit
    if data["unit_price"] is None:
        data["unit_price"] = product.cost_price
    comp = SpecComponent(specification_id=spec.id, **data)
    db.add(comp)
    db.commit()
    return _spec_to_out(spec, db, org.id)


@full_router.delete("/specs/{spec_id}/components/{comp_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_component(
    spec_id: int,
    comp_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin)),
) -> None:
    _get_spec(spec_id, org, db)
    comp = db.query(SpecComponent).filter_by(id=comp_id, specification_id=spec_id).first()
    if not comp:
        raise HTTPException(status_code=404, detail="Component not found")
    db.delete(comp)
    db.commit()


@full_router.post("/specs/{spec_id}/operations", response_model=SpecOut, status_code=status.HTTP_201_CREATED)
def add_operation(
    spec_id: int,
    payload: SpecOperationCreate,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin)),
) -> SpecOut:
    spec = _get_spec(spec_id, org, db)
    op = SpecOperation(specification_id=spec.id, **payload.model_dump())
    db.add(op)
    db.commit()
    return _spec_to_out(spec, db, org.id)


@full_router.delete("/specs/{spec_id}/operations/{op_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_operation(
    spec_id: int,
    op_id:   int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin)),
) -> None:
    _get_spec(spec_id, org, db)
    op = db.query(SpecOperation).filter_by(id=op_id, specification_id=spec_id).first()
    if not op:
        raise HTTPException(status_code=404, detail="Operation not found")
    db.delete(op)
    db.commit()


@full_router.get("/products/{product_id}/cost", response_model=CostBreakdown)
def compute_cost(
    product_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> CostBreakdown:
    _get_product(product_id, org, db)
    spec = (
        db.query(Specification)
        .filter(Specification.product_id == product_id, Specification.is_default)
        .first()
    )
    if not spec:
        raise HTTPException(status_code=404, detail="No default specification")
    cost = _calc_cost(spec, db, electricity_rate=org.electricity_rate or _ELECTRICITY_RATE, labor_rate=org.labor_rate or _LABOR_RATE)
    p = db.get(Product, product_id)
    if p:
        p.direct_cost = cost.material_cost + cost.electricity_cost
        p.full_cost   = cost.total
        db.commit()
    return cost
