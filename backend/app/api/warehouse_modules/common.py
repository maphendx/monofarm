"""Shared warehouse invariants, lookups, costing, and response builders."""
from decimal import Decimal

import hashlib
import re
import unicodedata

from fastapi import HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.organization import Organization
from app.models.user import User
from app.models.warehouse import (
    BatchStatus, CellMoveKind, CellMovement, CellStock, Counterparty, MovementType, Order, OrderItem, ProductionBatch, SpecComponent, SpecOperation,
    Specification, StockEntry, Warehouse, WarehouseCell, WarehouseMovement,
    WarehouseZone, Product,
)
from app.schemas.warehouse import (
    CostBreakdown, OrderItemOut, OrderOut, ProductOut, SpecOut,
)


_ELECTRICITY_RATE = Decimal("4.5")  # ₴/кВт·год
_LABOR_RATE = Decimal("150")  # ₴/год
_PRINTER_WATTS = 200  # Вт
_IMAGE_PREFIX = "product-images"

def _image_url(key: str, product_id: int, org_id: int) -> str:
    from app.services import storage as storage_svc
    url = storage_svc.presigned_url(key, org_id, prefix=_IMAGE_PREFIX, expires=86400)
    return url or f"/api/warehouse/products/{product_id}/images/{key}"


def _product_image_url(p: Product, org_id: int) -> str | None:
    if not p.image_key:
        return None
    return _image_url(p.image_key, p.id, org_id)


def _make_product_out(p: Product, org_id: int) -> ProductOut:
    out = ProductOut.model_validate(p)
    out.image_url = _product_image_url(p, org_id)
    return out

# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_product(product_id: int, org: Organization, db: Session) -> Product:
    p = db.query(Product).filter(Product.id == product_id, Product.organization_id == org.id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Product not found")
    return p


def _get_warehouse(wh_id: int, org: Organization, db: Session) -> Warehouse:
    wh = db.query(Warehouse).filter(Warehouse.id == wh_id, Warehouse.organization_id == org.id).first()
    if not wh:
        raise HTTPException(status_code=404, detail="Warehouse not found")
    return wh


def _get_counterparty(cp_id: int, org: Organization, db: Session) -> Counterparty:
    cp = db.query(Counterparty).filter(Counterparty.id == cp_id, Counterparty.organization_id == org.id).first()
    if not cp:
        raise HTTPException(status_code=404, detail="Counterparty not found")
    return cp


def _get_spec(spec_id: int, org: Organization, db: Session) -> Specification:
    spec = (
        db.query(Specification)
        .join(Product, Product.id == Specification.product_id)
        .filter(Specification.id == spec_id, Product.organization_id == org.id)
        .first()
    )
    if not spec:
        raise HTTPException(status_code=404, detail="Specification not found")
    return spec


def _get_spec_for_product(
    spec_id: int | None,
    product_id: int,
    org: Organization,
    db: Session,
) -> Specification | None:
    if spec_id is None:
        return None
    spec = _get_spec(spec_id, org, db)
    if spec.product_id != product_id:
        raise HTTPException(status_code=400, detail="Specification does not belong to product")
    return spec


def _norm_lookup(value: str | None) -> str:
    return " ".join((value or "").casefold().split())


def _component_sku_from_name(name: str) -> str:
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^A-Za-z0-9]+", "-", ascii_name).strip("-").upper()
    if len(slug) < 3:
        slug = "COMP"
    digest = hashlib.sha1(name.casefold().encode("utf-8")).hexdigest()[:8].upper()
    return f"COMP-{slug[:24]}-{digest}"


def _unique_component_sku(
    db: Session,
    org_id: int,
    name: str,
    preferred_sku: str | None = None,
) -> str:
    base = (preferred_sku or "").strip() or _component_sku_from_name(name)
    base = base[:80] or _component_sku_from_name(name)
    candidate = base
    suffix = 2
    while db.query(Product.id).filter(Product.organization_id == org_id, Product.sku == candidate).first():
        tail = f"-{suffix}"
        candidate = f"{base[:80 - len(tail)]}{tail}"
        suffix += 1
    return candidate


def _ensure_component_product(
    *,
    db: Session,
    org: Organization,
    user: User | None,
    name: str,
    sku: str | None,
    unit: str | None,
    unit_price: Decimal | None,
    product_by_sku: dict[str, Product] | None = None,
    product_by_name: dict[str, Product] | None = None,
) -> Product:
    clean_name = name.strip()
    if not clean_name:
        raise HTTPException(status_code=400, detail="Component name is required")

    product = product_by_sku.get(_norm_lookup(sku)) if product_by_sku and sku else None
    if product is None and product_by_name is not None:
        product = product_by_name.get(_norm_lookup(clean_name))
    if product is None and product_by_sku is None and sku:
        product = db.query(Product).filter(Product.organization_id == org.id, Product.sku == sku.strip()).first()
    if product is None and product_by_name is None:
        product = next(
            (
                existing
                for existing in db.query(Product).filter(Product.organization_id == org.id).all()
                if _norm_lookup(existing.name) == _norm_lookup(clean_name)
            ),
            None,
        )
    if product is not None:
        return product

    _check_product_limit(org, db)
    product = Product(
        organization_id=org.id,
        created_by_id=user.id if user else None,
        name=clean_name,
        sku=_unique_component_sku(db, org.id, clean_name, preferred_sku=sku),
        categories=[],
        unit=(unit or "").strip() or "шт",
        cost_price=unit_price,
        is_active=True,
    )
    db.add(product)
    db.flush()
    if product_by_sku is not None:
        product_by_sku[_norm_lookup(product.sku)] = product
    if product_by_name is not None:
        product_by_name[_norm_lookup(product.name)] = product
    return product


def _component_payloads(
    components: list[SpecComponent],
    db: Session,
    org_id: int,
    product_names: dict[int, str] | None = None,
) -> list[dict]:
    if product_names is None:
        product_ids = {c.product_id for c in components if c.product_id is not None}
        product_names = {}
        if product_ids:
            product_names = {
                product_id: name
                for product_id, name in (
                    db.query(Product.id, Product.name)
                    .filter(Product.organization_id == org_id, Product.id.in_(product_ids))
                    .all()
                )
            }
    return [
        {
            "id": c.id,
            "name": c.name,
            "product_id": c.product_id,
            "product_name": product_names.get(c.product_id),
            "material_id": c.material_id,
            "quantity": c.quantity,
            "unit": c.unit,
            "unit_price": c.unit_price,
            "waste_pct": c.waste_pct,
            "sort_order": c.sort_order,
        }
        for c in components
    ]


def _spec_to_out(spec: Specification, db: Session, org_id: int) -> SpecOut:
    components = db.query(SpecComponent).filter(SpecComponent.specification_id == spec.id).order_by(SpecComponent.sort_order).all()
    operations = db.query(SpecOperation).filter(SpecOperation.specification_id == spec.id).order_by(SpecOperation.sort_order).all()
    return SpecOut.model_validate({
        **spec.__dict__,
        "components": _component_payloads(components, db, org_id),
        "operations": operations,
    })


def _specs_to_out(specs: list[Specification], db: Session, org_id: int) -> list[SpecOut]:
    spec_ids = [s.id for s in specs]
    if not spec_ids:
        return []

    components_by_spec: dict[int, list[SpecComponent]] = {sid: [] for sid in spec_ids}
    operations_by_spec: dict[int, list[SpecOperation]] = {sid: [] for sid in spec_ids}

    components = (
        db.query(SpecComponent)
        .filter(SpecComponent.specification_id.in_(spec_ids))
        .order_by(SpecComponent.specification_id, SpecComponent.sort_order)
        .all()
    )
    for component in components:
        components_by_spec.setdefault(component.specification_id, []).append(component)

    component_product_ids = {c.product_id for c in components if c.product_id is not None}
    component_product_names: dict[int, str] = {}
    if component_product_ids:
        component_product_names = {
            product_id: name
            for product_id, name in (
                db.query(Product.id, Product.name)
                .filter(Product.organization_id == org_id, Product.id.in_(component_product_ids))
                .all()
            )
        }

    operations = (
        db.query(SpecOperation)
        .filter(SpecOperation.specification_id.in_(spec_ids))
        .order_by(SpecOperation.specification_id, SpecOperation.sort_order)
        .all()
    )
    for operation in operations:
        operations_by_spec.setdefault(operation.specification_id, []).append(operation)

    return [
        SpecOut.model_validate({
            **spec.__dict__,
            "components": _component_payloads(
                components_by_spec.get(spec.id, []),
                db,
                org_id,
                product_names=component_product_names,
            ),
            "operations": operations_by_spec.get(spec.id, []),
        })
        for spec in specs
    ]


def _calc_cost(
    spec: Specification,
    db: Session,
    electricity_rate: Decimal = _ELECTRICITY_RATE,
    labor_rate: Decimal = _LABOR_RATE,
) -> CostBreakdown:
    components = db.query(SpecComponent).filter(SpecComponent.specification_id == spec.id).all()
    operations = db.query(SpecOperation).filter(SpecOperation.specification_id == spec.id).all()

    material_cost = Decimal("0")
    for c in components:
        if c.unit_price is not None:
            waste = Decimal("1") + (c.waste_pct or Decimal("0")) / 100
            material_cost += c.quantity * c.unit_price * waste

    electricity_cost = Decimal("0")
    labor_cost       = Decimal("0")
    other_cost       = Decimal("0")
    print_time_min   = Decimal("0")

    for op in operations:
        if op.type.value == "print" and op.print_time_min:
            hours = op.print_time_min / 60
            kwh   = Decimal(op.power_watts or _PRINTER_WATTS) * hours / 1000
            electricity_cost += kwh * electricity_rate
            print_time_min   += op.print_time_min
        if op.labor_minutes:
            rate       = op.labor_rate_per_hour or labor_rate
            labor_cost += (op.labor_minutes / 60) * rate
        if op.explicit_cost:
            other_cost += op.explicit_cost

    total = material_cost + electricity_cost + labor_cost + other_cost

    product = db.get(Product, spec.product_id)
    margin = None
    if product and product.sale_price and total > 0:
        margin = ((product.sale_price - total) / product.sale_price * 100).quantize(Decimal("0.01"))

    return CostBreakdown(
        material_cost=material_cost.quantize(Decimal("0.0001")),
        electricity_cost=electricity_cost.quantize(Decimal("0.0001")),
        labor_cost=labor_cost.quantize(Decimal("0.0001")),
        other_cost=other_cost.quantize(Decimal("0.0001")),
        total=total.quantize(Decimal("0.0001")),
        print_time_min=print_time_min,
        margin_pct=margin,
    )


def _next_order_number(org: Organization, db: Session) -> str:
    count = db.query(Order).filter(Order.organization_id == org.id).count()
    return f"#ORD-{count + 1:04d}"


def _update_avco(product_id: int, incoming_qty: Decimal, incoming_cost: Decimal, db: Session) -> None:
    """Recalculate product.cost_price using Average Cost (AVCO) method.

    Must be called BEFORE the new stock is added to StockEntry so that
    current_qty reflects the quantity already on hand.
    """
    product = db.query(Product).with_for_update().filter(Product.id == product_id).first()
    if product is None:
        return

    current_qty = db.query(func.sum(StockEntry.quantity)).filter(
        StockEntry.organization_id == product.organization_id,
        StockEntry.product_id == product_id,
    ).scalar() or Decimal("0")

    current_cost = product.cost_price or Decimal("0")

    if current_qty > 0 and current_cost > 0:
        new_cost = (current_qty * current_cost + incoming_qty * incoming_cost) / (current_qty + incoming_qty)
    else:
        new_cost = incoming_cost

    product.cost_price = new_cost.quantize(Decimal("0.0001"))


# ── Bin (cell) reconciliation ───────────────────────────────────────────────
#
# StockEntry stays the source of truth for totals. Cells are a physical
# allocation underneath it, bounded by the invariant:
#
#     for each (product, warehouse):  sum(CellStock) <= StockEntry.quantity
#
# The difference is "unassigned" (floor) stock. Every stock decrease runs
# through _clamp_cells_to_stock, so cell allocations can never drift above the
# real total — even for callers (orders, batches, auto-replenish) that know
# nothing about cells.

def _get_cell(cell_id: int, org: Organization, db: Session, warehouse_id: int | None = None) -> WarehouseCell:
    cell = (
        db.query(WarehouseCell)
        .join(WarehouseZone, WarehouseZone.id == WarehouseCell.zone_id)
        .filter(WarehouseCell.id == cell_id, WarehouseZone.organization_id == org.id)
        .first()
    )
    if not cell:
        raise HTTPException(status_code=404, detail="Cell not found")
    if warehouse_id is not None:
        zone = db.get(WarehouseZone, cell.zone_id)
        if not zone or zone.warehouse_id != warehouse_id:
            raise HTTPException(status_code=400, detail="Комірка не належить цьому складу")
    return cell


def _cell_warehouse_id(cell: WarehouseCell, db: Session) -> int:
    zone = db.get(WarehouseZone, cell.zone_id)
    return zone.warehouse_id  # type: ignore[union-attr]


def _cells_in_warehouse(product_id: int, warehouse_id: int, db: Session) -> list[CellStock]:
    """CellStock rows for a product in one warehouse, oldest first (FIFO)."""
    return (
        db.query(CellStock)
        .join(WarehouseCell, WarehouseCell.id == CellStock.cell_id)
        .join(WarehouseZone, WarehouseZone.id == WarehouseCell.zone_id)
        .filter(
            WarehouseZone.warehouse_id == warehouse_id,
            CellStock.product_id == product_id,
            CellStock.quantity > 0,
        )
        .order_by(CellStock.updated_at, CellStock.id)
        .all()
    )


def _cell_assigned(product_id: int, warehouse_id: int, db: Session) -> Decimal:
    return sum((cs.quantity for cs in _cells_in_warehouse(product_id, warehouse_id, db)), Decimal("0"))


def _unassigned_qty(product_id: int, warehouse_id: int, org_id: int, db: Session) -> Decimal:
    entry = db.query(StockEntry).filter_by(
        organization_id=org_id,
        product_id=product_id,
        warehouse_id=warehouse_id,
    ).first()
    total = entry.quantity if entry else Decimal("0")
    return max(Decimal("0"), total - _cell_assigned(product_id, warehouse_id, db))


def _lock_stock_row(product_id: int, warehouse_id: int, org_id: int, db: Session) -> None:
    """Row-lock the (product, warehouse) stock entry so concurrent bin edits on
    the same product+warehouse serialize (prevents over-assigning the pool)."""
    db.query(StockEntry).filter_by(
        organization_id=org_id, product_id=product_id, warehouse_id=warehouse_id
    ).with_for_update().first()


def _log_cell_move(
    db: Session, *, org_id: int, product_id: int, quantity: Decimal, kind: CellMoveKind,
    cell_from_id: int | None = None, cell_to_id: int | None = None,
    movement_id: int | None = None, created_by_id: int | None = None,
) -> None:
    if quantity <= 0:
        return
    db.add(CellMovement(
        organization_id=org_id, product_id=product_id, quantity=quantity, kind=kind,
        cell_from_id=cell_from_id, cell_to_id=cell_to_id,
        movement_id=movement_id, created_by_id=created_by_id,
    ))


def _putaway(
    cell: WarehouseCell, product_id: int, qty: Decimal, org_id: int, db: Session,
    *, kind: CellMoveKind = CellMoveKind.putaway, movement_id: int | None = None, created_by_id: int | None = None,
) -> None:
    """Assign qty from the unassigned pool into a cell. Caller must cap qty to availability."""
    if qty <= 0:
        return
    cs = db.query(CellStock).filter_by(cell_id=cell.id, product_id=product_id).first()
    if cs:
        cs.quantity += qty
    else:
        db.add(CellStock(cell_id=cell.id, product_id=product_id, quantity=qty))
    _log_cell_move(db, org_id=org_id, product_id=product_id, quantity=qty, kind=kind,
                   cell_to_id=cell.id, movement_id=movement_id, created_by_id=created_by_id)


def _pick_from_cell(
    cell: WarehouseCell, product_id: int, qty: Decimal, org_id: int, db: Session,
    *, kind: CellMoveKind = CellMoveKind.pick, movement_id: int | None = None,
    created_by_id: int | None = None, keep_row: bool = False,
) -> Decimal:
    """Remove up to qty from a cell. Returns the amount actually removed.

    keep_row=True preserves the CellStock row at 0 (write-off: goods destroyed in place).
    """
    cs = db.query(CellStock).filter_by(cell_id=cell.id, product_id=product_id).first()
    take = min(cs.quantity, qty) if cs else Decimal("0")
    if take > 0:
        cs.quantity -= take
        _log_cell_move(db, org_id=org_id, product_id=product_id, quantity=take, kind=kind,
                       cell_from_id=cell.id, movement_id=movement_id, created_by_id=created_by_id)
        if cs.quantity <= 0 and not keep_row:
            db.delete(cs)
    return take


def _clamp_cells_to_stock(
    product_id: int, warehouse_id: int, org_id: int, db: Session,
    *, movement_id: int | None = None, created_by_id: int | None = None,
    keep_rows: bool = False,
) -> None:
    """Reduce cell allocations FIFO until sum(cells) <= StockEntry.quantity."""
    entry = db.query(StockEntry).filter_by(
        organization_id=org_id,
        product_id=product_id,
        warehouse_id=warehouse_id,
    ).first()
    total = entry.quantity if entry else Decimal("0")
    cells = _cells_in_warehouse(product_id, warehouse_id, db)
    excess = sum((c.quantity for c in cells), Decimal("0")) - total
    if excess <= 0:
        return
    for cs in cells:
        if excess <= 0:
            break
        cell = db.get(WarehouseCell, cs.cell_id)
        take = _pick_from_cell(cell, product_id, min(cs.quantity, excess), org_id, db,
                               movement_id=movement_id, created_by_id=created_by_id,
                               keep_row=keep_rows)
        excess -= take


def _apply_movement(movement: WarehouseMovement, db: Session) -> None:
    """Update StockEntry rows to reflect a committed movement.

    For PURCHASE_IN, updates AVCO on the product BEFORE adding stock so
    the formula uses the quantity currently on hand. After applying, clamps
    cell allocations in any touched warehouse back within the new totals.
    """
    q   = movement.quantity
    mt  = movement.type
    pid = movement.product_id

    def _entry(product_id: int, warehouse_id: int) -> StockEntry:
        from decimal import Decimal
        row = db.query(StockEntry).filter_by(
            organization_id=movement.organization_id,
            product_id=product_id,
            warehouse_id=warehouse_id,
        ).first()
        if not row:
            row = StockEntry(
                organization_id=movement.organization_id,
                product_id=product_id,
                warehouse_id=warehouse_id,
                quantity=Decimal("0"),
                reserved_qty=Decimal("0"),
            )
            db.add(row)
        return row

    def _decrease(product_id: int, warehouse_id: int, amount: Decimal) -> StockEntry:
        row = _entry(product_id, warehouse_id)
        if row.quantity < amount:
            raise HTTPException(status_code=422, detail="Недостатньо товару на складі")
        row.quantity -= amount
        return row

    if mt == MovementType.PURCHASE_IN and movement.warehouse_to_id:
        if movement.unit_cost:
            _update_avco(pid, q, movement.unit_cost, db)
        _entry(pid, movement.warehouse_to_id).quantity += q

    elif mt in (MovementType.PRODUCTION_IN, MovementType.RETURN_IN) and movement.warehouse_to_id:
        if mt == MovementType.PRODUCTION_IN and movement.unit_cost:
            _update_avco(pid, q, movement.unit_cost, db)
        _entry(pid, movement.warehouse_to_id).quantity += q

    elif mt == MovementType.DEFECT:
        if movement.warehouse_from_id:
            _decrease(pid, movement.warehouse_from_id, q)
        if movement.warehouse_to_id:
            _entry(pid, movement.warehouse_to_id).quantity += q

    elif mt in (MovementType.SALE_OUT, MovementType.PRODUCTION_OUT, MovementType.WRITE_OFF) and movement.warehouse_from_id:
        row = _decrease(pid, movement.warehouse_from_id, q)
        if mt == MovementType.SALE_OUT and movement.order_id:
            row.reserved_qty -= min(row.reserved_qty, q)

    elif mt == MovementType.ADJUSTMENT:
        if movement.warehouse_to_id:
            _entry(pid, movement.warehouse_to_id).quantity += q
        elif movement.warehouse_from_id:
            _decrease(pid, movement.warehouse_from_id, q)

    elif mt == MovementType.TRANSFER and movement.warehouse_from_id and movement.warehouse_to_id:
        _decrease(pid, movement.warehouse_from_id, q)
        _entry(pid, movement.warehouse_to_id).quantity   += q

    # Keep cell allocations within the new totals for every touched warehouse.
    # Clamping a warehouse whose stock only increased is a harmless no-op.
    # For WRITE_OFF, goods are destroyed in place — preserve CellStock rows at 0
    # so the cell assignment remains visible (keep_rows=True skips db.delete).
    db.flush()
    keep = mt == MovementType.WRITE_OFF
    for wh_id in {movement.warehouse_from_id, movement.warehouse_to_id}:
        if wh_id:
            _clamp_cells_to_stock(pid, wh_id, movement.organization_id, db,
                                  movement_id=movement.id, created_by_id=movement.created_by_id,
                                  keep_rows=keep)


def _check_and_auto_replenish(pid: int, org_id: int, db: Session) -> None:
    from sqlalchemy import func
    from app.models.warehouse import Product, StockEntry, Specification

    p = db.query(Product).filter(Product.id == pid, Product.organization_id == org_id).first()
    if not p or p.min_stock is None:
        return

    total_qty = db.query(func.sum(StockEntry.quantity)).filter_by(organization_id=org_id, product_id=pid).scalar() or 0
    total_res = db.query(func.sum(StockEntry.reserved_qty)).filter_by(organization_id=org_id, product_id=pid).scalar() or 0
    available = float(total_qty - total_res)

    if available >= p.min_stock:
        return

    active_batch = db.query(ProductionBatch).filter(
        ProductionBatch.organization_id == org_id,
        ProductionBatch.product_id == pid,
        ProductionBatch.status.in_([BatchStatus.draft, BatchStatus.active])
    ).first()

    if active_batch:
        return

    target_qty = (p.desired_stock - available) if p.desired_stock is not None else (p.min_stock - available)
    if target_qty <= 0:
        target_qty = 10

    target_qty = int(target_qty)

    spec = (
        db.query(Specification)
        .join(Product, Product.id == Specification.product_id)
        .filter(
            Product.organization_id == org_id,
            Specification.product_id == pid,
            Specification.is_default.is_(True),
        )
        .first()
    )

    batch = ProductionBatch(
        organization_id=org_id,
        product_id=pid,
        specification_id=spec.id if spec else None,
        target_qty=target_qty,
        status=BatchStatus.draft,
        notes="Автоматичне поповнення запасів"
    )
    db.add(batch)


def _order_to_out(
    o: Order,
    db: Session,
    *,
    items: list[OrderItem] | None = None,
    product_map: dict[int, Product] | None = None,
    cp_map: dict[int, Counterparty] | None = None,
) -> OrderOut:
    if items is None:
        items = db.query(OrderItem).filter_by(order_id=o.id).all()
    item_outs = []
    for it in items:
        p = product_map.get(it.product_id) if product_map is not None else db.get(Product, it.product_id)
        item_outs.append(OrderItemOut(
            id=it.id,
            product_id=it.product_id,
            product_name=p.name if p else "",  # type: ignore[union-attr]
            product_sku=p.sku if p else None,
            image_url=_product_image_url(p, o.organization_id) if p else None,
            warehouse_id=it.warehouse_id,
            quantity=it.quantity,
            unit_price=it.unit_price,
            total_price=it.total_price,
        ))

    counterparty_name: str | None = None
    customer_phone: str | None = None
    customer_email: str | None = None
    delivery_address: str | None = None
    if o.counterparty_id:
        cp = cp_map.get(o.counterparty_id) if cp_map is not None else db.get(Counterparty, o.counterparty_id)
        if cp:
            counterparty_name = cp.name
            customer_phone = cp.phone
            customer_email = cp.email
            delivery_address = cp.address

    payload = o.external_payload or {}
    delivery_type = payload.get("delivery_type") if isinstance(payload, dict) else None
    payment_type = payload.get("payment_type") if isinstance(payload, dict) else None
    delivery_service = delivery_type.get("title") if isinstance(delivery_type, dict) else None
    payment_method = payment_type.get("title") if isinstance(payment_type, dict) else None
    delivery_city = None
    if isinstance(payload, dict):
        customer_phone = payload.get("delivery_phone") or customer_phone
        customer_email = payload.get("delivery_email") or customer_email
        delivery_city = payload.get("delivery_city_stable") or payload.get("delivery_city")
        delivery_address = payload.get("delivery_address") or delivery_address

    total       = o.total_amount or Decimal("0")
    paid        = o.paid_amount  or Decimal("0")
    outstanding = max(total - paid, Decimal("0"))

    if paid <= 0:
        payment_status = "unpaid"
    elif total > 0 and paid >= total:
        payment_status = "paid"
    else:
        payment_status = "partial"

    return OrderOut(
        id=o.id,
        order_number=o.order_number,
        counterparty_id=o.counterparty_id,
        counterparty_name=counterparty_name,
        customer_name=o.customer_name,
        customer_phone=customer_phone,
        customer_email=customer_email,
        delivery_city=delivery_city,
        delivery_service=delivery_service,
        delivery_address=delivery_address,
        payment_method=payment_method,
        source=o.source,
        status=o.status,
        total_amount=o.total_amount,
        paid_amount=paid,
        outstanding=outstanding,
        payment_status=payment_status,
        currency=o.currency,
        due_date=o.due_date,
        notes=o.notes,
        items=item_outs,
        created_at=o.created_at,
    )
def _check_product_limit(org: Organization, db: Session) -> None:
    from app.models.organization import WAREHOUSE_PRODUCT_LIMIT
    limit = WAREHOUSE_PRODUCT_LIMIT[org.plan]
    if limit is None:
        return
    count = db.query(func.count(Product.id)).filter(Product.organization_id == org.id).scalar() or 0
    if count >= limit:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Досягнуто ліміт {limit} номенклатур для тарифу {org.plan.value}",
        )
