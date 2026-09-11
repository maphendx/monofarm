"""Warehouse reports, pick lists, reconciliation, and movement reversal."""
from datetime import date, datetime, timedelta
from decimal import Decimal


from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from app.api.ws import broadcast_warehouse
from sqlalchemy import case, func
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles, require_warehouse_full
from app.core.db import get_db
from app.models.organization import Organization
from app.models.user import User, UserRole
from app.models.warehouse import (
    CashTransaction, CashTxType, CellStock, Counterparty, MovementType, Order, OrderItem, OrderPayment,
    StockEntry, Warehouse, WarehouseCell, WarehouseMovement,
    WarehouseZone, Product,
    PurchaseOrder, PurchaseOrderStatus,
)
from app.schemas.warehouse import (
    ScanActionResult, CustomerProfitRow, MarginSeriesPoint, TurnoverRow,
    ReconciliationEntry, ReconciliationOut,
    PickItem, PickListOut, PickLocation,
)

public_router = APIRouter(tags=["warehouse"])

# All routes that require Starter plan or above (full warehouse access).
# Free plan can only access /products and /categories.
full_router = APIRouter(dependencies=[Depends(require_warehouse_full)])

from app.api.warehouse_modules.common import (_apply_movement, _lock_stock_row, _product_image_url)

_REVERSE_IN = {
    MovementType.PURCHASE_IN,
    MovementType.PRODUCTION_IN,
    MovementType.RETURN_IN,
}
_REVERSE_OUT = {MovementType.SALE_OUT, MovementType.PRODUCTION_OUT,
                MovementType.WRITE_OFF, MovementType.DEFECT}


@full_router.post("/movements/{movement_id}/reverse", response_model=ScanActionResult)
def reverse_movement(
    movement_id: int,
    bg:   BackgroundTasks,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> ScanActionResult:
    """Сторно: компенсуючий рух у зворотному напрямку (помилковий скан)."""
    m = db.query(WarehouseMovement).filter_by(id=movement_id, organization_id=org.id).first()
    if not m:
        raise HTTPException(status_code=404, detail="Рух не знайдено")
    marker = f"Сторно руху №{m.id}"
    already = db.query(WarehouseMovement).filter_by(
        organization_id=org.id, reason=marker).first()
    if already:
        raise HTTPException(status_code=400, detail="Цей рух уже сторновано")
    if m.reason and m.reason.startswith("Сторно руху"):
        raise HTTPException(status_code=400, detail="Не можна сторнувати сторно")

    if m.type in _REVERSE_IN or (m.type == MovementType.ADJUSTMENT and m.warehouse_to_id):
        wh_id = m.warehouse_to_id
        rev = WarehouseMovement(
            organization_id=org.id, type=MovementType.ADJUSTMENT,
            product_id=m.product_id, warehouse_from_id=wh_id,
            quantity=m.quantity, reason=marker, created_by_id=user.id)
    elif m.type in _REVERSE_OUT or (m.type == MovementType.ADJUSTMENT and m.warehouse_from_id):
        wh_id = m.warehouse_from_id
        rev = WarehouseMovement(
            organization_id=org.id, type=MovementType.ADJUSTMENT,
            product_id=m.product_id, warehouse_to_id=wh_id,
            quantity=m.quantity, reason=marker, created_by_id=user.id)
    elif m.type == MovementType.TRANSFER and m.warehouse_from_id and m.warehouse_to_id:
        rev = WarehouseMovement(
            organization_id=org.id, type=MovementType.TRANSFER,
            product_id=m.product_id,
            warehouse_from_id=m.warehouse_to_id, warehouse_to_id=m.warehouse_from_id,
            quantity=m.quantity, reason=marker, created_by_id=user.id)
    else:
        raise HTTPException(status_code=400, detail="Цей тип руху не підтримує сторно")

    for wid in {rev.warehouse_from_id, rev.warehouse_to_id}:
        if wid:
            _lock_stock_row(m.product_id, wid, org.id, db)
    db.add(rev)
    db.flush()
    _apply_movement(rev, db)
    db.commit()
    bg.add_task(broadcast_warehouse, org.id, "stock")
    return ScanActionResult(message=f"↩ {marker}: {m.quantity} повернуто", movement_id=rev.id)


# ── Pick list (збірка замовлення) ─────────────────────────────────────────────

@full_router.get("/orders/{order_id}/pick-list", response_model=PickListOut)
def order_pick_list(
    order_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> PickListOut:
    """Де фізично лежить кожна позиція замовлення: комірки + кількості."""
    order = db.query(Order).filter_by(id=order_id, organization_id=org.id).first()
    if not order:
        raise HTTPException(status_code=404, detail="Замовлення не знайдено")
    items = db.query(OrderItem).filter_by(order_id=order.id).all()
    pids = [i.product_id for i in items]
    products = {p.id: p for p in db.query(Product).filter(
        Product.organization_id == org.id, Product.id.in_(pids)).all()} if pids else {}

    # All cell allocations for these products in one query.
    loc_rows = (
        db.query(CellStock, WarehouseCell, WarehouseZone, Warehouse)
        .join(WarehouseCell, WarehouseCell.id == CellStock.cell_id)
        .join(WarehouseZone, WarehouseZone.id == WarehouseCell.zone_id)
        .join(Warehouse, Warehouse.id == WarehouseZone.warehouse_id)
        .filter(Warehouse.organization_id == org.id,
                CellStock.product_id.in_(pids),
                CellStock.quantity > 0)
        .order_by(Warehouse.name, WarehouseCell.code)
        .all()
    ) if pids else []
    locs: dict[int, list[PickLocation]] = {}
    for cs, cell, zone, wh in loc_rows:
        locs.setdefault(cs.product_id, []).append(PickLocation(
            warehouse_name=wh.name, zone_name=zone.name,
            cell_code=cell.code, quantity=cs.quantity))

    avail = dict(
        db.query(StockEntry.product_id, func.sum(StockEntry.quantity))
        .filter(StockEntry.organization_id == org.id, StockEntry.product_id.in_(pids))
        .group_by(StockEntry.product_id)
        .all()
    ) if pids else {}

    out_items = []
    for it in items:
        p = products.get(it.product_id)
        if not p:
            continue
        out_items.append(PickItem(
            product_id=p.id, product_name=p.name, sku=p.sku, barcode=p.barcode,
            image_url=_product_image_url(p, org.id),
            qty_needed=it.quantity, available=avail.get(p.id) or Decimal("0"),
            locations=locs.get(p.id, []),
        ))
    return PickListOut(order_id=order.id, order_number=order.order_number, items=out_items)


# ── Reconciliation act (акт звірки) ───────────────────────────────────────────

@full_router.get("/counterparties/{cp_id}/reconciliation", response_model=ReconciliationOut)
def counterparty_reconciliation(
    cp_id: int,
    date_from: date | None = None,
    date_to:   date | None = None,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> ReconciliationOut:
    """Акт звірки: документи за період + сальдо.

    Debit — відвантаження (борг контрагента росте), credit — оплати й
    отримані поставки. Closing = поточний баланс; opening відновлюється
    як closing мінус чистий рух за період.
    """
    cp = db.query(Counterparty).filter_by(id=cp_id, organization_id=org.id).first()
    if not cp:
        raise HTTPException(status_code=404, detail="Контрагента не знайдено")
    d_to = date_to or date.today()
    d_from = date_from or (d_to - timedelta(days=90))
    if d_from > d_to:
        raise HTTPException(status_code=400, detail="date_from пізніше за date_to")
    start_dt = datetime.combine(d_from, datetime.min.time())
    end_dt = datetime.combine(d_to + timedelta(days=1), datetime.min.time())

    entries: list[ReconciliationEntry] = []

    # Відвантаження: перший SALE_OUT рух кожного замовлення = дата відвантаження.
    ship_dates = dict(
        db.query(WarehouseMovement.order_id, func.min(WarehouseMovement.created_at))
        .join(Order, Order.id == WarehouseMovement.order_id)
        .filter(WarehouseMovement.organization_id == org.id,
                WarehouseMovement.type == MovementType.SALE_OUT,
                Order.counterparty_id == cp.id)
        .group_by(WarehouseMovement.order_id)
        .all()
    )
    orders = {o.id: o for o in db.query(Order).filter(
        Order.organization_id == org.id, Order.id.in_(ship_dates.keys())).all()} if ship_dates else {}
    for oid, shipped_at in ship_dates.items():
        if not (start_dt <= shipped_at < end_dt):
            continue
        o = orders.get(oid)
        if o and o.total_amount:
            entries.append(ReconciliationEntry(
                doc_date=shipped_at.date(), doc=f"Відвантаження {o.order_number}",
                debit=o.total_amount))

    # Оплати замовлень.
    pay_rows = (
        db.query(OrderPayment, Order)
        .join(Order, Order.id == OrderPayment.order_id)
        .filter(OrderPayment.organization_id == org.id,
                Order.counterparty_id == cp.id,
                OrderPayment.paid_at >= d_from, OrderPayment.paid_at <= d_to)
        .all()
    )
    for p, o in pay_rows:
        entries.append(ReconciliationEntry(
            doc_date=p.paid_at, doc=f"Оплата {o.order_number}", credit=p.amount))

    # Отримані поставки (для постачальників).
    po_rows = (
        db.query(PurchaseOrder)
        .filter(PurchaseOrder.organization_id == org.id,
                PurchaseOrder.counterparty_id == cp.id,
                PurchaseOrder.status == PurchaseOrderStatus.received,
                PurchaseOrder.received_at >= start_dt, PurchaseOrder.received_at < end_dt)
        .all()
    )
    for po in po_rows:
        total = sum((i.quantity * i.unit_cost for i in po.items), Decimal("0"))
        if total:
            entries.append(ReconciliationEntry(
                doc_date=po.received_at.date(), doc=f"Поставка №{po.id}", credit=total))

    # Ручні касові операції по контрагенту (без замовлення — оплати замовлень уже враховано).
    cash_rows = (
        db.query(CashTransaction)
        .filter(CashTransaction.organization_id == org.id,
                CashTransaction.counterparty_id == cp.id,
                CashTransaction.order_id.is_(None),
                CashTransaction.transaction_date >= d_from,
                CashTransaction.transaction_date <= d_to)
        .all()
    )
    for tx in cash_rows:
        label = tx.description or ("Оплата від контрагента" if tx.type == CashTxType.income else "Виплата контрагенту")
        if tx.type == CashTxType.income:
            entries.append(ReconciliationEntry(doc_date=tx.transaction_date, doc=label, credit=tx.amount))
        else:
            entries.append(ReconciliationEntry(doc_date=tx.transaction_date, doc=label, debit=tx.amount))

    entries.sort(key=lambda e: e.doc_date)
    debit_total = sum((e.debit for e in entries), Decimal("0"))
    credit_total = sum((e.credit for e in entries), Decimal("0"))
    closing = cp.balance or Decimal("0")
    opening = closing - (debit_total - credit_total)
    return ReconciliationOut(
        counterparty_id=cp.id, name=cp.name, date_from=d_from, date_to=d_to,
        opening_balance=opening.quantize(Decimal("0.01")),
        debit_total=debit_total.quantize(Decimal("0.01")),
        credit_total=credit_total.quantize(Decimal("0.01")),
        closing_balance=closing.quantize(Decimal("0.01")),
        entries=entries,
    )


# ── Reports: turnover, customer profitability, margin/stock dynamics ──────────

_QTY_IN  = (MovementType.PURCHASE_IN, MovementType.PRODUCTION_IN, MovementType.RETURN_IN)
_QTY_OUT = (MovementType.SALE_OUT, MovementType.PRODUCTION_OUT,
            MovementType.WRITE_OFF, MovementType.DEFECT)


def _net_qty_expr():
    """Org-level signed quantity of a movement (TRANSFER nets to zero)."""
    return case(
        (WarehouseMovement.type.in_(_QTY_IN), WarehouseMovement.quantity),
        (WarehouseMovement.type.in_(_QTY_OUT), -WarehouseMovement.quantity),
        (WarehouseMovement.type == MovementType.ADJUSTMENT,
         case((WarehouseMovement.warehouse_to_id.isnot(None), WarehouseMovement.quantity),
              else_=-WarehouseMovement.quantity)),
        else_=Decimal("0"),
    )


@full_router.get("/reports/turnover", response_model=list[TurnoverRow])
def report_turnover(
    days: int = Query(90, ge=7, le=365),
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
) -> list[TurnoverRow]:
    """Product turnover: sold qty vs average stock over the window."""
    since = datetime.utcnow() - timedelta(days=days)

    sold = dict()
    revenue = dict()
    rows = (
        db.query(
            WarehouseMovement.product_id,
            func.sum(WarehouseMovement.quantity),
            func.sum(func.coalesce(WarehouseMovement.total_revenue,
                                   WarehouseMovement.quantity * func.coalesce(WarehouseMovement.unit_price, 0))),
        )
        .filter(WarehouseMovement.organization_id == org.id,
                WarehouseMovement.type == MovementType.SALE_OUT,
                WarehouseMovement.created_at >= since)
        .group_by(WarehouseMovement.product_id)
        .all()
    )
    for pid, qty, rev in rows:
        sold[pid] = qty or Decimal("0")
        revenue[pid] = rev or Decimal("0")

    # Net stock change inside the window → start_stock = current − net.
    net = dict(
        db.query(WarehouseMovement.product_id, func.sum(_net_qty_expr()))
        .filter(WarehouseMovement.organization_id == org.id,
                WarehouseMovement.created_at >= since)
        .group_by(WarehouseMovement.product_id)
        .all()
    )
    current = dict(
        db.query(StockEntry.product_id, func.sum(StockEntry.quantity))
        .filter(StockEntry.organization_id == org.id)
        .group_by(StockEntry.product_id)
        .all()
    )

    pids = set(sold) | {pid for pid, q in current.items() if q}
    products = {p.id: p for p in db.query(Product).filter(
        Product.organization_id == org.id, Product.id.in_(pids)).all()} if pids else {}

    out: list[TurnoverRow] = []
    for pid in pids:
        p = products.get(pid)
        if not p:
            continue
        cur = current.get(pid) or Decimal("0")
        start = max(cur - (net.get(pid) or Decimal("0")), Decimal("0"))
        avg = (start + cur) / 2
        s = sold.get(pid, Decimal("0"))
        cost = p.cost_price or Decimal("0")
        turnover = (s / avg).quantize(Decimal("0.01")) if avg > 0 else None
        days_of_stock = (cur / (s / days)).quantize(Decimal("0.1")) if s > 0 else None
        out.append(TurnoverRow(
            product_id=pid, product_name=p.name, sku=p.sku,
            sold_qty=s, revenue=revenue.get(pid, Decimal("0")),
            cogs=(s * cost).quantize(Decimal("0.01")),
            current_stock=cur, avg_stock=avg.quantize(Decimal("0.01")),
            turnover=turnover, days_of_stock=days_of_stock,
        ))
    out.sort(key=lambda r: r.sold_qty, reverse=True)
    return out


@full_router.get("/reports/customers", response_model=list[CustomerProfitRow])
def report_customers(
    days: int = Query(90, ge=7, le=365),
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
) -> list[CustomerProfitRow]:
    """Profitability per customer from shipped SALE_OUT movements; POS sales grouped separately."""
    since = datetime.utcnow() - timedelta(days=days)
    rows = (
        db.query(WarehouseMovement, Order, Product)
        .outerjoin(Order, Order.id == WarehouseMovement.order_id)
        .join(Product, Product.id == WarehouseMovement.product_id)
        .filter(WarehouseMovement.organization_id == org.id,
                WarehouseMovement.type == MovementType.SALE_OUT,
                WarehouseMovement.created_at >= since)
        .all()
    )
    cp_names = {c.id: c.name for c in db.query(Counterparty).filter_by(organization_id=org.id).all()}

    acc: dict[object, dict] = {}
    for m, o, p in rows:
        if o and o.counterparty_id:
            key: object = ("cp", o.counterparty_id)
            name = cp_names.get(o.counterparty_id, f"Контрагент #{o.counterparty_id}")
        elif o and o.customer_name:
            key = ("name", o.customer_name)
            name = o.customer_name
        else:
            key = ("pos", None)
            name = "Роздріб (POS / скан)"
        a = acc.setdefault(key, {"name": name, "orders": set(), "revenue": Decimal("0"), "cogs": Decimal("0"),
                                 "cp_id": o.counterparty_id if o else None})
        if o:
            a["orders"].add(o.id)
        rev = m.total_revenue if m.total_revenue is not None else (m.quantity * (m.unit_price or Decimal("0")))
        a["revenue"] += rev or Decimal("0")
        a["cogs"] += m.quantity * (p.cost_price or Decimal("0"))

    out: list[CustomerProfitRow] = []
    for a in acc.values():
        margin = a["revenue"] - a["cogs"]
        pct = (margin / a["revenue"] * 100).quantize(Decimal("0.1")) if a["revenue"] else None
        out.append(CustomerProfitRow(
            counterparty_id=a["cp_id"], name=a["name"], orders=len(a["orders"]),
            revenue=a["revenue"].quantize(Decimal("0.01")),
            cogs=a["cogs"].quantize(Decimal("0.01")),
            margin=margin.quantize(Decimal("0.01")), margin_pct=pct,
        ))
    out.sort(key=lambda r: r.margin, reverse=True)
    return out


@full_router.get("/reports/margin-series", response_model=list[MarginSeriesPoint])
def report_margin_series(
    days: int = Query(90, ge=7, le=365),
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
) -> list[MarginSeriesPoint]:
    """Daily revenue/COGS/margin + reconstructed stock value (динаміка запасу)."""
    since_day = date.today() - timedelta(days=days - 1)
    since = datetime.combine(since_day, datetime.min.time())
    day_expr = func.date(WarehouseMovement.created_at)

    sales = {
        d: (rev or Decimal("0"), qty or Decimal("0"))
        for d, rev, qty in db.query(
            day_expr,
            func.sum(func.coalesce(WarehouseMovement.total_revenue,
                                   WarehouseMovement.quantity * func.coalesce(WarehouseMovement.unit_price, 0))),
            func.sum(WarehouseMovement.quantity),
        )
        .filter(WarehouseMovement.organization_id == org.id,
                WarehouseMovement.type == MovementType.SALE_OUT,
                WarehouseMovement.created_at >= since)
        .group_by(day_expr)
        .all()
    }
    # COGS per day at current AVCO cost.
    cost_by_product = {p.id: (p.cost_price or Decimal("0")) for p in
                       db.query(Product).filter_by(organization_id=org.id).all()}
    cogs_rows = (
        db.query(day_expr, WarehouseMovement.product_id, func.sum(WarehouseMovement.quantity))
        .filter(WarehouseMovement.organization_id == org.id,
                WarehouseMovement.type == MovementType.SALE_OUT,
                WarehouseMovement.created_at >= since)
        .group_by(day_expr, WarehouseMovement.product_id)
        .all()
    )
    cogs: dict[date, Decimal] = {}
    for d, pid, qty in cogs_rows:
        cogs[d] = cogs.get(d, Decimal("0")) + (qty or Decimal("0")) * cost_by_product.get(pid, Decimal("0"))

    # Stock value: walk backwards from today's value using daily net qty changes.
    current_value = Decimal("0")
    for pid, qty in db.query(StockEntry.product_id, func.sum(StockEntry.quantity)) \
            .filter(StockEntry.organization_id == org.id).group_by(StockEntry.product_id).all():
        current_value += (qty or Decimal("0")) * cost_by_product.get(pid, Decimal("0"))

    net_by_day: dict[date, Decimal] = {}
    for d, pid, q in (
        db.query(day_expr, WarehouseMovement.product_id, func.sum(_net_qty_expr()))
        .filter(WarehouseMovement.organization_id == org.id,
                WarehouseMovement.created_at >= since)
        .group_by(day_expr, WarehouseMovement.product_id)
        .all()
    ):
        net_by_day[d] = net_by_day.get(d, Decimal("0")) + (q or Decimal("0")) * cost_by_product.get(pid, Decimal("0"))

    out: list[MarginSeriesPoint] = []
    value = current_value
    today = date.today()
    for i in range(days):
        d = today - timedelta(days=i)
        rev = sales.get(d, (Decimal("0"), Decimal("0")))[0]
        c = cogs.get(d, Decimal("0"))
        out.append(MarginSeriesPoint(
            day=d, revenue=rev.quantize(Decimal("0.01")), cogs=c.quantize(Decimal("0.01")),
            margin=(rev - c).quantize(Decimal("0.01")),
            stock_value=max(value, Decimal("0")).quantize(Decimal("0.01")),
        ))
        value -= net_by_day.get(d, Decimal("0"))
    out.reverse()
    return out

