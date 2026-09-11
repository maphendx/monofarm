"""Stocktake lifecycle and invoice generation endpoints."""
from datetime import datetime
from decimal import Decimal


from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from app.api.ws import broadcast_warehouse
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles, require_warehouse_full
from app.core.db import get_db
from app.models.organization import Organization
from app.models.user import User, UserRole
from app.models.warehouse import (
    Counterparty, MovementType, Order, OrderItem, StockEntry, Warehouse, WarehouseMovement,
    Product,
    StocktakeLine, StocktakeScope, StocktakeSession, StocktakeStatus,
)
from app.schemas.warehouse import (
    StocktakeConfirmIn, StocktakeCountIn, StocktakeCreate, StocktakeDetailOut,
    StocktakeLineOut, StocktakeLineUpdate, StocktakeOut,
)

public_router = APIRouter(tags=["warehouse"])

# All routes that require Starter plan or above (full warehouse access).
# Free plan can only access /products and /categories.
full_router = APIRouter(dependencies=[Depends(require_warehouse_full)])

from app.api.warehouse_modules.common import (_apply_movement, _get_warehouse, _lock_stock_row, _product_image_url)
from app.api.warehouse_modules.pagination import DEFAULT_PAGE_SIZE, PageLimit, PageOffset


@full_router.post("/orders/{order_id}/invoice")
def order_invoice(
    order_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User       = Depends(require_roles(UserRole.admin, UserRole.operator, UserRole.manager)),
):
    from io import BytesIO
    from fastapi.responses import Response
    from reportlab.lib.pagesizes import A4
    from reportlab.lib import colors
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.lib.units import mm

    order = db.query(Order).filter_by(organization_id=org.id, id=order_id).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    items = db.query(OrderItem).filter_by(order_id=order.id).all()
    product_ids = {it.product_id for it in items}
    product_map = {p.id: p for p in db.query(Product).filter(
        Product.organization_id == org.id, Product.id.in_(product_ids)
    ).all()}
    cp = db.query(Counterparty).filter_by(organization_id=org.id, id=order.counterparty_id).first() if order.counterparty_id else None

    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4,
                            leftMargin=20*mm, rightMargin=20*mm,
                            topMargin=20*mm, bottomMargin=20*mm)
    styles = getSampleStyleSheet()
    elems = []

    elems.append(Paragraph(f"Рахунок-фактура №{order.id}", styles["Title"]))
    elems.append(Spacer(1, 6*mm))

    meta = [
        ["Контрагент:", cp.name if cp else "—"],
        ["Статус:", order.status.value],
        ["Дата:", order.created_at.strftime("%d.%m.%Y") if order.created_at else "—"],
    ]
    t = Table(meta, colWidths=[50*mm, 120*mm])
    t.setStyle(TableStyle([
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("TEXTCOLOR", (0, 0), (0, -1), colors.grey),
    ]))
    elems.append(t)
    elems.append(Spacer(1, 8*mm))

    header = ["Товар", "Кількість", "Ціна", "Сума"]
    rows = []
    total = 0
    for it in items:
        p = product_map.get(it.product_id)
        name = p.name if p else str(it.product_id)
        price = float(it.unit_price or 0)
        qty = float(it.quantity)
        line = float(it.total_price or qty * price)
        total += line
        rows.append([name, f"{qty:.0f}", f"{price:.2f}", f"{line:.2f}"])
    rows.append(["", "", "Разом:", f"{total:.2f}"])

    tbl = Table([header] + rows, colWidths=[80*mm, 30*mm, 30*mm, 30*mm])
    tbl.setStyle(TableStyle([
        ("BACKGROUND",   (0, 0), (-1, 0), colors.HexColor("#1a1a2e")),
        ("TEXTCOLOR",    (0, 0), (-1, 0), colors.white),
        ("FONTSIZE",     (0, 0), (-1, -1), 9),
        ("ROWBACKGROUNDS", (0, 1), (-1, -2), [colors.white, colors.HexColor("#f5f5f5")]),
        ("FONTNAME",     (0, -1), (-1, -1), "Helvetica-Bold"),
        ("LINEBELOW",    (0, -1), (-1, -1), 1, colors.black),
        ("ALIGN",        (1, 0), (-1, -1), "RIGHT"),
    ]))
    elems.append(tbl)

    doc.build(elems)
    buf.seek(0)
    filename = f"invoice_{order.id}.pdf"
    return Response(
        content=buf.read(),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── Stocktake (інвентаризація) ────────────────────────────────────────────────

def _get_stocktake(st_id: int, org: Organization, db: Session) -> StocktakeSession:
    st = db.query(StocktakeSession).filter_by(id=st_id, organization_id=org.id).first()
    if not st:
        raise HTTPException(status_code=404, detail="Інвентаризацію не знайдено")
    return st


def _stocktake_expected_map(st: StocktakeSession, db: Session) -> dict[int, Decimal]:
    """Live on-hand quantities for the session's warehouse (open sessions only)."""
    return dict(
        db.query(StockEntry.product_id, StockEntry.quantity)
        .filter_by(organization_id=st.organization_id, warehouse_id=st.warehouse_id)
        .all()
    )


def _stocktake_line_out(ln: StocktakeLine, p: Product, expected: Decimal, org_id: int) -> StocktakeLineOut:
    diff = diff_value = None
    if ln.counted_qty is not None:
        diff = ln.counted_qty - expected
        diff_value = diff * (p.cost_price or Decimal("0"))
    return StocktakeLineOut(
        id=ln.id, product_id=p.id, product_name=p.name, product_sku=p.sku,
        barcode=p.barcode, unit=p.unit, image_url=_product_image_url(p, org_id),
        expected_qty=expected, counted_qty=ln.counted_qty,
        diff=diff, diff_value=diff_value, counted_at=ln.counted_at,
    )


def _stocktake_out(st: StocktakeSession, db: Session, org_id: int, *, with_lines: bool = False) -> StocktakeDetailOut:
    wh = db.get(Warehouse, st.warehouse_id)
    rows = (
        db.query(StocktakeLine, Product)
        .join(Product, Product.id == StocktakeLine.product_id)
        .filter(StocktakeLine.session_id == st.id)
        .order_by(Product.name)
        .all()
    )
    live = _stocktake_expected_map(st, db) if st.status == StocktakeStatus.open else {}
    lines: list[StocktakeLineOut] = []
    counted = diff_lines = 0
    surplus_value = shortage_value = Decimal("0")
    for ln, p in rows:
        expected = live.get(ln.product_id, Decimal("0")) if st.status == StocktakeStatus.open else ln.expected_qty
        out = _stocktake_line_out(ln, p, expected, org_id)
        if out.counted_qty is not None:
            counted += 1
            if out.diff:
                diff_lines += 1
                if out.diff_value and out.diff_value > 0:
                    surplus_value += out.diff_value
                elif out.diff_value:
                    shortage_value += -out.diff_value
        lines.append(out)
    return StocktakeDetailOut(
        id=st.id, warehouse_id=st.warehouse_id,
        warehouse_name=wh.name if wh else "—",
        status=st.status.value, scope=st.scope.value, note=st.note,
        lines_total=len(rows), lines_counted=counted, diff_lines=diff_lines,
        surplus_value=surplus_value, shortage_value=shortage_value,
        created_at=st.created_at, confirmed_at=st.confirmed_at,
        lines=lines if with_lines else [],
    )


@full_router.get("/stocktakes", response_model=list[StocktakeOut])
def list_stocktakes(
    warehouse_id: int | None = None,
    skip: PageOffset = 0,
    limit: PageLimit = DEFAULT_PAGE_SIZE,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[StocktakeOut]:
    q = db.query(StocktakeSession).filter_by(organization_id=org.id)
    if warehouse_id:
        q = q.filter_by(warehouse_id=warehouse_id)
    sessions = (
        q.order_by(StocktakeSession.created_at.desc(), StocktakeSession.id.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )
    return [_stocktake_out(st, db, org.id) for st in sessions]


@full_router.post("/stocktakes", response_model=StocktakeDetailOut, status_code=status.HTTP_201_CREATED)
def create_stocktake(
    payload: StocktakeCreate,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> StocktakeDetailOut:
    wh = _get_warehouse(payload.warehouse_id, org, db)
    if payload.scope not in (StocktakeScope.full.value, StocktakeScope.partial.value):
        raise HTTPException(status_code=400, detail="scope: full або partial")
    existing = db.query(StocktakeSession).filter_by(
        organization_id=org.id, warehouse_id=wh.id, status=StocktakeStatus.open,
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail=f"Уже є відкрита інвентаризація №{existing.id} для цього складу")

    stock = dict(
        db.query(StockEntry.product_id, StockEntry.quantity)
        .filter_by(organization_id=org.id, warehouse_id=wh.id)
        .all()
    )
    if payload.scope == StocktakeScope.full.value:
        product_ids = list(stock.keys())
    else:
        product_ids = list(payload.product_ids)
        if payload.category_id:
            cat_ids = [pid for (pid,) in db.query(Product.id).filter(
                Product.organization_id == org.id,
                Product.is_active.is_(True),
                Product.categories.contains([payload.category_id]))]
            product_ids.extend(cat_ids)
        product_ids = list(dict.fromkeys(product_ids))
        if not product_ids:
            raise HTTPException(status_code=400, detail="Часткова інвентаризація: вкажіть товари або категорію")
        owned = {pid for (pid,) in db.query(Product.id).filter(
            Product.organization_id == org.id, Product.id.in_(product_ids))}
        product_ids = [pid for pid in product_ids if pid in owned]

    st = StocktakeSession(
        organization_id=org.id, warehouse_id=wh.id,
        scope=StocktakeScope(payload.scope), note=(payload.note or "").strip() or None,
        created_by_id=user.id,
    )
    db.add(st)
    db.flush()

    for pid in product_ids:
        db.add(StocktakeLine(session_id=st.id, product_id=pid, expected_qty=stock.get(pid, Decimal("0"))))
    db.commit()
    return _stocktake_out(st, db, org.id, with_lines=True)


@full_router.get("/stocktakes/{st_id}", response_model=StocktakeDetailOut)
def get_stocktake(
    st_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> StocktakeDetailOut:
    st = _get_stocktake(st_id, org, db)
    return _stocktake_out(st, db, org.id, with_lines=True)


@full_router.post("/stocktakes/{st_id}/count", response_model=StocktakeLineOut)
def stocktake_count(
    st_id: int,
    payload: StocktakeCountIn,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> StocktakeLineOut:
    """Scanner-friendly count: resolve product by id / barcode / SKU, set or add qty."""
    st = _get_stocktake(st_id, org, db)
    if st.status != StocktakeStatus.open:
        raise HTTPException(status_code=400, detail="Інвентаризацію вже закрито")
    if payload.quantity < 0:
        raise HTTPException(status_code=400, detail="Кількість має бути ≥ 0")
    if payload.mode not in ("set", "add"):
        raise HTTPException(status_code=400, detail="mode: set або add")

    product: Product | None = None
    if payload.product_id:
        product = db.query(Product).filter_by(id=payload.product_id, organization_id=org.id).first()
    elif payload.code:
        code = payload.code.strip()
        product = db.query(Product).filter(
            Product.organization_id == org.id,
            or_(Product.barcode == code, Product.sku == code),
        ).first()
    if not product:
        raise HTTPException(status_code=404, detail="Товар не знайдено")

    line = db.query(StocktakeLine).filter_by(session_id=st.id, product_id=product.id).first()
    if not line:
        expected = _stocktake_expected_map(st, db).get(product.id, Decimal("0"))
        line = StocktakeLine(session_id=st.id, product_id=product.id, expected_qty=expected)
        db.add(line)
        db.flush()
    if payload.mode == "add" and line.counted_qty is not None:
        line.counted_qty += payload.quantity
    else:
        line.counted_qty = payload.quantity
    line.counted_by_id = user.id
    line.counted_at = datetime.utcnow()
    db.commit()
    expected = _stocktake_expected_map(st, db).get(product.id, Decimal("0"))
    return _stocktake_line_out(line, product, expected, org.id)


@full_router.patch("/stocktakes/{st_id}/lines/{line_id}", response_model=StocktakeLineOut)
def update_stocktake_line(
    st_id: int,
    line_id: int,
    payload: StocktakeLineUpdate,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> StocktakeLineOut:
    st = _get_stocktake(st_id, org, db)
    if st.status != StocktakeStatus.open:
        raise HTTPException(status_code=400, detail="Інвентаризацію вже закрито")
    line = db.query(StocktakeLine).filter_by(id=line_id, session_id=st.id).first()
    if not line:
        raise HTTPException(status_code=404, detail="Рядок не знайдено")
    if payload.counted_qty is not None and payload.counted_qty < 0:
        raise HTTPException(status_code=400, detail="Кількість має бути ≥ 0")
    line.counted_qty = payload.counted_qty
    line.counted_by_id = user.id if payload.counted_qty is not None else None
    line.counted_at = datetime.utcnow() if payload.counted_qty is not None else None
    db.commit()
    product = db.get(Product, line.product_id)
    expected = _stocktake_expected_map(st, db).get(line.product_id, Decimal("0"))
    return _stocktake_line_out(line, product, expected, org.id)


@full_router.post("/stocktakes/{st_id}/confirm", response_model=StocktakeDetailOut)
def confirm_stocktake(
    st_id: int,
    payload: StocktakeConfirmIn,
    bg:   BackgroundTasks,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> StocktakeDetailOut:
    """Freeze the count and write diffs to the ledger.

    Surplus → ADJUSTMENT (in), shortage → WRITE_OFF. Expected is re-read from
    live stock under a row lock, so sales during the count don't corrupt totals.
    Uncounted lines: skip (leave as-is) or zero (treat as counted 0).
    """
    st = _get_stocktake(st_id, org, db)
    if st.status != StocktakeStatus.open:
        raise HTTPException(status_code=400, detail="Інвентаризацію вже закрито")
    if payload.uncounted not in ("skip", "zero"):
        raise HTTPException(status_code=400, detail="uncounted: skip або zero")

    lines = db.query(StocktakeLine).filter_by(session_id=st.id).all()
    for ln in lines:
        _lock_stock_row(ln.product_id, st.warehouse_id, org.id, db)
        entry = db.query(StockEntry).filter_by(
            organization_id=org.id, product_id=ln.product_id, warehouse_id=st.warehouse_id,
        ).first()
        live = entry.quantity if entry else Decimal("0")
        counted = ln.counted_qty
        if counted is None:
            if payload.uncounted == "skip":
                ln.expected_qty = live
                continue
            counted = Decimal("0")
            ln.counted_qty = counted
            ln.counted_by_id = user.id
            ln.counted_at = datetime.utcnow()
        ln.expected_qty = live
        diff = counted - live
        if diff == 0:
            continue
        if diff > 0:
            m = WarehouseMovement(
                organization_id=org.id, type=MovementType.ADJUSTMENT,
                product_id=ln.product_id, warehouse_to_id=st.warehouse_id,
                quantity=diff, reason=f"Інвентаризація №{st.id} (надлишок)",
                created_by_id=user.id,
            )
        else:
            m = WarehouseMovement(
                organization_id=org.id, type=MovementType.WRITE_OFF,
                product_id=ln.product_id, warehouse_from_id=st.warehouse_id,
                quantity=-diff, reason=f"Інвентаризація №{st.id} (нестача)",
                created_by_id=user.id,
            )
        db.add(m)
        db.flush()
        _apply_movement(m, db)

    st.status = StocktakeStatus.confirmed
    st.confirmed_at = datetime.utcnow()
    db.commit()
    bg.add_task(broadcast_warehouse, org.id, "stock")
    return _stocktake_out(st, db, org.id, with_lines=True)


@full_router.post("/stocktakes/{st_id}/cancel", response_model=StocktakeOut)
def cancel_stocktake(
    st_id: int,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    _user: User        = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> StocktakeOut:
    st = _get_stocktake(st_id, org, db)
    if st.status != StocktakeStatus.open:
        raise HTTPException(status_code=400, detail="Інвентаризацію вже закрито")
    st.status = StocktakeStatus.cancelled
    db.commit()
    return _stocktake_out(st, db, org.id)
