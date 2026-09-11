"""Purchase-order receiving and point-of-sale endpoints."""
from datetime import date, datetime
from decimal import Decimal


from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from app.api.ws import broadcast_warehouse
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles, require_warehouse_full
from app.core.db import get_db
from app.models.organization import Organization
from app.models.user import User, UserRole
from app.models.warehouse import (
    BankAccount, BankAccountStatus,
    CashTransaction, CashTxType, CashTxCategory,
    Counterparty, MovementType, StockEntry, Warehouse, WarehouseMovement,
    Product,
    PurchaseOrder, PurchaseOrderItem, PurchaseOrderStatus,
)
from app.schemas.warehouse import (
    CashRegisterReceipt, CashRegisterReceiptItem, CashRegisterSell, PurchaseOrderCreate, PurchaseOrderItemOut, PurchaseOrderOut,
)

public_router = APIRouter(tags=["warehouse"])

# All routes that require Starter plan or above (full warehouse access).
# Free plan can only access /products and /categories.
full_router = APIRouter(dependencies=[Depends(require_warehouse_full)])

from app.api.warehouse_modules.common import (_apply_movement, _check_and_auto_replenish, _product_image_url)
from app.api.warehouse_modules.pagination import DEFAULT_PAGE_SIZE, PageLimit, PageOffset


@full_router.get("/cashregister/products")
def cashregister_products(
    q:            str | None = Query(None),
    warehouse_id: int | None = Query(None),
    page:         int        = Query(1, ge=1),
    limit:        int        = Query(30, le=100),
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> dict:
    query = (
        db.query(Product)
        .filter(Product.organization_id == org.id, Product.is_active.is_(True))
    )
    if q:
        term = f"%{q.strip()}%"
        query = query.filter(
            or_(
                Product.name.ilike(term),
                Product.sku.ilike(term),
                Product.barcode.ilike(term),
            )
        )
    total = query.count()
    products = query.order_by(Product.name).offset((page - 1) * limit).limit(limit).all()

    # Fetch stock per product for requested warehouse (or sum across all)
    stock_map: dict[int, Decimal] = {}
    if warehouse_id:
        entries = (
            db.query(StockEntry.product_id, StockEntry.quantity)
            .filter(
                StockEntry.organization_id == org.id,
                StockEntry.warehouse_id == warehouse_id,
                StockEntry.product_id.in_([p.id for p in products]),
            )
            .all()
        )
        stock_map = {pid: qty for pid, qty in entries}
    else:
        from sqlalchemy import func as sqlfunc
        entries = (
            db.query(StockEntry.product_id, sqlfunc.sum(StockEntry.quantity))
            .filter(
                StockEntry.organization_id == org.id,
                StockEntry.product_id.in_([p.id for p in products]),
            )
            .group_by(StockEntry.product_id)
            .all()
        )
        stock_map = {pid: qty for pid, qty in entries}

    items = [
        {
            "id":         p.id,
            "name":       p.name,
            "sku":        p.sku,
            "barcode":    p.barcode,
            "sale_price": p.sale_price,
            "unit":       p.unit,
            "image_url":  _product_image_url(p, org.id),
            "stock_qty":  float(stock_map.get(p.id, Decimal("0"))),
        }
        for p in products
    ]
    return {"total": total, "items": items}


@full_router.post("/cashregister/sell", response_model=CashRegisterReceipt, status_code=status.HTTP_201_CREATED)
def cashregister_sell(
    payload: CashRegisterSell,
    bg:   BackgroundTasks,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> CashRegisterReceipt:
    if not payload.items:
        raise HTTPException(status_code=422, detail="Кошик порожній")

    wh = db.query(Warehouse).filter_by(id=payload.warehouse_id, organization_id=org.id).first()
    if not wh:
        raise HTTPException(status_code=404, detail="Warehouse not found")

    ba: BankAccount | None = None
    if payload.bank_account_id:
        ba = db.query(BankAccount).filter_by(id=payload.bank_account_id, organization_id=org.id).first()
        if not ba:
            raise HTTPException(status_code=404, detail="Bank account not found")
        if ba.status == BankAccountStatus.closed:
            raise HTTPException(status_code=422, detail="Рахунок закритий")

    receipt_items = []
    total = Decimal("0")

    for item in payload.items:
        product = db.query(Product).filter_by(id=item.product_id, organization_id=org.id).first()
        if not product:
            raise HTTPException(status_code=404, detail=f"Product {item.product_id} not found")

        line_total = (item.qty * item.unit_price).quantize(Decimal("0.01"))
        total += line_total

        movement = WarehouseMovement(
            organization_id=org.id,
            type=MovementType.SALE_OUT,
            product_id=item.product_id,
            warehouse_from_id=payload.warehouse_id,
            quantity=item.qty,
            unit=product.unit,
            unit_price=item.unit_price,
            total_revenue=line_total,
            reason=payload.note or "Каса",
            created_by_id=user.id,
        )
        db.add(movement)
        db.flush()
        _apply_movement(movement, db)
        _check_and_auto_replenish(item.product_id, org.id, db)

        receipt_items.append({
            "product_id":   product.id,
            "product_name": product.name,
            "qty":          item.qty,
            "unit_price":   item.unit_price,
            "total":        line_total,
        })

    # Create cash transaction
    tx = CashTransaction(
        organization_id=org.id,
        type=CashTxType.income,
        category=CashTxCategory.order_payment,
        amount=total,
        bank_account_id=payload.bank_account_id,
        description=payload.note or "Каса",
        transaction_date=date.today(),
        created_by_id=user.id,
    )
    db.add(tx)
    db.flush()

    # Update bank account balance
    if ba is not None:
        ba.balance += total

    created_at = datetime.now()
    db.commit()

    bg.add_task(broadcast_warehouse, org.id, "cashflow")
    bg.add_task(broadcast_warehouse, org.id, "movements")
    bg.add_task(broadcast_warehouse, org.id, "stock")

    return CashRegisterReceipt(
        total=total,
        items=[CashRegisterReceiptItem(**item) for item in receipt_items],
        cash_tx_id=tx.id,
        created_at=created_at,
    )


# ── Purchase Orders ───────────────────────────────────────────────────────────

def _po_to_out(po: PurchaseOrder, product_map: dict, cp_map: dict, wh_map: dict) -> PurchaseOrderOut:
    from decimal import Decimal
    items_out = []
    total = Decimal("0")
    for it in po.items:
        p = product_map.get(it.product_id)
        line_total = it.quantity * it.unit_cost
        total += line_total
        items_out.append(PurchaseOrderItemOut(
            id=it.id,
            product_id=it.product_id,
            product_name=p.name if p else str(it.product_id),
            quantity=it.quantity,
            unit_cost=it.unit_cost,
            total_cost=line_total,
        ))
    cp = cp_map.get(po.counterparty_id) if po.counterparty_id else None
    wh = wh_map.get(po.warehouse_id) if po.warehouse_id else None
    return PurchaseOrderOut(
        id=po.id,
        counterparty_id=po.counterparty_id,
        counterparty_name=cp.name if cp else None,
        warehouse_id=po.warehouse_id,
        warehouse_name=wh.name if wh else None,
        status=po.status.value,
        notes=po.notes,
        total_cost=total,
        items=items_out,
        received_at=po.received_at,
        created_at=po.created_at,
    )


def _po_lookup_maps(po: PurchaseOrder, org_id: int, db: Session) -> tuple[dict[int, Product], dict[int, Counterparty], dict[int, Warehouse]]:
    product_ids = {it.product_id for it in po.items}
    product_map = {
        p.id: p
        for p in db.query(Product).filter(Product.organization_id == org_id, Product.id.in_(product_ids)).all()
    } if product_ids else {}
    cp_map = {}
    if po.counterparty_id:
        cp = db.query(Counterparty).filter_by(id=po.counterparty_id, organization_id=org_id).first()
        cp_map = {cp.id: cp} if cp else {}
    wh_map = {}
    if po.warehouse_id:
        wh = db.query(Warehouse).filter_by(id=po.warehouse_id, organization_id=org_id).first()
        wh_map = {wh.id: wh} if wh else {}
    return product_map, cp_map, wh_map


@full_router.get("/purchases", response_model=list[PurchaseOrderOut])
def list_purchases(
    po_status: PurchaseOrderStatus | None = Query(None),
    skip: PageOffset = 0,
    limit: PageLimit = DEFAULT_PAGE_SIZE,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[PurchaseOrderOut]:
    q = db.query(PurchaseOrder).filter(PurchaseOrder.organization_id == org.id)
    if po_status:
        q = q.filter(PurchaseOrder.status == po_status)
    rows = (
        q.order_by(PurchaseOrder.created_at.desc(), PurchaseOrder.id.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )

    po_ids = [po.id for po in rows]
    items_by_po: dict[int, list[PurchaseOrderItem]] = {}
    if po_ids:
        for it in db.query(PurchaseOrderItem).filter(PurchaseOrderItem.purchase_order_id.in_(po_ids)).all():
            items_by_po.setdefault(it.purchase_order_id, []).append(it)
        for po in rows:
            po.items = items_by_po.get(po.id, [])

    product_ids = {it.product_id for po in rows for it in po.items}
    product_map = {p.id: p for p in db.query(Product).filter(
        Product.organization_id == org.id, Product.id.in_(product_ids)
    ).all()} if product_ids else {}

    cp_ids = {po.counterparty_id for po in rows if po.counterparty_id}
    cp_map = {c.id: c for c in db.query(Counterparty).filter(
        Counterparty.organization_id == org.id, Counterparty.id.in_(cp_ids)
    ).all()} if cp_ids else {}

    wh_ids = {po.warehouse_id for po in rows if po.warehouse_id}
    wh_map = {w.id: w for w in db.query(Warehouse).filter(
        Warehouse.organization_id == org.id, Warehouse.id.in_(wh_ids)
    ).all()} if wh_ids else {}

    return [_po_to_out(po, product_map, cp_map, wh_map) for po in rows]


@full_router.post("/purchases", response_model=PurchaseOrderOut, status_code=status.HTTP_201_CREATED)
def create_purchase(
    payload: PurchaseOrderCreate,
    bg:   BackgroundTasks,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> PurchaseOrderOut:
    if payload.counterparty_id:
        cp = db.query(Counterparty).filter_by(organization_id=org.id, id=payload.counterparty_id).first()
        if not cp:
            raise HTTPException(status_code=404, detail="Counterparty not found")
    if payload.warehouse_id:
        wh = db.query(Warehouse).filter_by(organization_id=org.id, id=payload.warehouse_id).first()
        if not wh:
            raise HTTPException(status_code=404, detail="Warehouse not found")

    po = PurchaseOrder(
        organization_id=org.id,
        counterparty_id=payload.counterparty_id,
        warehouse_id=payload.warehouse_id,
        notes=payload.notes,
        status=PurchaseOrderStatus.draft,
        created_by_id=user.id,
    )
    db.add(po)
    db.flush()

    for item in payload.items:
        prod = db.query(Product).filter_by(organization_id=org.id, id=item.product_id).first()
        if not prod:
            raise HTTPException(status_code=404, detail=f"Product {item.product_id} not found")
        db.add(PurchaseOrderItem(
            purchase_order_id=po.id,
            product_id=item.product_id,
            quantity=item.quantity,
            unit_cost=item.unit_cost,
        ))

    db.commit()
    db.refresh(po)

    bg.add_task(broadcast_warehouse, org.id, "purchases")
    product_map, cp_map, wh_map = _po_lookup_maps(po, org.id, db)
    return _po_to_out(po, product_map, cp_map, wh_map)


@full_router.get("/purchases/{po_id}", response_model=PurchaseOrderOut)
def get_purchase(
    po_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> PurchaseOrderOut:
    po = db.query(PurchaseOrder).filter_by(organization_id=org.id, id=po_id).first()
    if not po:
        raise HTTPException(status_code=404, detail="Purchase order not found")

    product_map, cp_map, wh_map = _po_lookup_maps(po, org.id, db)
    return _po_to_out(po, product_map, cp_map, wh_map)


@full_router.post("/purchases/{po_id}/receive", response_model=PurchaseOrderOut)
def receive_purchase(
    po_id: int,
    bg:   BackgroundTasks,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> PurchaseOrderOut:
    po = db.query(PurchaseOrder).filter_by(organization_id=org.id, id=po_id).first()
    if not po:
        raise HTTPException(status_code=404, detail="Purchase order not found")
    if po.status != PurchaseOrderStatus.draft:
        raise HTTPException(status_code=400, detail="Only draft purchase orders can be received")
    if not po.warehouse_id:
        raise HTTPException(status_code=400, detail="Purchase order must have a destination warehouse")
    if not po.items:
        raise HTTPException(status_code=400, detail="Purchase order has no items")

    from datetime import datetime as dt
    for item in po.items:
        mv = WarehouseMovement(
            organization_id=org.id,
            type=MovementType.PURCHASE_IN,
            product_id=item.product_id,
            quantity=item.quantity,
            unit_cost=item.unit_cost,
            warehouse_to_id=po.warehouse_id,
            created_by_id=user.id,
        )
        db.add(mv)
        db.flush()
        _apply_movement(mv, db)

    total_cost = sum(it.quantity * it.unit_cost for it in po.items)
    if po.counterparty_id:
        cp = db.query(Counterparty).filter_by(organization_id=org.id, id=po.counterparty_id).first()
        if cp:
            cp.balance -= total_cost

    po.status = PurchaseOrderStatus.received
    po.received_at = dt.utcnow()
    db.commit()
    db.refresh(po)

    bg.add_task(broadcast_warehouse, org.id, "stock")
    bg.add_task(broadcast_warehouse, org.id, "movements")
    bg.add_task(broadcast_warehouse, org.id, "purchases")
    if po.counterparty_id:
        bg.add_task(broadcast_warehouse, org.id, "counterparties")

    product_map, cp_map, wh_map = _po_lookup_maps(po, org.id, db)
    return _po_to_out(po, product_map, cp_map, wh_map)


@full_router.delete("/purchases/{po_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_purchase(
    po_id: int,
    bg:   BackgroundTasks,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    _user: User        = Depends(require_roles(UserRole.admin)),
) -> None:
    po = db.query(PurchaseOrder).filter_by(organization_id=org.id, id=po_id).first()
    if not po:
        raise HTTPException(status_code=404, detail="Purchase order not found")
    if po.status == PurchaseOrderStatus.received:
        raise HTTPException(status_code=400, detail="Cannot delete a received purchase order")
    db.delete(po)
    db.commit()
    bg.add_task(broadcast_warehouse, org.id, "purchases")
