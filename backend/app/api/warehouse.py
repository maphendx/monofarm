"""Warehouse module — counterparties, products, specifications, stock, movements, batches, orders."""
import base64
from datetime import date, datetime, timedelta
from decimal import Decimal

import csv
import io
import uuid

import openpyxl
from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles
from app.core.db import get_db
from app.models.organization import Organization
from app.models.user import User, UserRole
from app.models.warehouse import (
    BatchStatus, CashTransaction, CashTxType, CashTxCategory,
    CellStock, Counterparty, MovementType, Order, OrderItem, OrderPayment,
    OrderStatus, ProductCategory, ProductImage, ProductionBatch, SpecComponent, SpecOperation,
    SpecOpType, Specification, StockEntry, Warehouse, WarehouseCell, WarehouseMovement,
    WarehouseZone, Product,
)
from app.schemas.warehouse import (
    BatchClose, BatchComponentOut, BatchCreate, BatchOut, BatchUpdate,
    CashFlowSummary, CashTxCreate, CashTxOut,
    CellOut, CellStockOut, CellStockSet,
    CostBreakdown, CounterpartyBalanceAdjust, CounterpartyCreate,
    CounterpartyOut, CounterpartyUpdate,
    MovementCreate, MovementListOut, MovementOut,
    OrderCreate, OrderItemOut, OrderOut, OrderPaymentCreate, OrderPaymentOut, OrderUpdate,
    ProductCategoryCreate, ProductCategoryOut, ProductCategoryUpdate,
    ProductCreate, ProductImageOut, ProductOut, ProductUpdate, ReserveRequest,
    SpecComponentCreate, SpecCreate, SpecOperationCreate, SpecOut,
    StockEntryOut, WarehouseCreate, WarehouseOut, WarehouseUpdate,
    ZoneCreate, ZoneOut, ZoneUpdate, ZoneWithCellsOut,
)

router = APIRouter(prefix="/warehouse", tags=["warehouse"])

_ELECTRICITY_RATE  = Decimal("4.5")   # ₴/кВт·год
_LABOR_RATE        = Decimal("150")   # ₴/год
_PRINTER_WATTS     = 200              # Вт
_IMAGE_PREFIX      = "product-images"
_IMAGE_MIME_EXT    = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}
_IMAGE_MAX_BYTES   = 8 * 1024 * 1024  # 8 MB


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


# ── Product categories ────────────────────────────────────────────────────────

@router.get("/categories", response_model=list[ProductCategoryOut])
def list_categories(
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[ProductCategoryOut]:
    rows = (
        db.query(ProductCategory)
        .filter(ProductCategory.organization_id == org.id)
        .order_by(ProductCategory.sort_order, ProductCategory.name)
        .all()
    )
    return [ProductCategoryOut.model_validate(r) for r in rows]


@router.post("/categories", response_model=ProductCategoryOut, status_code=status.HTTP_201_CREATED)
def create_category(
    payload: ProductCategoryCreate,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    _:    User         = Depends(require_roles(UserRole.admin)),
) -> ProductCategoryOut:
    cat = ProductCategory(**payload.model_dump(), organization_id=org.id)
    db.add(cat)
    db.commit()
    db.refresh(cat)
    return ProductCategoryOut.model_validate(cat)


@router.patch("/categories/{cat_id}", response_model=ProductCategoryOut)
def update_category(
    cat_id:  int,
    payload: ProductCategoryUpdate,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    _:    User         = Depends(require_roles(UserRole.admin)),
) -> ProductCategoryOut:
    cat = db.query(ProductCategory).filter_by(id=cat_id, organization_id=org.id).first()
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(cat, k, v)
    db.commit()
    db.refresh(cat)
    return ProductCategoryOut.model_validate(cat)


@router.delete("/categories/{cat_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_category(
    cat_id: int,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    _:    User         = Depends(require_roles(UserRole.admin)),
) -> None:
    cat = db.query(ProductCategory).filter_by(id=cat_id, organization_id=org.id).first()
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")
    db.delete(cat)
    db.commit()


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


def _spec_to_out(spec: Specification, db: Session) -> SpecOut:
    components = db.query(SpecComponent).filter(SpecComponent.specification_id == spec.id).order_by(SpecComponent.sort_order).all()
    operations = db.query(SpecOperation).filter(SpecOperation.specification_id == spec.id).order_by(SpecOperation.sort_order).all()
    return SpecOut.model_validate({**spec.__dict__, "components": components, "operations": operations})


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
        StockEntry.product_id == product_id
    ).scalar() or Decimal("0")

    current_cost = product.cost_price or Decimal("0")

    if current_qty > 0 and current_cost > 0:
        new_cost = (current_qty * current_cost + incoming_qty * incoming_cost) / (current_qty + incoming_qty)
    else:
        new_cost = incoming_cost

    product.cost_price = new_cost.quantize(Decimal("0.0001"))


def _apply_movement(movement: WarehouseMovement, db: Session) -> None:
    """Update StockEntry rows to reflect a committed movement.

    For PURCHASE_IN, updates AVCO on the product BEFORE adding stock so
    the formula uses the quantity currently on hand.
    """
    q   = movement.quantity
    mt  = movement.type
    pid = movement.product_id

    def _entry(product_id: int, warehouse_id: int) -> StockEntry:
        from decimal import Decimal
        row = db.query(StockEntry).filter_by(product_id=product_id, warehouse_id=warehouse_id).first()
        if not row:
            product = db.get(Product, product_id)
            row = StockEntry(
                organization_id=product.organization_id,  # type: ignore[union-attr]
                product_id=product_id,
                warehouse_id=warehouse_id,
                quantity=Decimal("0"),
                reserved_qty=Decimal("0"),
            )
            db.add(row)
        return row

    if mt == MovementType.PURCHASE_IN and movement.warehouse_to_id:
        if movement.unit_cost:
            _update_avco(pid, q, movement.unit_cost, db)
        _entry(pid, movement.warehouse_to_id).quantity += q

    elif mt == MovementType.PRODUCTION_IN and movement.warehouse_to_id:
        _entry(pid, movement.warehouse_to_id).quantity += q

    elif mt in (MovementType.SALE_OUT, MovementType.PRODUCTION_OUT, MovementType.DEFECT) and movement.warehouse_from_id:
        _entry(pid, movement.warehouse_from_id).quantity -= q

    elif mt == MovementType.ADJUSTMENT:
        wh_id = movement.warehouse_to_id or movement.warehouse_from_id
        if wh_id:
            _entry(pid, wh_id).quantity += q

    elif mt == MovementType.TRANSFER and movement.warehouse_from_id and movement.warehouse_to_id:
        _entry(pid, movement.warehouse_from_id).quantity -= q
        _entry(pid, movement.warehouse_to_id).quantity   += q


def _check_and_auto_replenish(pid: int, org_id: int, db: Session) -> None:
    from sqlalchemy import func
    from app.models.warehouse import Product, StockEntry, ProductionBatch, Specification, BatchStatus
    import math

    p = db.get(Product, pid)
    if not p or p.min_stock is None:
        return

    total_qty = db.query(func.sum(StockEntry.quantity)).filter_by(product_id=pid).scalar() or 0
    total_res = db.query(func.sum(StockEntry.reserved_qty)).filter_by(product_id=pid).scalar() or 0
    available = float(total_qty - total_res)

    if available >= p.min_stock:
        return

    active_batch = db.query(ProductionBatch).filter(
        ProductionBatch.product_id == pid,
        ProductionBatch.status.in_([BatchStatus.draft, BatchStatus.active])
    ).first()

    if active_batch:
        return

    target_qty = (p.desired_stock - available) if p.desired_stock is not None else (p.min_stock - available)
    if target_qty <= 0:
        target_qty = 10

    if p.box_limit and p.box_limit > 0:
        boxes = math.ceil(target_qty / p.box_limit)
        target_qty = boxes * p.box_limit

    target_qty = int(target_qty)

    spec = db.query(Specification).filter_by(product_id=pid, is_default=True).first()

    batch = ProductionBatch(
        organization_id=org_id,
        product_id=pid,
        specification_id=spec.id if spec else None,
        target_qty=target_qty,
        status=BatchStatus.draft,
        notes="Автоматичне поповнення запасів"
    )
    db.add(batch)


def _order_to_out(o: Order, db: Session) -> OrderOut:
    items = db.query(OrderItem).filter_by(order_id=o.id).all()
    item_outs = []
    for it in items:
        p = db.get(Product, it.product_id)
        item_outs.append(OrderItemOut(
            id=it.id,
            product_id=it.product_id,
            product_name=p.name if p else "",  # type: ignore[union-attr]
            warehouse_id=it.warehouse_id,
            quantity=it.quantity,
            unit_price=it.unit_price,
            total_price=it.total_price,
        ))

    counterparty_name: str | None = None
    if o.counterparty_id:
        cp = db.get(Counterparty, o.counterparty_id)
        if cp:
            counterparty_name = cp.name

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


# ── Warehouses ────────────────────────────────────────────────────────────────

@router.get("/warehouses", response_model=list[WarehouseOut])
def list_warehouses(db: Session = Depends(get_db), org: Organization = Depends(get_current_org)) -> list[WarehouseOut]:
    rows = db.query(Warehouse).filter(Warehouse.organization_id == org.id).order_by(Warehouse.name).all()
    return [WarehouseOut.model_validate(r) for r in rows]


@router.post("/warehouses", response_model=WarehouseOut, status_code=status.HTTP_201_CREATED)
def create_warehouse(
    payload: WarehouseCreate,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> WarehouseOut:
    wh = Warehouse(**payload.model_dump(), organization_id=org.id)
    db.add(wh)
    db.commit()
    db.refresh(wh)
    return WarehouseOut.model_validate(wh)


@router.patch("/warehouses/{wh_id}", response_model=WarehouseOut)
def update_warehouse(
    wh_id:   int,
    payload: WarehouseUpdate,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> WarehouseOut:
    wh = _get_warehouse(wh_id, org, db)
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(wh, k, v)
    db.commit()
    db.refresh(wh)
    return WarehouseOut.model_validate(wh)


@router.delete("/warehouses/{wh_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_warehouse(
    wh_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin)),
) -> None:
    wh = _get_warehouse(wh_id, org, db)
    db.delete(wh)
    db.commit()


# ── Zones ─────────────────────────────────────────────────────────────────────

def _col_letter(n: int) -> str:
    """0-based column index → Excel-style letter(s): 0→A, 25→Z, 26→AA …"""
    result = ""
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        result = chr(65 + r) + result
    return result


def _generate_cells(zone: WarehouseZone) -> list[WarehouseCell]:
    cells = []
    for r in range(zone.rows):
        for c in range(zone.cols):
            code = f"{_col_letter(c)}{r + 1}"
            cells.append(WarehouseCell(zone_id=zone.id, code=code))
    return cells


def _zone_out(zone: WarehouseZone, db: Session) -> ZoneOut:
    count = db.query(WarehouseCell).filter(WarehouseCell.zone_id == zone.id).count()
    return ZoneOut(
        id=zone.id, name=zone.name, rows=zone.rows, cols=zone.cols,
        sort_order=zone.sort_order, cell_count=count, created_at=zone.created_at,
    )


@router.get("/warehouses/{wh_id}/zones", response_model=list[ZoneOut])
def list_zones(
    wh_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[ZoneOut]:
    _get_warehouse(wh_id, org, db)
    zones = (db.query(WarehouseZone)
               .filter(WarehouseZone.warehouse_id == wh_id, WarehouseZone.organization_id == org.id)
               .order_by(WarehouseZone.sort_order, WarehouseZone.id)
               .all())
    return [_zone_out(z, db) for z in zones]


@router.post("/warehouses/{wh_id}/zones", response_model=ZoneOut, status_code=status.HTTP_201_CREATED)
def create_zone(
    wh_id:   int,
    payload: ZoneCreate,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> ZoneOut:
    _get_warehouse(wh_id, org, db)
    zone = WarehouseZone(**payload.model_dump(), warehouse_id=wh_id, organization_id=org.id)
    db.add(zone)
    db.flush()
    for cell in _generate_cells(zone):
        db.add(cell)
    db.commit()
    db.refresh(zone)
    return _zone_out(zone, db)


@router.patch("/warehouses/{wh_id}/zones/{zone_id}", response_model=ZoneOut)
def update_zone(
    wh_id:   int,
    zone_id: int,
    payload: ZoneUpdate,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> ZoneOut:
    _get_warehouse(wh_id, org, db)
    zone = db.query(WarehouseZone).filter(
        WarehouseZone.id == zone_id, WarehouseZone.warehouse_id == wh_id,
        WarehouseZone.organization_id == org.id,
    ).first()
    if not zone:
        raise HTTPException(status_code=404, detail="Zone not found")
    data = payload.model_dump(exclude_unset=True)
    resize = "rows" in data or "cols" in data
    for k, v in data.items():
        setattr(zone, k, v)
    if resize:
        db.query(WarehouseCell).filter(WarehouseCell.zone_id == zone.id).delete()
        for cell in _generate_cells(zone):
            db.add(cell)
    db.commit()
    db.refresh(zone)
    return _zone_out(zone, db)


@router.delete("/warehouses/{wh_id}/zones/{zone_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_zone(
    wh_id:   int,
    zone_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> None:
    _get_warehouse(wh_id, org, db)
    zone = db.query(WarehouseZone).filter(
        WarehouseZone.id == zone_id, WarehouseZone.warehouse_id == wh_id,
        WarehouseZone.organization_id == org.id,
    ).first()
    if not zone:
        raise HTTPException(status_code=404, detail="Zone not found")
    db.delete(zone)
    db.commit()


# ── Cells ─────────────────────────────────────────────────────────────────────

def _cell_stock_out(cs: CellStock) -> CellStockOut:
    return CellStockOut(
        product_id=cs.product_id,
        product_name=cs.product.name,
        product_sku=cs.product.sku,
        quantity=cs.quantity,
    )


@router.get("/zones/{zone_id}/cells", response_model=ZoneWithCellsOut)
def get_zone_cells(
    zone_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> ZoneWithCellsOut:
    zone = db.query(WarehouseZone).filter(
        WarehouseZone.id == zone_id, WarehouseZone.organization_id == org.id,
    ).first()
    if not zone:
        raise HTTPException(status_code=404, detail="Zone not found")
    cells = (db.query(WarehouseCell)
               .filter(WarehouseCell.zone_id == zone_id)
               .order_by(WarehouseCell.code)
               .all())
    cells_out = []
    for cell in cells:
        stock_rows = db.query(CellStock).filter(CellStock.cell_id == cell.id).all()
        cells_out.append(CellOut(
            id=cell.id, code=cell.code, notes=cell.notes,
            stock=[_cell_stock_out(cs) for cs in stock_rows],
        ))
    count = len(cells)
    return ZoneWithCellsOut(
        id=zone.id, name=zone.name, rows=zone.rows, cols=zone.cols,
        sort_order=zone.sort_order, cell_count=count, created_at=zone.created_at,
        cells=cells_out,
    )


@router.put("/cells/{cell_id}/stock", response_model=CellStockOut)
def set_cell_stock(
    cell_id: int,
    payload: CellStockSet,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> CellStockOut:
    cell = db.query(WarehouseCell).join(WarehouseZone).filter(
        WarehouseCell.id == cell_id, WarehouseZone.organization_id == org.id,
    ).first()
    if not cell:
        raise HTTPException(status_code=404, detail="Cell not found")
    product = db.query(Product).filter(
        Product.id == payload.product_id, Product.organization_id == org.id,
    ).first()
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    cs = db.query(CellStock).filter(
        CellStock.cell_id == cell_id, CellStock.product_id == payload.product_id,
    ).first()
    if cs:
        cs.quantity = payload.quantity
    else:
        cs = CellStock(cell_id=cell_id, product_id=payload.product_id, quantity=payload.quantity)
        db.add(cs)
    db.commit()
    db.refresh(cs)
    cs.product = product
    return _cell_stock_out(cs)


@router.delete("/cells/{cell_id}/stock/{product_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_cell_stock(
    cell_id:    int,
    product_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> None:
    cell = db.query(WarehouseCell).join(WarehouseZone).filter(
        WarehouseCell.id == cell_id, WarehouseZone.organization_id == org.id,
    ).first()
    if not cell:
        raise HTTPException(status_code=404, detail="Cell not found")
    db.query(CellStock).filter(
        CellStock.cell_id == cell_id, CellStock.product_id == product_id,
    ).delete()
    db.commit()


# ── Counterparties ────────────────────────────────────────────────────────────

@router.get("/counterparties", response_model=list[CounterpartyOut])
def list_counterparties(
    cp_type: str | None = Query(None, alias="type"),
    search:  str | None = Query(None),
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[CounterpartyOut]:
    q = db.query(Counterparty).filter(Counterparty.organization_id == org.id)
    if cp_type:
        q = q.filter(Counterparty.type == cp_type)
    if search:
        q = q.filter(Counterparty.name.ilike(f"%{search}%") | Counterparty.email.ilike(f"%{search}%"))
    rows = q.order_by(Counterparty.name).all()
    return [CounterpartyOut.model_validate(r) for r in rows]


@router.post("/counterparties", response_model=CounterpartyOut, status_code=status.HTTP_201_CREATED)
def create_counterparty(
    payload: CounterpartyCreate,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    _:    User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> CounterpartyOut:
    cp = Counterparty(**payload.model_dump(), organization_id=org.id)
    db.add(cp)
    db.commit()
    db.refresh(cp)
    return CounterpartyOut.model_validate(cp)


@router.get("/counterparties/{cp_id}", response_model=CounterpartyOut)
def get_counterparty(
    cp_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> CounterpartyOut:
    return CounterpartyOut.model_validate(_get_counterparty(cp_id, org, db))


@router.patch("/counterparties/{cp_id}", response_model=CounterpartyOut)
def update_counterparty(
    cp_id:   int,
    payload: CounterpartyUpdate,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> CounterpartyOut:
    cp = _get_counterparty(cp_id, org, db)
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(cp, k, v)
    db.commit()
    db.refresh(cp)
    return CounterpartyOut.model_validate(cp)


@router.delete("/counterparties/{cp_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_counterparty(
    cp_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin)),
) -> None:
    cp = _get_counterparty(cp_id, org, db)
    # Nullify references before deletion so existing orders are not orphaned
    db.query(Order).filter_by(counterparty_id=cp.id).update({"counterparty_id": None})
    db.delete(cp)
    db.commit()


@router.post("/counterparties/{cp_id}/adjust-balance", response_model=CounterpartyOut)
def adjust_balance(
    cp_id:   int,
    payload: CounterpartyBalanceAdjust,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> CounterpartyOut:
    """Manually adjust counterparty balance (record a payment)."""
    cp = _get_counterparty(cp_id, org, db)
    cp.balance -= payload.delta   # delta positive = they paid us → reduces their balance
    db.commit()
    db.refresh(cp)
    return CounterpartyOut.model_validate(cp)


# ── Products ──────────────────────────────────────────────────────────────────

@router.get("/products", response_model=list[ProductOut])
def list_products(
    search:   str | None = Query(None),
    category: str | None = Query(None),
    archived: bool = Query(False),
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[ProductOut]:
    q = db.query(Product).filter(
        Product.organization_id == org.id,
        Product.is_active.is_(not archived),
    )
    if search:
        q = q.filter(Product.name.ilike(f"%{search}%") | Product.sku.ilike(f"%{search}%"))
    if category:
        q = q.filter(Product.categories.contains([category]))
    rows = q.order_by(Product.name).all()
    return [_make_product_out(r, org.id) for r in rows]


@router.post("/products", response_model=ProductOut, status_code=status.HTTP_201_CREATED)
def create_product(
    payload: ProductCreate,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin)),
) -> ProductOut:
    p = Product(**payload.model_dump(), organization_id=org.id, created_by_id=user.id)
    db.add(p)
    db.commit()
    db.refresh(p)
    return ProductOut.model_validate(p)


_IMPORT_COL_MAP = {
    "Назва виробу":         "name",
    "Категорії":            "categories",
    "SKU":                  "sku",
    "Штрих-код":            "barcode",
    "Одиниця виміру":       "unit",
    "Середньозважена ціна": "cost_price",
    "Роздрібна ціна":       "sale_price",
    # "Собівартість виробу" intentionally excluded — Monofarm computes this from specs
    "Опис":                 "description",
}

_EXPORT_HEADERS = [
    "Назва виробу", "Категорії", "SKU", "Штрих-код", "Одиниця виміру",
    "Середньозважена ціна", "Роздрібна ціна", "Опис",
]


def _rows_from_upload(file: UploadFile) -> list[dict]:
    raw = file.file.read()
    fname = (file.filename or "").lower()
    if fname.endswith(".xlsx") or fname.endswith(".xls"):
        wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
        ws = wb.active
        rows_iter = ws.iter_rows(values_only=True)
        headers = [str(c).strip() if c is not None else "" for c in next(rows_iter, [])]
        return [dict(zip(headers, (str(c).strip() if c is not None else "" for c in row))) for row in rows_iter]
    text = raw.decode("utf-8-sig")
    delimiter = "\t" if "\t" in text[:1024] else ","
    return list(csv.DictReader(io.StringIO(text), delimiter=delimiter))


def _sync_categories(names: list[str], org_id: int, db: Session) -> int:
    """Create any ProductCategory rows that don't yet exist for this org. Returns count created."""
    if not names:
        return 0
    existing = {
        r.name for r in db.query(ProductCategory.name).filter(
            ProductCategory.organization_id == org_id,
            ProductCategory.name.in_(names),
        ).all()
    }
    created = 0
    for name in dict.fromkeys(names):  # preserve order, deduplicate
        if name and name not in existing:
            db.add(ProductCategory(organization_id=org_id, name=name))
            created += 1
    return created


def _parse_product_fields(row: dict) -> dict:
    fields: dict = {}
    for col, field in _IMPORT_COL_MAP.items():
        val = (row.get(col) or "").strip()
        if not val:
            continue
        if field == "categories":
            fields[field] = [c.strip() for c in val.split(",") if c.strip()]
        elif field in ("cost_price", "sale_price", "direct_cost"):
            try:
                fields[field] = Decimal(val.replace(",", ".").replace(" ", ""))
            except Exception:
                pass
        else:
            fields[field] = val
    return fields


_COMPARABLE_FIELDS = ["name", "barcode", "unit", "sale_price", "cost_price", "description", "categories"]


@router.post("/products/import/preview")
def preview_import(
    file: UploadFile = File(...),
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    _:    User         = Depends(require_roles(UserRole.admin)),
) -> dict:
    try:
        rows = _rows_from_upload(file)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Не вдалося прочитати файл: {exc}") from exc

    db_products = {
        p.sku: p
        for p in db.query(Product).filter(Product.organization_id == org.id, Product.is_active).all()
    }
    file_skus: set[str] = set()
    new_items: list[dict] = []
    existing_items: list[dict] = []

    for row in rows:
        fields = _parse_product_fields(row)
        sku = fields.get("sku", "").strip()
        name = fields.get("name", "").strip()
        if not sku and not name:
            continue
        if sku:
            file_skus.add(sku)

        if sku and sku in db_products:
            p = db_products[sku]
            changes: dict = {}
            for field in _COMPARABLE_FIELDS:
                new_val = fields.get(field)
                if new_val is None:
                    continue
                old_val = getattr(p, field, None)
                if field in ("cost_price", "sale_price", "direct_cost"):
                    try:
                        new_dec = Decimal(str(new_val)).normalize()
                        old_dec = Decimal(str(old_val)).normalize() if old_val is not None else None
                        if new_dec == old_dec:
                            continue
                        new_str = str(new_dec)
                        old_str = str(old_dec) if old_dec is not None else ""
                    except Exception:
                        new_str, old_str = str(new_val), str(old_val) if old_val is not None else ""
                elif isinstance(new_val, list):
                    new_str = ", ".join(new_val)
                    old_str = ", ".join(old_val or [])
                else:
                    new_str = str(new_val).strip()
                    old_str = str(old_val).strip() if old_val is not None else ""
                if new_str != old_str:
                    changes[field] = {"from": old_str, "to": new_str}
            existing_items.append({"id": p.id, "name": p.name, "sku": p.sku, "changes": changes})
        else:
            if not name:
                continue
            item: dict = {"name": name, "sku": sku}
            for f in ("unit", "sale_price", "cost_price"):
                if f in fields:
                    item[f] = str(fields[f])
            new_items.append(item)

    missing_items = [
        {"id": p.id, "name": p.name, "sku": p.sku}
        for sku, p in db_products.items()
        if sku not in file_skus
    ]

    headers = list(rows[0].keys()) if rows else []
    raw_rows = [[str(row.get(h) or "") for h in headers] for row in rows]
    mapping = {str(i): _IMPORT_COL_MAP.get(h) for i, h in enumerate(headers)}

    return {
        "headers": headers,
        "rows": raw_rows,
        "mapping": mapping,
        "summary": {
            "new": len(new_items),
            "existing": len(existing_items),
            "missing": len(missing_items),
        },
        "new": new_items,
        "existing": existing_items,
        "missing": missing_items,
    }


@router.post("/products/import")
def import_products(
    file:            UploadFile = File(...),
    action_new:      str = Query("import",  pattern="^(import|skip)$"),
    action_existing: str = Query("update",  pattern="^(update|skip)$"),
    action_missing:  str = Query("nothing", pattern="^(nothing|hide)$"),
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin)),
) -> dict:
    try:
        rows = _rows_from_upload(file)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Не вдалося прочитати файл: {exc}") from exc

    db_products = {
        p.sku: p
        for p in db.query(Product).filter(Product.organization_id == org.id, Product.is_active).all()
    }
    file_skus: set[str] = set()
    all_cats: list[str] = []
    created = updated = skipped = hidden = 0

    for row in rows:
        fields = _parse_product_fields(row)
        sku = fields.get("sku", "").strip()
        name = fields.get("name", "").strip()
        if not sku and not name:
            skipped += 1
            continue
        if sku:
            file_skus.add(sku)
        all_cats.extend(fields.get("categories") or [])

        if sku and sku in db_products:
            if action_existing == "update":
                p = db_products[sku]
                for k, v in fields.items():
                    if k != "sku":
                        setattr(p, k, v)
                p.is_active = True
                updated += 1
            else:
                skipped += 1
        else:
            if action_new == "import":
                if not name:
                    skipped += 1
                    continue
                db.add(Product(organization_id=org.id, created_by_id=user.id, **fields))
                created += 1
            else:
                skipped += 1

    if action_missing == "hide":
        for sku, p in db_products.items():
            if sku not in file_skus:
                p.is_active = False
                hidden += 1

    new_cats = _sync_categories(all_cats, org.id, db)

    db.commit()
    return {"created": created, "updated": updated, "skipped": skipped, "hidden": hidden, "new_categories": new_cats}


@router.get("/products/export")
def export_products(
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> Response:
    rows = (
        db.query(Product)
        .filter(Product.organization_id == org.id, Product.is_active)
        .order_by(Product.name)
        .all()
    )
    buf = io.StringIO()
    buf.write("﻿")  # UTF-8 BOM for Excel compatibility
    writer = csv.writer(buf, delimiter="\t", lineterminator="\r\n")
    writer.writerow(_EXPORT_HEADERS)
    for p in rows:
        writer.writerow([
            p.name or "",
            ", ".join(p.categories or []),
            p.sku or "",
            p.barcode or "",
            p.unit or "",
            str(p.cost_price) if p.cost_price is not None else "",
            str(p.sale_price) if p.sale_price is not None else "",
            p.description or "",
        ])
    return Response(
        content=buf.getvalue().encode("utf-8"),
        media_type="text/tab-separated-values; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=products.tsv"},
    )


@router.get("/products/{product_id}", response_model=ProductOut)
def get_product(
    product_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> ProductOut:
    return _make_product_out(_get_product(product_id, org, db), org.id)


@router.patch("/products/{product_id}", response_model=ProductOut)
def update_product(
    product_id: int,
    payload:    ProductUpdate,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin)),
) -> ProductOut:
    p = _get_product(product_id, org, db)
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(p, k, v)
    db.commit()
    db.refresh(p)
    return _make_product_out(p, org.id)


@router.post("/products/{product_id}/archive", response_model=ProductOut)
def archive_product(
    product_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin)),
) -> ProductOut:
    p = _get_product(product_id, org, db)
    p.is_active = False
    db.commit()
    db.refresh(p)
    return ProductOut.model_validate(p)


@router.post("/products/{product_id}/restore", response_model=ProductOut)
def restore_product(
    product_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin)),
) -> ProductOut:
    p = _get_product(product_id, org, db)
    p.is_active = True
    db.commit()
    db.refresh(p)
    return _make_product_out(p, org.id)


@router.post("/products/{product_id}/copy", response_model=ProductOut, status_code=201)
def copy_product(
    product_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> ProductOut:
    p = _get_product(product_id, org, db)
    # Find a unique SKU: base-copy, base-copy-2, base-copy-3 …
    base = p.sku + "-copy"
    taken = {
        row.sku for row in
        db.query(Product.sku).filter(Product.organization_id == org.id, Product.sku.like(base + "%")).all()
    }
    new_sku = base
    n = 2
    while new_sku in taken:
        new_sku = f"{base}-{n}"
        n += 1
    copy = Product(
        organization_id=org.id,
        name=p.name + " (копія)",
        sku=new_sku,
        barcode=None,
        categories=list(p.categories),
        unit=p.unit,
        description=p.description,
        is_active=True,
        sale_price=p.sale_price,
        min_stock=p.min_stock,
        desired_stock=p.desired_stock,
        box_limit=p.box_limit,
    )
    db.add(copy)
    db.commit()
    db.refresh(copy)
    return _make_product_out(copy, org.id)


# ── Product image ─────────────────────────────────────────────────────────────

@router.post("/products/{product_id}/image", response_model=ProductOut)
async def upload_product_image(
    product_id: int,
    file: UploadFile = File(...),
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> ProductOut:
    from app.services import storage as storage_svc
    if file.content_type not in _IMAGE_MIME_EXT:
        raise HTTPException(status_code=400, detail="Підтримуються тільки JPEG, PNG, WebP.")
    data = await file.read()
    if len(data) > _IMAGE_MAX_BYTES:
        raise HTTPException(status_code=400, detail="Файл занадто великий (макс. 8 МБ).")
    p = _get_product(product_id, org, db)
    if p.image_key:
        storage_svc.delete(p.image_key, org.id, prefix=_IMAGE_PREFIX)
    ext = _IMAGE_MIME_EXT[file.content_type]
    key = f"{uuid.uuid4().hex}.{ext}"
    storage_svc.put(key, data, org.id, prefix=_IMAGE_PREFIX)
    p.image_key = key
    db.commit()
    db.refresh(p)
    return _make_product_out(p, org.id)


@router.delete("/products/{product_id}/image", response_model=ProductOut)
def delete_product_image(
    product_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> ProductOut:
    from app.services import storage as storage_svc
    p = _get_product(product_id, org, db)
    if p.image_key:
        storage_svc.delete(p.image_key, org.id, prefix=_IMAGE_PREFIX)
        p.image_key = None
        db.commit()
        db.refresh(p)
    return _make_product_out(p, org.id)


@router.get("/products/{product_id}/image")
def serve_product_image(
    product_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> Response:
    """Serve image bytes for local-storage mode (S3 mode returns presigned URL instead)."""
    from app.services import storage as storage_svc
    p = _get_product(product_id, org, db)
    if not p.image_key:
        raise HTTPException(status_code=404, detail="No image")
    try:
        data = storage_svc.get_bytes(p.image_key, org.id, prefix=_IMAGE_PREFIX)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Image file not found")
    ext = p.image_key.rsplit(".", 1)[-1].lower()
    mime = {"jpg": "image/jpeg", "png": "image/png", "webp": "image/webp"}.get(ext, "image/jpeg")
    return Response(content=data, media_type=mime)


# ── Product images (multi-photo) ──────────────────────────────────────────────

@router.get("/products/{product_id}/images", response_model=list[ProductImageOut])
def list_product_images(
    product_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[ProductImageOut]:
    _get_product(product_id, org, db)  # 404 guard
    rows = (
        db.query(ProductImage)
        .filter_by(product_id=product_id, organization_id=org.id)
        .order_by(ProductImage.is_primary.desc(), ProductImage.sort_order, ProductImage.id)
        .all()
    )
    return [
        ProductImageOut(
            id=img.id,
            image_url=_image_url(img.image_key, product_id, org.id),
            is_primary=img.is_primary,
            sort_order=img.sort_order,
        )
        for img in rows
    ]


@router.post("/products/{product_id}/images", response_model=list[ProductImageOut], status_code=201)
async def add_product_image(
    product_id: int,
    file: UploadFile = File(...),
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> list[ProductImageOut]:
    from app.services import storage as storage_svc
    if file.content_type not in _IMAGE_MIME_EXT:
        raise HTTPException(status_code=400, detail="Підтримуються тільки JPEG, PNG, WebP.")
    data = await file.read()
    if len(data) > _IMAGE_MAX_BYTES:
        raise HTTPException(status_code=400, detail="Файл занадто великий (макс. 8 МБ).")
    p = _get_product(product_id, org, db)
    ext = _IMAGE_MIME_EXT[file.content_type]
    key = f"{uuid.uuid4().hex}.{ext}"
    storage_svc.put(key, data, org.id, prefix=_IMAGE_PREFIX)
    existing_count = db.query(func.count(ProductImage.id)).filter_by(product_id=product_id, organization_id=org.id).scalar() or 0
    is_primary = existing_count == 0
    img = ProductImage(product_id=product_id, organization_id=org.id, image_key=key, is_primary=is_primary, sort_order=existing_count)
    db.add(img)
    if is_primary:
        p.image_key = key
    db.commit()
    return list_product_images(product_id, db, org)


@router.delete("/products/{product_id}/images/{image_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_product_image_by_id(
    product_id: int,
    image_id:   int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> None:
    from app.services import storage as storage_svc
    img = db.query(ProductImage).filter_by(id=image_id, product_id=product_id, organization_id=org.id).first()
    if not img:
        raise HTTPException(status_code=404, detail="Зображення не знайдено")
    was_primary = img.is_primary
    storage_svc.delete(img.image_key, org.id, prefix=_IMAGE_PREFIX)
    db.delete(img)
    db.flush()
    if was_primary:
        next_img = (
            db.query(ProductImage)
            .filter_by(product_id=product_id, organization_id=org.id)
            .order_by(ProductImage.sort_order, ProductImage.id)
            .first()
        )
        p = _get_product(product_id, org, db)
        if next_img:
            next_img.is_primary = True
            p.image_key = next_img.image_key
        else:
            p.image_key = None
    db.commit()


@router.patch("/products/{product_id}/images/{image_id}/set-primary", response_model=list[ProductImageOut])
def set_primary_product_image(
    product_id: int,
    image_id:   int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> list[ProductImageOut]:
    img = db.query(ProductImage).filter_by(id=image_id, product_id=product_id, organization_id=org.id).first()
    if not img:
        raise HTTPException(status_code=404, detail="Зображення не знайдено")
    db.query(ProductImage).filter_by(product_id=product_id, organization_id=org.id).update({"is_primary": False})
    img.is_primary = True
    p = _get_product(product_id, org, db)
    p.image_key = img.image_key
    db.commit()
    return list_product_images(product_id, db, org)


@router.get("/products/{product_id}/images/{image_key}")
def serve_product_image_by_key(
    product_id: int,
    image_key:  str,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> Response:
    """Serve image bytes for local-storage mode."""
    from app.services import storage as storage_svc
    img = db.query(ProductImage).filter_by(image_key=image_key, product_id=product_id, organization_id=org.id).first()
    if not img:
        raise HTTPException(status_code=404, detail="Image not found")
    try:
        data = storage_svc.get_bytes(image_key, org.id, prefix=_IMAGE_PREFIX)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Image file not found")
    ext = image_key.rsplit(".", 1)[-1].lower()
    mime = {"jpg": "image/jpeg", "png": "image/png", "webp": "image/webp"}.get(ext, "image/jpeg")
    return Response(content=data, media_type=mime)


@router.delete("/products/{product_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_product(
    product_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin)),
) -> None:
    p = _get_product(product_id, org, db)
    movements  = db.query(func.count(WarehouseMovement.id)).filter_by(product_id=product_id).scalar() or 0
    order_items = db.query(func.count(OrderItem.id)).filter_by(product_id=product_id).scalar() or 0
    batches    = db.query(func.count(ProductionBatch.id)).filter_by(product_id=product_id).scalar() or 0
    if movements or order_items or batches:
        parts = []
        if movements:   parts.append(f"{movements} рухів")
        if order_items: parts.append(f"{order_items} замовлень")
        if batches:     parts.append(f"{batches} партій")
        raise HTTPException(
            status_code=409,
            detail=f"Товар задіяний у {', '.join(parts)}. Заархівуйте замість видалення.",
        )
    db.delete(p)
    db.commit()


class StockThresholdsUpdate(BaseModel):
    min_stock:     int | None = None
    desired_stock: int | None = None
    box_limit:     int | None = None


@router.patch("/products/{product_id}/thresholds", response_model=ProductOut)
def update_thresholds(
    product_id: int,
    payload:    StockThresholdsUpdate,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> ProductOut:
    p = _get_product(product_id, org, db)
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(p, k, v)
    db.commit()
    db.refresh(p)
    return ProductOut.model_validate(p)


# ── Specifications ────────────────────────────────────────────────────────────

@router.get("/products/{product_id}/specs", response_model=list[SpecOut])
def list_specs(
    product_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[SpecOut]:
    _get_product(product_id, org, db)
    specs = db.query(Specification).filter(Specification.product_id == product_id).order_by(Specification.version).all()
    return [_spec_to_out(s, db) for s in specs]


@router.post("/products/{product_id}/specs", response_model=SpecOut, status_code=status.HTTP_201_CREATED)
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
    return _spec_to_out(spec, db)


_SPEC_TSV_HEADER = "\t".join([
    "Назва виробу", "SKU виробу", "Од. вим. виробу",
    "Пряма собівартість виробу", "Повна собівартість виробу",
    "Назва матеріалу", "SKU матеріалу", "К-сть матеріалу", "Одиниця виміру матеріалу", "Сер.зважена ціна матеріалу",
    "Назва роботи", "К-сть роботи", "Одиниця виміру роботи", "Ціна роботи", "Додаткові витрати", "Вартість витрати",
])


@router.get("/specs/export")
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
            current = {"sku": sku, "unit": row[2].strip(), "components": [], "operations": []}
            products.append(current)
        elif current:
            mat_name = row[5].strip()
            op_name  = row[10].strip()
            if mat_name:
                qty   = row[7].strip()
                price = row[9].strip()
                current["components"].append({
                    "name":       mat_name,
                    "quantity":   Decimal(qty)   if qty   else Decimal("0"),
                    "unit":       row[8].strip() or "шт",
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


class OrdageSpecImportResult(BaseModel):
    updated: int
    skipped: int
    errors:  list[dict]


@router.post("/specs/import", response_model=OrdageSpecImportResult)
def import_ordage_specs(
    file: UploadFile      = File(...),
    db:   Session         = Depends(get_db),
    org:  Organization    = Depends(get_current_org),
    _:    User            = Depends(require_roles(UserRole.admin)),
) -> OrdageSpecImportResult:
    content  = file.file.read()
    filename = (file.filename or "").lower()
    parsed   = _parse_ordage_xlsx(content) if filename.endswith(".xlsx") else _parse_ordage_spec(content)
    updated, skipped = 0, 0
    errors: list[dict] = []

    for item in parsed:
        product = db.query(Product).filter_by(organization_id=org.id, sku=item["sku"]).first()
        if not product:
            skipped += 1
            errors.append({"sku": item["sku"], "reason": "не знайдено"})
            continue

        spec = db.query(Specification).filter_by(product_id=product.id, is_default=True).first()
        if not spec:
            ver  = db.query(Specification).filter_by(product_id=product.id).count()
            spec = Specification(product_id=product.id, name="Основна", is_default=True, version=ver + 1)
            db.add(spec)
            db.flush()

        db.query(SpecComponent).filter_by(specification_id=spec.id).delete()
        for i, c in enumerate(item["components"]):
            db.add(SpecComponent(
                specification_id=spec.id,
                name=c["name"], quantity=c["quantity"],
                unit=c["unit"], unit_price=c["unit_price"],
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


@router.get("/specs/{spec_id}", response_model=SpecOut)
def get_spec(
    spec_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> SpecOut:
    return _spec_to_out(_get_spec(spec_id, org, db), db)


@router.post("/specs/{spec_id}/set-default", response_model=SpecOut)
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
    return _spec_to_out(spec, db)


@router.post("/specs/{spec_id}/components", response_model=SpecOut, status_code=status.HTTP_201_CREATED)
def add_component(
    spec_id: int,
    payload: SpecComponentCreate,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin)),
) -> SpecOut:
    spec = _get_spec(spec_id, org, db)
    comp = SpecComponent(specification_id=spec.id, **payload.model_dump())
    db.add(comp)
    db.commit()
    return _spec_to_out(spec, db)


@router.delete("/specs/{spec_id}/components/{comp_id}", status_code=status.HTTP_204_NO_CONTENT)
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


@router.post("/specs/{spec_id}/operations", response_model=SpecOut, status_code=status.HTTP_201_CREATED)
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
    return _spec_to_out(spec, db)


@router.delete("/specs/{spec_id}/operations/{op_id}", status_code=status.HTTP_204_NO_CONTENT)
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


@router.get("/products/{product_id}/cost", response_model=CostBreakdown)
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


# ── Stock ─────────────────────────────────────────────────────────────────────

@router.get("/stock", response_model=list[StockEntryOut])
def list_stock(
    warehouse_id: int | None = Query(None),
    product_id:   int | None = Query(None),
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[StockEntryOut]:
    q = (
        db.query(StockEntry, Product, Warehouse)
        .join(Product,   Product.id   == StockEntry.product_id)
        .join(Warehouse, Warehouse.id == StockEntry.warehouse_id)
        .filter(StockEntry.organization_id == org.id)
    )
    if warehouse_id:
        q = q.filter(StockEntry.warehouse_id == warehouse_id)
    if product_id:
        q = q.filter(StockEntry.product_id == product_id)
    rows = q.order_by(Product.name).all()

    import math
    import collections
    from sqlalchemy import func
    from app.models.warehouse import CellStock, WarehouseCell, WarehouseZone

    product_ids = {p.id for _, p, _ in rows}
    warehouse_ids = {wh.id for _, _, wh in rows}

    total_stock_map = {}
    if product_ids:
        totals = db.query(
            StockEntry.product_id,
            func.sum(StockEntry.quantity).label("total")
        ).filter(
            StockEntry.organization_id == org.id,
            StockEntry.product_id.in_(product_ids)
        ).group_by(StockEntry.product_id).all()
        total_stock_map = {pid: tot for pid, tot in totals}

    cell_stock_map = collections.defaultdict(list)
    if product_ids and warehouse_ids:
        cell_stocks = db.query(
            CellStock.product_id,
            WarehouseZone.warehouse_id,
            WarehouseZone.name.label("zone_name"),
            WarehouseCell.code,
            CellStock.quantity
        ).join(
            WarehouseCell, WarehouseCell.id == CellStock.cell_id
        ).join(
            WarehouseZone, WarehouseZone.id == WarehouseCell.zone_id
        ).filter(
            WarehouseZone.organization_id == org.id,
            CellStock.product_id.in_(product_ids),
            WarehouseZone.warehouse_id.in_(warehouse_ids),
            CellStock.quantity > 0
        ).all()
        for pid, wid, zone_name, cell_code, qty in cell_stocks:
            cell_name = f"{zone_name} {cell_code}"
            cell_stock_map[(pid, wid)].append({"name": cell_name, "quantity": qty})

    result = []
    for e, p, wh in rows:
        avail = e.quantity - e.reserved_qty
        boxes_to_order = None
        if (p.desired_stock is not None and p.box_limit and p.box_limit > 0
                and avail < p.desired_stock):
            boxes_to_order = math.ceil((p.desired_stock - float(avail)) / p.box_limit)

        total_stock = total_stock_map.get(e.product_id, Decimal(0))
        locations = cell_stock_map.get((e.product_id, e.warehouse_id), [])

        result.append(StockEntryOut(
            id=e.id,
            product_id=e.product_id,
            product_name=p.name,
            product_sku=p.sku,
            product_barcode=p.barcode,
            product_categories=p.categories or [],
            product_unit=p.unit,
            warehouse_id=e.warehouse_id,
            warehouse_name=wh.name,
            locations=locations,
            quantity=e.quantity,
            reserved_qty=e.reserved_qty,
            available=avail,
            total_stock=total_stock,
            full_cost=p.full_cost,
            min_stock=p.min_stock,
            desired_stock=p.desired_stock,
            box_limit=p.box_limit,
            boxes_to_order=boxes_to_order,
            updated_at=e.updated_at,
        ))
    return result


# ── Replenishment ─────────────────────────────────────────────────────────────

class _ReplenishPreviewItem(BaseModel):
    product_id:       int
    product_name:     str
    product_sku:      str
    unit:             str
    available:        float
    min_stock:        int
    desired_stock:    int | None
    qty_needed:       int
    kind:             str         # "batch" | "purchase"
    specification_id: int | None
    warehouse_id:     int | None
    warehouse_name:   str | None


class _ReplenishItem(BaseModel):
    product_id:       int
    qty:              int
    kind:             str         # "batch" | "purchase"
    warehouse_id:     int | None = None
    specification_id: int | None = None


class _ReplenishRequest(BaseModel):
    items: list[_ReplenishItem]


@router.get("/stock/replenish-preview", response_model=list[_ReplenishPreviewItem])
def replenish_preview(
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[_ReplenishPreviewItem]:
    rows = (
        db.query(StockEntry, Product, Warehouse)
        .join(Product,   Product.id   == StockEntry.product_id)
        .join(Warehouse, Warehouse.id == StockEntry.warehouse_id)
        .filter(
            StockEntry.organization_id == org.id,
            Product.is_active.is_(True),
            Product.min_stock.isnot(None),
            StockEntry.quantity - StockEntry.reserved_qty < Product.min_stock,
        )
        .order_by(Product.name)
        .all()
    )
    if not rows:
        return []

    product_ids = list({p.id for _, p, _ in rows})
    default_specs = {
        s.product_id: s
        for s in db.query(Specification)
        .filter(
            Specification.organization_id == org.id,
            Specification.product_id.in_(product_ids),
            Specification.is_default.is_(True),
        )
        .all()
    }

    seen: set[int] = set()
    result: list[_ReplenishPreviewItem] = []
    for e, p, wh in rows:
        if p.id in seen:
            continue
        seen.add(p.id)
        avail = float(e.quantity - e.reserved_qty)
        target = p.desired_stock if p.desired_stock else p.min_stock
        qty_needed = max(1, int(target - avail))
        spec = default_specs.get(p.id)
        result.append(_ReplenishPreviewItem(
            product_id=p.id,
            product_name=p.name,
            product_sku=p.sku,
            unit=p.unit,
            available=avail,
            min_stock=p.min_stock,
            desired_stock=p.desired_stock,
            qty_needed=qty_needed,
            kind="batch" if spec else "purchase",
            specification_id=spec.id if spec else None,
            warehouse_id=wh.id,
            warehouse_name=wh.name,
        ))
    return result


@router.post("/stock/replenish")
def replenish_stock(
    payload: _ReplenishRequest,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> dict:
    batches_created = 0
    movements_created = 0
    for item in payload.items:
        if item.qty <= 0:
            continue
        _get_product(item.product_id, org, db)
        if item.kind == "batch":
            b = ProductionBatch(
                organization_id=org.id,
                product_id=item.product_id,
                specification_id=item.specification_id,
                target_qty=item.qty,
                status=BatchStatus.open,
                created_by_id=user.id,
            )
            db.add(b)
            batches_created += 1
        elif item.kind == "purchase" and item.warehouse_id:
            p = db.get(Product, item.product_id)
            m = WarehouseMovement(
                organization_id=org.id,
                product_id=item.product_id,
                type=MovementType.PURCHASE_IN,
                warehouse_to_id=item.warehouse_id,
                quantity=Decimal(str(item.qty)),
                unit=p.unit,  # type: ignore[union-attr]
                created_by_id=user.id,
            )
            db.add(m)
            db.flush()
            _apply_movement(m, db)
            movements_created += 1
    db.commit()
    return {"batches": batches_created, "movements": movements_created}


# ── Movements ─────────────────────────────────────────────────────────────────

def _encode_cursor(created_at: datetime, row_id: int) -> str:
    raw = f"{created_at.isoformat()}|{row_id}"
    return base64.urlsafe_b64encode(raw.encode()).decode()


def _decode_cursor(cursor: str) -> tuple[datetime, int]:
    raw = base64.urlsafe_b64decode(cursor.encode()).decode()
    created_iso, id_str = raw.rsplit("|", 1)
    return datetime.fromisoformat(created_iso), int(id_str)


@router.get("/movements", response_model=MovementListOut)
def list_movements(
    movement_type: MovementType | None = Query(None),
    product_id:    int | None          = Query(None),
    batch_id:      int | None          = Query(None),
    order_id:      int | None          = Query(None),
    cursor:        str | None          = Query(None),
    limit:         int                 = Query(50, ge=1, le=200),
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> MovementListOut:
    from sqlalchemy import and_, or_, select, func as safunc

    def _base_filter(q):
        q = q.where(WarehouseMovement.organization_id == org.id)
        if movement_type:
            q = q.where(WarehouseMovement.type == movement_type)
        if product_id:
            q = q.where(WarehouseMovement.product_id == product_id)
        if batch_id:
            q = q.where(WarehouseMovement.batch_id == batch_id)
        if order_id:
            q = q.where(WarehouseMovement.order_id == order_id)
        return q

    # total count — only on first page, with same filters (no cursor)
    total: int | None = None
    if cursor is None:
        count_q = _base_filter(select(safunc.count(WarehouseMovement.id)))
        total = db.execute(count_q).scalar_one()

    # data query with keyset cursor
    data_q = _base_filter(select(WarehouseMovement))
    if cursor:
        try:
            c_at, c_id = _decode_cursor(cursor)
            data_q = data_q.where(
                or_(
                    WarehouseMovement.created_at < c_at,
                    and_(
                        WarehouseMovement.created_at == c_at,
                        WarehouseMovement.id < c_id,
                    ),
                )
            )
        except Exception:
            pass  # bad cursor → ignore, return from start

    data_q = data_q.order_by(
        WarehouseMovement.created_at.desc(),
        WarehouseMovement.id.desc(),
    ).limit(limit + 1)

    rows = db.execute(data_q).scalars().all()
    has_more = len(rows) > limit
    rows = list(rows[:limit])

    next_cursor = _encode_cursor(rows[-1].created_at, rows[-1].id) if has_more else None

    # build product name map in one query
    pids = {r.product_id for r in rows}
    products = {p.id: p.name for p in db.query(Product).filter(Product.id.in_(pids)).all()} if pids else {}

    items = [
        MovementOut(
            id=m.id, type=m.type,
            product_id=m.product_id, product_name=products.get(m.product_id, ""),
            warehouse_from_id=m.warehouse_from_id, warehouse_to_id=m.warehouse_to_id,
            quantity=m.quantity, unit=m.unit,
            unit_cost=m.unit_cost, total_cost=m.total_cost,
            unit_price=m.unit_price, total_revenue=m.total_revenue,
            reason=m.reason, batch_id=m.batch_id, order_id=m.order_id,
            created_at=m.created_at,
        )
        for m in rows
    ]

    return MovementListOut(items=items, next_cursor=next_cursor, has_more=has_more, total=total)


@router.post("/movements", response_model=MovementOut, status_code=status.HTTP_201_CREATED)
def create_movement(
    payload: MovementCreate,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> MovementOut:
    _get_product(payload.product_id, org, db)
    if payload.type == MovementType.PURCHASE_IN and not payload.unit_cost:
        raise HTTPException(status_code=400, detail="Закупка потребує ціну за одиницю (unit_cost)")
    total = (payload.quantity * payload.unit_cost) if payload.unit_cost else None
    m = WarehouseMovement(
        organization_id=org.id,
        created_by_id=user.id,
        total_cost=total,
        **payload.model_dump(),
    )
    db.add(m)
    db.flush()
    _apply_movement(m, db)

    if payload.type in (MovementType.SALE_OUT, MovementType.PRODUCTION_OUT, MovementType.DEFECT, MovementType.TRANSFER):
        _check_and_auto_replenish(m.product_id, org.id, db)

    db.commit()
    db.refresh(m)
    p = db.get(Product, m.product_id)
    return MovementOut(
        id=m.id, type=m.type,
        product_id=m.product_id, product_name=p.name if p else "",  # type: ignore[union-attr]
        warehouse_from_id=m.warehouse_from_id, warehouse_to_id=m.warehouse_to_id,
        quantity=m.quantity, unit=m.unit,
        unit_cost=m.unit_cost, total_cost=m.total_cost,
        reason=m.reason, batch_id=m.batch_id, order_id=m.order_id,
        created_at=m.created_at,
    )


# ── ProductionBatch ───────────────────────────────────────────────────────────

def _batch_to_out(b: ProductionBatch, db: Session) -> BatchOut:
    p = db.get(Product, b.product_id)

    components: list[BatchComponentOut] = []
    if b.specification_id:
        spec_comps = (
            db.query(SpecComponent)
            .filter_by(specification_id=b.specification_id)
            .order_by(SpecComponent.sort_order)
            .all()
        )
        for c in spec_comps:
            total_qty = c.quantity * b.target_qty
            available_stock: Decimal | None = None
            product_name: str | None = None
            if c.product_id:
                cp = db.get(Product, c.product_id)
                product_name = cp.name if cp else None
                entries = db.query(StockEntry).filter_by(product_id=c.product_id).all()
                available_stock = sum(
                    (max(Decimal("0"), e.quantity - e.reserved_qty) for e in entries),
                    Decimal("0"),
                )
            components.append(BatchComponentOut(
                id=c.id,
                name=c.name,
                product_id=c.product_id,
                product_name=product_name,
                quantity=c.quantity,
                unit=c.unit,
                total_qty=total_qty,
                available_stock=available_stock,
                is_sufficient=available_stock is None or available_stock >= total_qty,
            ))

    return BatchOut(
        id=b.id, product_id=b.product_id,
        product_name=p.name if p else "",  # type: ignore[union-attr]
        specification_id=b.specification_id,
        target_qty=b.target_qty, printed_qty=b.printed_qty,
        good_qty=b.good_qty, defect_qty=b.defect_qty,
        status=b.status, due_date=b.due_date,
        order_id=b.order_id, notes=b.notes,
        components=components,
        created_at=b.created_at, updated_at=b.updated_at,
    )


@router.get("/batches", response_model=list[BatchOut])
def list_batches(
    batch_status: BatchStatus | None = Query(None),
    product_id:   int | None         = Query(None),
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[BatchOut]:
    q = db.query(ProductionBatch).filter(ProductionBatch.organization_id == org.id)
    if batch_status:
        q = q.filter(ProductionBatch.status == batch_status)
    if product_id:
        q = q.filter(ProductionBatch.product_id == product_id)
    rows = q.order_by(ProductionBatch.created_at.desc()).all()
    return [_batch_to_out(b, db) for b in rows]


@router.post("/batches", response_model=BatchOut, status_code=status.HTTP_201_CREATED)
def create_batch(
    payload: BatchCreate,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> BatchOut:
    _get_product(payload.product_id, org, db)
    b = ProductionBatch(organization_id=org.id, created_by_id=user.id, **payload.model_dump())
    db.add(b)
    db.commit()
    db.refresh(b)
    return _batch_to_out(b, db)


@router.get("/batches/{batch_id}", response_model=BatchOut)
def get_batch(
    batch_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> BatchOut:
    b = db.query(ProductionBatch).filter_by(id=batch_id, organization_id=org.id).first()
    if not b:
        raise HTTPException(status_code=404, detail="Batch not found")
    return _batch_to_out(b, db)


@router.patch("/batches/{batch_id}", response_model=BatchOut)
def update_batch(
    batch_id: int,
    payload:  BatchUpdate,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> BatchOut:
    b = db.query(ProductionBatch).filter_by(id=batch_id, organization_id=org.id).first()
    if not b:
        raise HTTPException(status_code=404, detail="Batch not found")
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(b, k, v)
    db.commit()
    db.refresh(b)
    return _batch_to_out(b, db)


@router.patch("/batches/{batch_id}/progress", response_model=BatchOut)
def update_progress(
    batch_id:   int,
    printed_qty: int = Query(..., ge=0),
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    _:    User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> BatchOut:
    b = db.query(ProductionBatch).filter_by(id=batch_id, organization_id=org.id).first()
    if not b:
        raise HTTPException(status_code=404, detail="Batch not found")
    if b.status != BatchStatus.active:
        raise HTTPException(status_code=400, detail="Прогрес можна оновлювати лише в активній партії")
    if printed_qty > b.target_qty:
        raise HTTPException(status_code=400, detail=f"Кількість не може перевищувати ціль ({b.target_qty})")
    b.printed_qty = printed_qty
    db.commit()
    db.refresh(b)
    return _batch_to_out(b, db)


@router.post("/batches/{batch_id}/close", response_model=BatchOut)
def close_batch(
    batch_id: int,
    payload:  BatchClose,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> BatchOut:
    b = db.query(ProductionBatch).filter_by(id=batch_id, organization_id=org.id).first()
    if not b:
        raise HTTPException(status_code=404, detail="Batch not found")
    if b.status == BatchStatus.done:
        raise HTTPException(status_code=400, detail="Batch already closed")

    b.good_qty   = payload.good_qty
    b.defect_qty = payload.defect_qty
    b.status     = BatchStatus.done

    if payload.good_qty > 0 and payload.finished_warehouse_id:
        m_in = WarehouseMovement(
            organization_id=org.id, created_by_id=user.id,
            type=MovementType.PRODUCTION_IN,
            product_id=b.product_id,
            warehouse_to_id=payload.finished_warehouse_id,
            quantity=Decimal(payload.good_qty), unit="шт",
            batch_id=b.id,
        )
        db.add(m_in)
        db.flush()
        _apply_movement(m_in, db)

    if payload.defect_qty > 0 and payload.defect_warehouse_id:
        m_def = WarehouseMovement(
            organization_id=org.id, created_by_id=user.id,
            type=MovementType.DEFECT,
            product_id=b.product_id,
            warehouse_to_id=payload.defect_warehouse_id,
            quantity=Decimal(payload.defect_qty), unit="шт",
            batch_id=b.id,
        )
        db.add(m_def)
        db.flush()
        _apply_movement(m_def, db)

    # Deduct spec components from stock for every good unit assembled
    if b.specification_id and payload.good_qty > 0:
        spec_comps = db.query(SpecComponent).filter_by(specification_id=b.specification_id).all()
        for c in spec_comps:
            if not c.product_id:
                continue
            qty_needed = c.quantity * Decimal(payload.good_qty)
            # Pick the warehouse with the most available stock
            entries = db.query(StockEntry).filter_by(product_id=c.product_id).all()
            entries.sort(key=lambda e: float(e.quantity - e.reserved_qty), reverse=True)
            best = entries[0] if entries and (entries[0].quantity - entries[0].reserved_qty) > 0 else None
            if not best:
                continue
            m_out = WarehouseMovement(
                organization_id=org.id, created_by_id=user.id,
                type=MovementType.PRODUCTION_OUT,
                product_id=c.product_id,
                warehouse_from_id=best.warehouse_id,
                quantity=qty_needed,
                unit=c.unit,
                batch_id=b.id,
            )
            db.add(m_out)
            db.flush()
            _apply_movement(m_out, db)

    db.commit()
    db.refresh(b)
    return _batch_to_out(b, db)


# ── Orders ────────────────────────────────────────────────────────────────────

@router.get("/orders", response_model=list[OrderOut])
def list_orders(
    order_status: OrderStatus | None = Query(None),
    counterparty_id: int | None      = Query(None),
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[OrderOut]:
    q = db.query(Order).filter(Order.organization_id == org.id)
    if order_status:
        q = q.filter(Order.status == order_status)
    if counterparty_id:
        q = q.filter(Order.counterparty_id == counterparty_id)
    rows = q.order_by(Order.created_at.desc()).all()
    return [_order_to_out(o, db) for o in rows]


@router.post("/orders", response_model=OrderOut, status_code=status.HTTP_201_CREATED)
def create_order(
    payload: OrderCreate,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> OrderOut:
    if payload.counterparty_id:
        _get_counterparty(payload.counterparty_id, org, db)

    order_number = _next_order_number(org, db)
    total = sum(it.unit_price * it.quantity for it in payload.items) if payload.items else None

    o = Order(
        organization_id=org.id,
        created_by_id=user.id,
        order_number=order_number,
        counterparty_id=payload.counterparty_id,
        customer_name=payload.customer_name,
        source=payload.source,
        due_date=payload.due_date,
        currency=payload.currency,
        notes=payload.notes,
        total_amount=total,
    )
    db.add(o)
    db.flush()

    for it in payload.items:
        _get_product(it.product_id, org, db)
        db.add(OrderItem(
            order_id=o.id,
            product_id=it.product_id,
            warehouse_id=it.warehouse_id,
            quantity=it.quantity,
            unit_price=it.unit_price,
            total_price=it.unit_price * it.quantity,
        ))

    db.commit()
    db.refresh(o)
    return _order_to_out(o, db)


@router.get("/orders/{order_id}", response_model=OrderOut)
def get_order(
    order_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> OrderOut:
    o = db.query(Order).filter_by(id=order_id, organization_id=org.id).first()
    if not o:
        raise HTTPException(status_code=404, detail="Order not found")
    return _order_to_out(o, db)


@router.patch("/orders/{order_id}", response_model=OrderOut)
def update_order(
    order_id: int,
    payload:  OrderUpdate,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> OrderOut:
    o = db.query(Order).filter_by(id=order_id, organization_id=org.id).first()
    if not o:
        raise HTTPException(status_code=404, detail="Order not found")
    if payload.counterparty_id is not None:
        _get_counterparty(payload.counterparty_id, org, db)
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(o, k, v)
    db.commit()
    db.refresh(o)
    return _order_to_out(o, db)


@router.post("/orders/{order_id}/reserve", response_model=OrderOut)
def reserve_order(
    order_id: int,
    payload:  ReserveRequest,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    _:    User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> OrderOut:
    """Lock stock for all items in the order using SELECT FOR UPDATE.

    Transitions order: new → confirmed.
    Sets item.warehouse_id to the chosen warehouse for each item.
    """
    _get_warehouse(payload.warehouse_id, org, db)

    # Lock the order row first to prevent double-reserve races
    o = (
        db.query(Order)
        .filter_by(id=order_id, organization_id=org.id)
        .with_for_update()
        .first()
    )
    if not o:
        raise HTTPException(status_code=404, detail="Order not found")
    if o.status != OrderStatus.new:
        raise HTTPException(status_code=400, detail=f"Cannot reserve order with status '{o.status}'")

    items = db.query(OrderItem).filter_by(order_id=o.id).all()
    if not items:
        raise HTTPException(status_code=400, detail="Order has no items")

    # Check and lock stock for every item before mutating anything
    shortage: list[str] = []
    for item in items:
        wh_id = item.warehouse_id or payload.warehouse_id
        entry = (
            db.query(StockEntry)
            .filter_by(product_id=item.product_id, warehouse_id=wh_id)
            .with_for_update()
            .first()
        )
        available = (entry.quantity - entry.reserved_qty) if entry else Decimal("0")
        if available < item.quantity:
            product = db.get(Product, item.product_id)
            name = product.name if product else f"#{item.product_id}"
            shortage.append(f"{name}: потрібно {item.quantity}, доступно {available:.0f}")

    if shortage:
        raise HTTPException(
            status_code=422,
            detail="Недостатньо товару на складі:\n" + "\n".join(shortage),
        )

    # All checks passed — apply reservations
    for item in items:
        wh_id = item.warehouse_id or payload.warehouse_id

        entry = db.query(StockEntry).filter_by(product_id=item.product_id, warehouse_id=wh_id).first()
        if entry:
            entry.reserved_qty += item.quantity

        # Record which warehouse this item is reserved from
        item.warehouse_id = wh_id

    o.status = OrderStatus.confirmed
    db.commit()
    db.refresh(o)
    return _order_to_out(o, db)


@router.post("/orders/{order_id}/ship", response_model=OrderOut)
def ship_order(
    order_id: int,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> OrderOut:
    """Deduct stock, create SALE_OUT movements, update counterparty balance.

    Transitions order: confirmed | ready → shipped.
    """
    o = (
        db.query(Order)
        .filter_by(id=order_id, organization_id=org.id)
        .with_for_update()
        .first()
    )
    if not o:
        raise HTTPException(status_code=404, detail="Order not found")
    if o.status not in (OrderStatus.confirmed, OrderStatus.ready):
        raise HTTPException(status_code=400, detail=f"Cannot ship order with status '{o.status}'")

    items = db.query(OrderItem).filter_by(order_id=o.id).all()

    for item in items:
        if not item.warehouse_id:
            product = db.get(Product, item.product_id)
            name = product.name if product else f"#{item.product_id}"
            raise HTTPException(
                status_code=400,
                detail=f"Item '{name}' has no warehouse assigned — reserve the order first",
            )

        # Lock and deduct
        entry = (
            db.query(StockEntry)
            .filter_by(product_id=item.product_id, warehouse_id=item.warehouse_id)
            .with_for_update()
            .first()
        )
        if entry:
            entry.quantity     -= item.quantity
            entry.reserved_qty -= min(entry.reserved_qty, Decimal(item.quantity))

        # Create audit movement — store both cost (COGS) and price (revenue) separately
        prod       = db.get(Product, item.product_id)
        unit_cost  = prod.cost_price if prod else None
        unit_price = Decimal(str(item.unit_price)) if item.unit_price else None
        qty        = Decimal(item.quantity)

        m = WarehouseMovement(
            organization_id=org.id,
            created_by_id=user.id,
            type=MovementType.SALE_OUT,
            product_id=item.product_id,
            warehouse_from_id=item.warehouse_id,
            quantity=qty,
            unit="шт",
            unit_cost=unit_cost,
            total_cost=(unit_cost * qty) if unit_cost else None,
            unit_price=unit_price,
            total_revenue=(unit_price * qty) if unit_price else None,
            order_id=o.id,
        )
        db.add(m)

    # Update counterparty balance (outstanding debt)
    if o.counterparty_id:
        outstanding = (o.total_amount or Decimal("0")) - (o.paid_amount or Decimal("0"))
        if outstanding > 0:
            cp = db.query(Counterparty).with_for_update().filter_by(id=o.counterparty_id).first()
            if cp:
                cp.balance += outstanding

    o.status = OrderStatus.shipped
    db.commit()
    db.refresh(o)
    return _order_to_out(o, db)


@router.post("/orders/{order_id}/cancel", response_model=OrderOut)
def cancel_order(
    order_id: int,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    _:    User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> OrderOut:
    """Cancel an order and release any reserved stock."""
    o = (
        db.query(Order)
        .filter_by(id=order_id, organization_id=org.id)
        .with_for_update()
        .first()
    )
    if not o:
        raise HTTPException(status_code=404, detail="Order not found")
    if o.status == OrderStatus.shipped:
        raise HTTPException(status_code=400, detail="Cannot cancel a shipped order")

    # Release reservations if the order was confirmed
    if o.status == OrderStatus.confirmed:
        items = db.query(OrderItem).filter_by(order_id=o.id).all()
        for item in items:
            if item.warehouse_id:
                entry = (
                    db.query(StockEntry)
                    .filter_by(product_id=item.product_id, warehouse_id=item.warehouse_id)
                    .with_for_update()
                    .first()
                )
                if entry:
                    entry.reserved_qty -= min(entry.reserved_qty, Decimal(item.quantity))

    o.status = OrderStatus.cancelled
    db.commit()
    db.refresh(o)
    return _order_to_out(o, db)


# ── Order Payments ────────────────────────────────────────────────────────────

@router.post("/orders/{order_id}/payments", response_model=OrderPaymentOut, status_code=status.HTTP_201_CREATED)
def record_payment(
    order_id: int,
    payload:  OrderPaymentCreate,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> OrderPaymentOut:
    o = db.query(Order).filter_by(id=order_id, organization_id=org.id).first()
    if not o:
        raise HTTPException(status_code=404, detail="Order not found")
    if o.status == OrderStatus.cancelled:
        raise HTTPException(status_code=400, detail="Скасоване замовлення не може приймати оплати")
    if payload.amount <= 0:
        raise HTTPException(status_code=400, detail="Сума оплати має бути > 0")

    # No overpayment (allow prepayment on any status, block if already overpaid)
    total = o.total_amount or Decimal("0")
    if total > 0 and (o.paid_amount + payload.amount) > total:
        raise HTTPException(
            status_code=400,
            detail=f"Сума перевищує залишок до оплати ({total - o.paid_amount} ₴)",
        )

    paid_at = payload.paid_at or date.today()

    # Atomic: cashflow → payment → order.paid_amount → cp.balance
    tx = CashTransaction(
        organization_id=org.id,
        created_by_id=user.id,
        type=CashTxType.income,
        category=CashTxCategory.order_payment,
        amount=payload.amount,
        counterparty_id=o.counterparty_id,
        order_id=o.id,
        description=f"Оплата {o.order_number}",
        transaction_date=paid_at,
    )
    db.add(tx)
    db.flush()  # get tx.id before linking

    payment = OrderPayment(
        organization_id=org.id,
        order_id=o.id,
        amount=payload.amount,
        paid_at=paid_at,
        method=payload.method,
        note=payload.note,
        cashflow_id=tx.id,
    )
    db.add(payment)
    db.flush()

    o.paid_amount = o.paid_amount + payload.amount

    # Reduce counterparty debt (guard: only if counterparty exists)
    if o.counterparty_id:
        cp = db.query(Counterparty).with_for_update().filter_by(id=o.counterparty_id).first()
        if cp:
            cp.balance -= payload.amount

    db.commit()
    db.refresh(payment)
    return OrderPaymentOut.model_validate(payment)


@router.get("/orders/{order_id}/payments", response_model=list[OrderPaymentOut])
def list_payments(
    order_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[OrderPaymentOut]:
    o = db.query(Order).filter_by(id=order_id, organization_id=org.id).first()
    if not o:
        raise HTTPException(status_code=404, detail="Order not found")
    rows = (
        db.query(OrderPayment)
        .filter_by(order_id=order_id, organization_id=org.id)
        .order_by(OrderPayment.paid_at.desc(), OrderPayment.id.desc())
        .all()
    )
    return [OrderPaymentOut.model_validate(p) for p in rows]


@router.delete("/orders/{order_id}/payments/{payment_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_payment(
    order_id:   int,
    payment_id: int,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    _:    User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> None:
    o = db.query(Order).filter_by(id=order_id, organization_id=org.id).first()
    if not o:
        raise HTTPException(status_code=404, detail="Order not found")
    p = db.query(OrderPayment).filter_by(id=payment_id, order_id=order_id, organization_id=org.id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Payment not found")

    amount = p.amount

    # Delete linked cashflow (guard: tx may have been deleted manually)
    if p.cashflow_id:
        tx = db.get(CashTransaction, p.cashflow_id)
        if tx:
            db.delete(tx)

    db.delete(p)
    db.flush()

    # Recalculate paid_amount from remaining payments
    from sqlalchemy import select, func as safunc
    new_paid = db.execute(
        select(safunc.coalesce(safunc.sum(OrderPayment.amount), Decimal("0")))
        .where(OrderPayment.order_id == order_id)
    ).scalar_one()
    o.paid_amount = new_paid

    # Restore counterparty debt
    if o.counterparty_id:
        cp = db.query(Counterparty).with_for_update().filter_by(id=o.counterparty_id).first()
        if cp:
            cp.balance += amount

    db.commit()


# ── Cash Flow ─────────────────────────────────────────────────────────────────

def _tx_to_out(tx: CashTransaction, db: Session) -> CashTxOut:
    cp_name: str | None = None
    if tx.counterparty_id:
        cp = db.get(Counterparty, tx.counterparty_id)
        if cp:
            cp_name = cp.name

    order_number: str | None = None
    if tx.order_id:
        o = db.get(Order, tx.order_id)
        if o:
            order_number = o.order_number

    return CashTxOut(
        id=tx.id,
        type=tx.type,
        category=tx.category,
        amount=tx.amount,
        counterparty_id=tx.counterparty_id,
        counterparty_name=cp_name,
        order_id=tx.order_id,
        order_number=order_number,
        description=tx.description,
        transaction_date=tx.transaction_date,
        created_at=tx.created_at,
    )


@router.get("/cashflow", response_model=list[CashTxOut])
def list_cashflow(
    tx_type:    str | None = Query(None, alias="type"),
    date_from:  date | None = Query(None),
    date_to:    date | None = Query(None),
    counterparty_id: int | None = Query(None),
    limit:      int = Query(200, le=1000),
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[CashTxOut]:
    q = db.query(CashTransaction).filter(CashTransaction.organization_id == org.id)
    if tx_type:
        q = q.filter(CashTransaction.type == tx_type)
    if date_from:
        q = q.filter(CashTransaction.transaction_date >= date_from)
    if date_to:
        q = q.filter(CashTransaction.transaction_date <= date_to)
    if counterparty_id:
        q = q.filter(CashTransaction.counterparty_id == counterparty_id)
    rows = q.order_by(CashTransaction.transaction_date.desc(), CashTransaction.id.desc()).limit(limit).all()
    return [_tx_to_out(tx, db) for tx in rows]


@router.post("/cashflow", response_model=CashTxOut, status_code=status.HTTP_201_CREATED)
def create_cash_tx(
    payload: CashTxCreate,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> CashTxOut:
    if payload.counterparty_id:
        _get_counterparty(payload.counterparty_id, org, db)
    if payload.order_id:
        o = db.query(Order).filter_by(id=payload.order_id, organization_id=org.id).first()
        if not o:
            raise HTTPException(status_code=404, detail="Order not found")

    tx = CashTransaction(
        organization_id=org.id,
        created_by_id=user.id,
        **payload.model_dump(),
    )
    db.add(tx)
    db.commit()
    db.refresh(tx)
    return _tx_to_out(tx, db)


@router.delete("/cashflow/{tx_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_cash_tx(
    tx_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin)),
) -> None:
    tx = db.query(CashTransaction).filter_by(id=tx_id, organization_id=org.id).first()
    if not tx:
        raise HTTPException(status_code=404, detail="Transaction not found")
    db.delete(tx)
    db.commit()


@router.get("/cashflow/summary", response_model=CashFlowSummary)
def cashflow_summary(
    date_from: date | None = Query(None),
    date_to:   date | None = Query(None),
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> CashFlowSummary:
    q = db.query(CashTransaction).filter(CashTransaction.organization_id == org.id)
    if date_from:
        q = q.filter(CashTransaction.transaction_date >= date_from)
    if date_to:
        q = q.filter(CashTransaction.transaction_date <= date_to)
    txs = q.all()

    total_income  = sum(tx.amount for tx in txs if tx.type == CashTxType.income)
    total_expense = sum(tx.amount for tx in txs if tx.type == CashTxType.expense)

    # Group by category
    cat_totals: dict[tuple, Decimal] = {}
    for tx in txs:
        key = (tx.category.value, tx.type.value)
        cat_totals[key] = cat_totals.get(key, Decimal("0")) + tx.amount

    by_category = [
        {"category": cat, "type": typ, "total": float(total)}
        for (cat, typ), total in sorted(cat_totals.items(), key=lambda x: x[1], reverse=True)
    ]

    return CashFlowSummary(
        total_income=total_income,
        total_expense=total_expense,
        net=total_income - total_expense,
        by_category=by_category,
    )


# ── Analytics ─────────────────────────────────────────────────────────────────

class TopProduct(BaseModel):
    product_id:   int
    product_name: str
    revenue:      Decimal
    units:        int

class MaterialCost(BaseModel):
    name: str
    cost: Decimal

class CashFlowBucket(BaseModel):
    label:   str
    inflow:  Decimal
    outflow: Decimal

class WarehouseAnalytics(BaseModel):
    revenue:        Decimal
    cogs:           Decimal
    gross_profit:   Decimal
    margin_pct:     Decimal
    units_produced: int
    units_sold:     int
    defect_rate:    Decimal
    top_products:   list[TopProduct]
    material_costs: list[MaterialCost]
    cash_flow:      list[CashFlowBucket]


def _period_range(period: str) -> tuple[date, date]:
    today = date.today()
    if period == "month":
        start = today.replace(day=1)
    elif period == "quarter":
        q_start_month = ((today.month - 1) // 3) * 3 + 1
        start = today.replace(month=q_start_month, day=1)
    else:
        start = today.replace(month=1, day=1)
    return start, today


@router.get("/analytics", response_model=WarehouseAnalytics)
def get_analytics(
    period: str          = Query("month", pattern="^(month|quarter|year)$"),
    db:     Session      = Depends(get_db),
    org:    Organization = Depends(get_current_org),
) -> WarehouseAnalytics:
    start, end = _period_range(period)

    def _mvmt(mtype: MovementType) -> list[WarehouseMovement]:
        return (
            db.query(WarehouseMovement)
            .filter(
                WarehouseMovement.organization_id == org.id,
                WarehouseMovement.type == mtype,
                func.date(WarehouseMovement.created_at) >= start,
                func.date(WarehouseMovement.created_at) <= end,
            )
            .all()
        )

    sales     = _mvmt(MovementType.SALE_OUT)
    prod_out  = _mvmt(MovementType.PRODUCTION_OUT)
    purchases = _mvmt(MovementType.PURCHASE_IN)

    # Revenue = sum of sale prices (total_revenue); COGS = sum of cost prices (total_cost on SALE_OUT)
    revenue      = sum((m.total_revenue or m.total_cost or Decimal("0")) for m in sales)
    cogs         = sum((m.total_cost    or Decimal("0")) for m in sales)
    gross_profit = revenue - cogs
    margin_pct   = (gross_profit / revenue * 100) if revenue > 0 else Decimal("0")

    batches_done = (
        db.query(ProductionBatch)
        .filter(
            ProductionBatch.organization_id == org.id,
            ProductionBatch.status == BatchStatus.done,
            func.date(ProductionBatch.updated_at) >= start,
        )
        .all()
    )
    total_printed  = sum(b.good_qty + b.defect_qty for b in batches_done)
    units_produced = sum(b.good_qty for b in batches_done)
    units_sold     = int(sum(m.quantity for m in sales))
    defect_rate    = (
        Decimal(sum(b.defect_qty for b in batches_done)) / Decimal(total_printed) * 100
        if total_printed > 0 else Decimal("0")
    )

    rev_by: dict[int, Decimal] = {}
    qty_by: dict[int, int]    = {}
    for m in sales:
        rev_by[m.product_id] = rev_by.get(m.product_id, Decimal("0")) + (m.total_cost or Decimal("0"))
        qty_by[m.product_id] = qty_by.get(m.product_id, 0) + int(m.quantity)

    top_products = [
        TopProduct(
            product_id=pid,
            product_name=(db.get(Product, pid).name if db.get(Product, pid) else f"#{pid}"),
            revenue=rev,
            units=qty_by.get(pid, 0),
        )
        for pid, rev in sorted(rev_by.items(), key=lambda x: x[1], reverse=True)[:5]
    ]

    mat: dict[str, Decimal] = {}
    for m in purchases:
        p = db.get(Product, m.product_id)
        key = p.name if p else f"#{m.product_id}"
        mat[key] = mat.get(key, Decimal("0")) + (m.total_cost or Decimal("0"))
    material_costs = [
        MaterialCost(name=n, cost=c)
        for n, c in sorted(mat.items(), key=lambda x: x[1], reverse=True)[:5]
    ]

    # Explicit cash-flow direction per movement type:
    #   inflow  = money received  (SALE_OUT: use total_revenue)
    #   outflow = money spent     (PURCHASE_IN: cost of goods; PRODUCTION_OUT: component consumption)
    #   ignore  = internal moves  (PRODUCTION_IN, TRANSFER, ADJUSTMENT, DEFECT)
    _CF_DIRECTION: dict[MovementType, str] = {
        MovementType.SALE_OUT:       "inflow",
        MovementType.PURCHASE_IN:    "outflow",
        MovementType.PRODUCTION_OUT: "outflow",
        MovementType.PRODUCTION_IN:  "ignore",
        MovementType.TRANSFER:       "ignore",
        MovementType.ADJUSTMENT:     "ignore",
        MovementType.DEFECT:         "ignore",
    }

    def _cf_value(m: WarehouseMovement) -> Decimal:
        if m.type == MovementType.SALE_OUT:
            return m.total_revenue or m.total_cost or Decimal("0")
        return m.total_cost or Decimal("0")

    all_mvmts = sales + prod_out + purchases + _mvmt(MovementType.TRANSFER) + _mvmt(MovementType.ADJUSTMENT)

    month_names = ["Січ","Лют","Бер","Квіт","Трав","Черв","Лип","Серп","Вер","Жовт","Лист","Груд"]
    cash_flow: list[CashFlowBucket] = []

    if period == "month":
        week = start
        while week <= end:
            w_end = min(week + timedelta(days=6), end)
            label = f"{week.day}–{w_end.day} {week.strftime('%b')}"
            inflow = outflow = Decimal("0")
            for m in all_mvmts:
                if not (week <= m.created_at.date() <= w_end):
                    continue
                direction = _CF_DIRECTION.get(m.type, "ignore")
                if direction == "inflow":
                    inflow  += _cf_value(m)
                elif direction == "outflow":
                    outflow += _cf_value(m)
            cash_flow.append(CashFlowBucket(label=label, inflow=inflow, outflow=outflow))
            week = w_end + timedelta(days=1)
    else:
        buckets: dict[str, tuple[Decimal, Decimal]] = {}
        for m in all_mvmts:
            direction = _CF_DIRECTION.get(m.type, "ignore")
            if direction == "ignore":
                continue
            k = m.created_at.strftime("%Y-%m")
            i, o_val = buckets.get(k, (Decimal("0"), Decimal("0")))
            val = _cf_value(m)
            if direction == "inflow":
                buckets[k] = (i + val, o_val)
            else:
                buckets[k] = (i, o_val + val)
        for k in sorted(buckets):
            mo = int(k[5:])
            i, o_val = buckets[k]
            cash_flow.append(CashFlowBucket(label=month_names[mo - 1], inflow=i, outflow=o_val))

    return WarehouseAnalytics(
        revenue=revenue, cogs=cogs, gross_profit=gross_profit,
        margin_pct=margin_pct.quantize(Decimal("0.1")),
        units_produced=units_produced, units_sold=units_sold,
        defect_rate=defect_rate.quantize(Decimal("0.1")),
        top_products=top_products,
        material_costs=material_costs,
        cash_flow=cash_flow,
    )
