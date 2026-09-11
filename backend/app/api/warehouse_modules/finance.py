"""Cash-flow and warehouse analytics endpoints."""
from datetime import date, datetime, timedelta
from decimal import Decimal


from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from app.api.ws import broadcast_warehouse
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles, require_warehouse_full
from app.core.db import get_db
from app.models.organization import Organization
from app.models.user import User, UserRole
from app.models.warehouse import (
    BankAccount, BatchStatus, CashTransaction, CashTxType, Counterparty, MovementType, Order, ProductionBatch, WarehouseMovement,
    Product,
)
from app.schemas.warehouse import (
    CashFlowBucket, CashFlowSummary, CashTxCreate, CashTxOut, MaterialCost,
    TopProduct, WarehouseAnalytics,
)

public_router = APIRouter(tags=["warehouse"])

# All routes that require Starter plan or above (full warehouse access).
# Free plan can only access /products and /categories.
full_router = APIRouter(dependencies=[Depends(require_warehouse_full)])

from app.api.warehouse_modules.common import (_get_counterparty)
from app.api.warehouse_modules.pagination import DEFAULT_PAGE_SIZE, PageLimit, PageOffset


def _tx_to_out(tx: CashTransaction, db: Session) -> CashTxOut:
    cp_map = {}
    order_map = {}
    bank_map = {}
    if tx.counterparty_id:
        cp = db.get(Counterparty, tx.counterparty_id)
        cp_map = {cp.id: cp.name} if cp else {}
    if tx.order_id:
        order = db.get(Order, tx.order_id)
        order_map = {order.id: order.order_number} if order else {}
    if tx.bank_account_id:
        bank = db.get(BankAccount, tx.bank_account_id)
        bank_map = {bank.id: bank.name} if bank else {}
    return _tx_to_out_from_maps(tx, cp_map=cp_map, order_map=order_map, bank_map=bank_map)


def _tx_to_out_from_maps(
    tx: CashTransaction,
    *,
    cp_map: dict[int, str],
    order_map: dict[int, str],
    bank_map: dict[int, str],
) -> CashTxOut:
    return CashTxOut(
        id=tx.id,
        type=tx.type,
        category=tx.category,
        amount=tx.amount,
        counterparty_id=tx.counterparty_id,
        counterparty_name=cp_map.get(tx.counterparty_id) if tx.counterparty_id else None,
        order_id=tx.order_id,
        order_number=order_map.get(tx.order_id) if tx.order_id else None,
        bank_account_id=tx.bank_account_id,
        bank_account_name=bank_map.get(tx.bank_account_id) if tx.bank_account_id else None,
        description=tx.description,
        transaction_date=tx.transaction_date,
        created_at=tx.created_at,
    )


@full_router.get("/cashflow", response_model=list[CashTxOut])
def list_cashflow(
    tx_type:    str | None = Query(None, alias="type"),
    date_from:  date | None = Query(None),
    date_to:    date | None = Query(None),
    counterparty_id: int | None = Query(None),
    skip: PageOffset = 0,
    limit: PageLimit = DEFAULT_PAGE_SIZE,
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
    rows = (
        q.order_by(CashTransaction.transaction_date.desc(), CashTransaction.id.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )

    cp_ids = {tx.counterparty_id for tx in rows if tx.counterparty_id}
    order_ids = {tx.order_id for tx in rows if tx.order_id}
    bank_ids = {tx.bank_account_id for tx in rows if tx.bank_account_id}
    cp_map = {
        c.id: c.name
        for c in db.query(Counterparty).filter(Counterparty.organization_id == org.id, Counterparty.id.in_(cp_ids)).all()
    } if cp_ids else {}
    order_map = {
        o.id: o.order_number
        for o in db.query(Order).filter(Order.organization_id == org.id, Order.id.in_(order_ids)).all()
    } if order_ids else {}
    bank_map = {
        b.id: b.name
        for b in db.query(BankAccount).filter(BankAccount.organization_id == org.id, BankAccount.id.in_(bank_ids)).all()
    } if bank_ids else {}
    return [
        _tx_to_out_from_maps(tx, cp_map=cp_map, order_map=order_map, bank_map=bank_map)
        for tx in rows
    ]


@full_router.post("/cashflow", response_model=CashTxOut, status_code=status.HTTP_201_CREATED)
def create_cash_tx(
    payload: CashTxCreate,
    bg:   BackgroundTasks,
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
    bg.add_task(broadcast_warehouse, org.id, "cashflow")
    return _tx_to_out(tx, db)


@full_router.delete("/cashflow/{tx_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_cash_tx(
    tx_id: int,
    bg:  BackgroundTasks,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin)),
) -> None:
    tx = db.query(CashTransaction).filter_by(id=tx_id, organization_id=org.id).first()
    if not tx:
        raise HTTPException(status_code=404, detail="Transaction not found")
    db.delete(tx)
    db.commit()
    bg.add_task(broadcast_warehouse, org.id, "cashflow")


@full_router.get("/cashflow/summary", response_model=CashFlowSummary)
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

    grouped = (
        q.with_entities(CashTransaction.category, CashTransaction.type, func.sum(CashTransaction.amount))
        .group_by(CashTransaction.category, CashTransaction.type)
        .all()
    )
    total_income = sum((amount or Decimal("0")) for _, tx_type, amount in grouped if tx_type == CashTxType.income)
    total_expense = sum((amount or Decimal("0")) for _, tx_type, amount in grouped if tx_type == CashTxType.expense)

    by_category = [
        {"category": category.value, "type": tx_type.value, "total": float(amount or Decimal("0"))}
        for category, tx_type, amount in sorted(grouped, key=lambda row: row[2] or Decimal("0"), reverse=True)
    ]

    return CashFlowSummary(
        total_income=total_income,
        total_expense=total_expense,
        net=total_income - total_expense,
        by_category=by_category,
    )


# ── Analytics ─────────────────────────────────────────────────────────────────

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


@full_router.get("/analytics", response_model=WarehouseAnalytics)
def get_analytics(
    period: str          = Query("month", pattern="^(month|quarter|year)$"),
    db:     Session      = Depends(get_db),
    org:    Organization = Depends(get_current_org),
) -> WarehouseAnalytics:
    start, end = _period_range(period)
    start_dt = datetime.combine(start, datetime.min.time())
    end_dt = datetime.combine(end + timedelta(days=1), datetime.min.time())

    money_zero = Decimal("0")
    revenue_expr = func.coalesce(WarehouseMovement.total_revenue, WarehouseMovement.total_cost, money_zero)
    cost_expr = func.coalesce(WarehouseMovement.total_cost, money_zero)

    sales_rows = (
        db.query(
            WarehouseMovement.product_id,
            func.sum(WarehouseMovement.quantity).label("units"),
            func.sum(revenue_expr).label("revenue"),
            func.sum(cost_expr).label("cogs"),
        )
        .filter(
            WarehouseMovement.organization_id == org.id,
            WarehouseMovement.type == MovementType.SALE_OUT,
            WarehouseMovement.created_at >= start_dt,
            WarehouseMovement.created_at < end_dt,
        )
        .group_by(WarehouseMovement.product_id)
        .all()
    )

    revenue = sum((row.revenue or money_zero) for row in sales_rows)
    cogs = sum((row.cogs or money_zero) for row in sales_rows)
    gross_profit = revenue - cogs
    margin_pct   = (gross_profit / revenue * 100) if revenue > 0 else Decimal("0")

    produced_good, produced_defect = (
        db.query(
            func.coalesce(func.sum(ProductionBatch.good_qty), 0),
            func.coalesce(func.sum(ProductionBatch.defect_qty), 0),
        )
        .filter(
            ProductionBatch.organization_id == org.id,
            ProductionBatch.status == BatchStatus.done,
            ProductionBatch.updated_at >= start_dt,
            ProductionBatch.updated_at < end_dt,
        )
        .one()
    )
    units_produced = int(produced_good or 0)
    total_printed = int((produced_good or 0) + (produced_defect or 0))
    units_sold = int(sum((row.units or 0) for row in sales_rows))
    defect_rate    = (
        Decimal(produced_defect or 0) / Decimal(total_printed) * 100
        if total_printed > 0 else Decimal("0")
    )

    top_sales = sorted(sales_rows, key=lambda row: row.revenue or money_zero, reverse=True)[:5]
    top_product_ids = {row.product_id for row in top_sales}
    product_names = {
        p.id: p.name
        for p in db.query(Product).filter(Product.organization_id == org.id, Product.id.in_(top_product_ids)).all()
    } if top_product_ids else {}

    top_products = [
        TopProduct(
            product_id=row.product_id,
            product_name=product_names.get(row.product_id, f"#{row.product_id}"),
            revenue=row.revenue or money_zero,
            units=int(row.units or 0),
        )
        for row in top_sales
    ]

    purchase_rows = (
        db.query(
            WarehouseMovement.product_id,
            func.sum(cost_expr).label("cost"),
        )
        .filter(
            WarehouseMovement.organization_id == org.id,
            WarehouseMovement.type == MovementType.PURCHASE_IN,
            WarehouseMovement.created_at >= start_dt,
            WarehouseMovement.created_at < end_dt,
        )
        .group_by(WarehouseMovement.product_id)
        .order_by(func.sum(cost_expr).desc())
        .limit(5)
        .all()
    )
    material_product_ids = {row.product_id for row in purchase_rows}
    material_names = {
        p.id: p.name
        for p in db.query(Product).filter(Product.organization_id == org.id, Product.id.in_(material_product_ids)).all()
    } if material_product_ids else {}
    material_costs = [
        MaterialCost(name=material_names.get(row.product_id, f"#{row.product_id}"), cost=row.cost or money_zero)
        for row in purchase_rows
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

    cf_rows = (
        db.query(
            func.date(WarehouseMovement.created_at).label("bucket_date"),
            WarehouseMovement.type,
            func.sum(revenue_expr).label("revenue"),
            func.sum(cost_expr).label("cost"),
        )
        .filter(
            WarehouseMovement.organization_id == org.id,
            WarehouseMovement.type.in_([MovementType.SALE_OUT, MovementType.PURCHASE_IN, MovementType.PRODUCTION_OUT]),
            WarehouseMovement.created_at >= start_dt,
            WarehouseMovement.created_at < end_dt,
        )
        .group_by(func.date(WarehouseMovement.created_at), WarehouseMovement.type)
        .all()
    )

    month_names = ["Січ","Лют","Бер","Квіт","Трав","Черв","Лип","Серп","Вер","Жовт","Лист","Груд"]
    cash_flow: list[CashFlowBucket] = []

    if period == "month":
        week = start
        while week <= end:
            w_end = min(week + timedelta(days=6), end)
            label = f"{week.day}–{w_end.day} {week.strftime('%b')}"
            inflow = outflow = Decimal("0")
            for row in cf_rows:
                bucket_date = row.bucket_date
                if not (week <= bucket_date <= w_end):
                    continue
                direction = _CF_DIRECTION.get(row.type, "ignore")
                if direction == "inflow":
                    inflow += row.revenue or money_zero
                elif direction == "outflow":
                    outflow += row.cost or money_zero
            cash_flow.append(CashFlowBucket(label=label, inflow=inflow, outflow=outflow))
            week = w_end + timedelta(days=1)
    else:
        buckets: dict[str, tuple[Decimal, Decimal]] = {}
        for row in cf_rows:
            direction = _CF_DIRECTION.get(row.type, "ignore")
            if direction == "ignore":
                continue
            k = row.bucket_date.strftime("%Y-%m")
            i, o_val = buckets.get(k, (Decimal("0"), Decimal("0")))
            if direction == "inflow":
                buckets[k] = (i + (row.revenue or money_zero), o_val)
            else:
                buckets[k] = (i, o_val + (row.cost or money_zero))
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
