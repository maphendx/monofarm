"""Sales-order lifecycle, reservation, shipment, and payment endpoints."""
from datetime import date
from decimal import Decimal


from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from app.api.ws import broadcast_warehouse
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles, require_warehouse_full
from app.core.db import get_db
from app.models.organization import Organization
from app.models.user import User, UserRole
from app.models.warehouse import (
    CashTransaction, CashTxType, CashTxCategory,
    Counterparty, MovementType, Order, OrderItem, OrderPayment,
    OrderStatus, StockEntry, WarehouseMovement,
    Product,
)
from app.schemas.warehouse import (
    OrderCreate, OrderOut, OrderPaymentCreate, OrderPaymentOut, OrderUpdate,
    ReserveRequest,
    ShipPick, ShipRequest,
)

public_router = APIRouter(tags=["warehouse"])

# All routes that require Starter plan or above (full warehouse access).
# Free plan can only access /products and /categories.
full_router = APIRouter(dependencies=[Depends(require_warehouse_full)])

from app.api.warehouse_modules.common import (_apply_movement, _check_and_auto_replenish, _get_cell, _get_counterparty, _get_product, _get_warehouse, _next_order_number, _order_to_out, _pick_from_cell)
from app.api.warehouse_modules.pagination import DEFAULT_PAGE_SIZE, PageLimit, PageOffset


@full_router.get("/orders", response_model=list[OrderOut])
def list_orders(
    order_status: OrderStatus | None = Query(None),
    counterparty_id: int | None      = Query(None),
    skip: PageOffset = 0,
    limit: PageLimit = DEFAULT_PAGE_SIZE,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[OrderOut]:
    q = db.query(Order).filter(Order.organization_id == org.id)
    if order_status:
        q = q.filter(Order.status == order_status)
    if counterparty_id:
        q = q.filter(Order.counterparty_id == counterparty_id)
    rows = q.order_by(Order.created_at.desc(), Order.id.desc()).offset(skip).limit(limit).all()

    # Bulk-load items, products and counterparties to avoid N+1 per order.
    order_ids = [o.id for o in rows]
    items_by_order: dict[int, list[OrderItem]] = {}
    if order_ids:
        for it in db.query(OrderItem).filter(OrderItem.order_id.in_(order_ids)).order_by(OrderItem.id).all():
            items_by_order.setdefault(it.order_id, []).append(it)

    product_ids = {it.product_id for order_items in items_by_order.values() for it in order_items}
    product_map = {
        p.id: p for p in db.query(Product).filter(Product.organization_id == org.id, Product.id.in_(product_ids)).all()
    } if product_ids else {}

    cp_ids = {o.counterparty_id for o in rows if o.counterparty_id}
    cp_map = {
        c.id: c for c in db.query(Counterparty).filter(Counterparty.organization_id == org.id, Counterparty.id.in_(cp_ids)).all()
    } if cp_ids else {}

    return [
        _order_to_out(o, db, items=items_by_order.get(o.id, []),
                      product_map=product_map, cp_map=cp_map)
        for o in rows
    ]


@full_router.post("/orders", response_model=OrderOut, status_code=status.HTTP_201_CREATED)
def create_order(
    payload: OrderCreate,
    bg:   BackgroundTasks,
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
        if it.warehouse_id is not None:
            _get_warehouse(it.warehouse_id, org, db)
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
    bg.add_task(broadcast_warehouse, org.id, "orders")
    return _order_to_out(o, db)


@full_router.get("/orders/{order_id}", response_model=OrderOut)
def get_order(
    order_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> OrderOut:
    o = db.query(Order).filter_by(id=order_id, organization_id=org.id).first()
    if not o:
        raise HTTPException(status_code=404, detail="Order not found")
    return _order_to_out(o, db)


@full_router.patch("/orders/{order_id}", response_model=OrderOut)
def update_order(
    order_id: int,
    payload:  OrderUpdate,
    bg:  BackgroundTasks,
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
    bg.add_task(broadcast_warehouse, org.id, "orders")
    return _order_to_out(o, db)


@full_router.post("/orders/{order_id}/reserve", response_model=OrderOut)
def reserve_order(
    order_id: int,
    payload:  ReserveRequest,
    bg:   BackgroundTasks,
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
            .filter_by(organization_id=org.id, product_id=item.product_id, warehouse_id=wh_id)
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

        entry = db.query(StockEntry).filter_by(
            organization_id=org.id,
            product_id=item.product_id,
            warehouse_id=wh_id,
        ).first()
        if entry:
            entry.reserved_qty += item.quantity

        # Record which warehouse this item is reserved from
        item.warehouse_id = wh_id

    o.status = OrderStatus.confirmed
    db.commit()
    db.refresh(o)
    bg.add_task(broadcast_warehouse, org.id, "orders")
    bg.add_task(broadcast_warehouse, org.id, "stock")
    return _order_to_out(o, db)


@full_router.post("/orders/{order_id}/ship", response_model=OrderOut)
def ship_order(
    order_id: int,
    bg:   BackgroundTasks,
    payload: ShipRequest | None = None,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> OrderOut:
    """Deduct stock, create SALE_OUT movements, update counterparty balance.

    Transitions order: confirmed | ready → shipped.

    Optional `picks` says which cells the goods were physically pulled from, so
    bin counts match reality. Anything not covered by picks falls back to FIFO.
    """
    picks_by_product: dict[int, list[ShipPick]] = {}
    for pk in (payload.picks if payload else []):
        picks_by_product.setdefault(pk.product_id, []).append(pk)
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
            .filter_by(organization_id=org.id, product_id=item.product_id, warehouse_id=item.warehouse_id)
            .with_for_update()
            .first()
        )
        if not entry or entry.quantity < Decimal(item.quantity):
            product = db.get(Product, item.product_id)
            name = product.name if product else f"#{item.product_id}"
            available = entry.quantity if entry else Decimal("0")
            raise HTTPException(
                status_code=422,
                detail=f"Недостатньо товару для відвантаження {name}: потрібно {item.quantity}, доступно {available}",
            )

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
            unit=prod.unit if prod else "шт",
            unit_cost=unit_cost,
            total_cost=(unit_cost * qty) if unit_cost else None,
            unit_price=unit_price,
            total_revenue=(unit_price * qty) if unit_price else None,
            order_id=o.id,
        )
        db.add(m)
        db.flush()
        # Honor operator-specified bins first (no FIFO guessing), then let the
        # clamp draw any remainder FIFO so locations stay within the new total.
        for pk in picks_by_product.get(item.product_id, []):
            cell = _get_cell(pk.cell_id, org, db, warehouse_id=item.warehouse_id)
            _pick_from_cell(cell, item.product_id, pk.quantity, org.id, db,
                            movement_id=m.id, created_by_id=user.id)
        _apply_movement(m, db)
        _check_and_auto_replenish(item.product_id, org.id, db)

    # Update counterparty balance (outstanding debt)
    if o.counterparty_id:
        outstanding = (o.total_amount or Decimal("0")) - (o.paid_amount or Decimal("0"))
        if outstanding > 0:
            cp = db.query(Counterparty).with_for_update().filter_by(
                id=o.counterparty_id,
                organization_id=org.id,
            ).first()
            if cp:
                cp.balance += outstanding

    o.status = OrderStatus.shipped
    db.commit()
    db.refresh(o)
    bg.add_task(broadcast_warehouse, org.id, "orders")
    bg.add_task(broadcast_warehouse, org.id, "stock")
    bg.add_task(broadcast_warehouse, org.id, "movements")
    return _order_to_out(o, db)


@full_router.post("/orders/{order_id}/cancel", response_model=OrderOut)
def cancel_order(
    order_id: int,
    bg:   BackgroundTasks,
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

    # Release reservations for any status that had stock locked (confirmed → ready)
    _RESERVED_STATUSES = {OrderStatus.confirmed, OrderStatus.in_production, OrderStatus.ready}
    if o.status in _RESERVED_STATUSES:
        items = db.query(OrderItem).filter_by(order_id=o.id).all()
        for item in items:
            if item.warehouse_id:
                entry = (
                    db.query(StockEntry)
                    .filter_by(organization_id=org.id, product_id=item.product_id, warehouse_id=item.warehouse_id)
                    .with_for_update()
                    .first()
                )
                if entry:
                    entry.reserved_qty -= min(entry.reserved_qty, Decimal(item.quantity))

    o.status = OrderStatus.cancelled
    db.commit()
    db.refresh(o)
    bg.add_task(broadcast_warehouse, org.id, "orders")
    bg.add_task(broadcast_warehouse, org.id, "stock")
    return _order_to_out(o, db)


# ── Order Payments ────────────────────────────────────────────────────────────

@full_router.post("/orders/{order_id}/payments", response_model=OrderPaymentOut, status_code=status.HTTP_201_CREATED)
def record_payment(
    order_id: int,
    payload:  OrderPaymentCreate,
    bg:   BackgroundTasks,
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
        cp = db.query(Counterparty).with_for_update().filter_by(
            id=o.counterparty_id,
            organization_id=org.id,
        ).first()
        if cp:
            cp.balance -= payload.amount

    db.commit()
    db.refresh(payment)
    bg.add_task(broadcast_warehouse, org.id, "orders")
    bg.add_task(broadcast_warehouse, org.id, "cashflow")
    return OrderPaymentOut.model_validate(payment)


@full_router.get("/orders/{order_id}/payments", response_model=list[OrderPaymentOut])
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


@full_router.delete("/orders/{order_id}/payments/{payment_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_payment(
    order_id:   int,
    payment_id: int,
    bg:   BackgroundTasks,
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
        tx = db.query(CashTransaction).filter_by(id=p.cashflow_id, organization_id=org.id).first()
        if tx:
            db.delete(tx)

    db.delete(p)
    db.flush()

    # Recalculate paid_amount from remaining payments
    from sqlalchemy import select, func as safunc
    new_paid = db.execute(
        select(safunc.coalesce(safunc.sum(OrderPayment.amount), Decimal("0")))
        .where(OrderPayment.organization_id == org.id, OrderPayment.order_id == order_id)
    ).scalar_one()
    o.paid_amount = new_paid

    # Restore counterparty debt
    if o.counterparty_id:
        cp = db.query(Counterparty).with_for_update().filter_by(
            id=o.counterparty_id,
            organization_id=org.id,
        ).first()
        if cp:
            cp.balance += amount

    db.commit()
    bg.add_task(broadcast_warehouse, org.id, "orders")
    bg.add_task(broadcast_warehouse, org.id, "cashflow")
