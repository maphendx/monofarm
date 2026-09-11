"""Stock-ledger movement endpoints and cursor pagination."""
import base64
from datetime import datetime
from decimal import Decimal


from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from app.api.ws import broadcast_warehouse
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles, require_warehouse_full
from app.core.db import get_db
from app.models.organization import Organization
from app.models.user import User, UserRole
from app.models.warehouse import (
    MovementType, Order, OrderItem, ProductionBatch, WarehouseMovement,
    Product,
)
from app.schemas.warehouse import (
    MovementCreate, MovementListOut, MovementOut, _MOVEMENT_DIRECTION,
)

public_router = APIRouter(tags=["warehouse"])

# All routes that require Starter plan or above (full warehouse access).
# Free plan can only access /products and /categories.
full_router = APIRouter(dependencies=[Depends(require_warehouse_full)])

from app.api.warehouse_modules.common import (_apply_movement, _check_and_auto_replenish, _get_cell, _get_product, _get_warehouse, _pick_from_cell, _putaway, _unassigned_qty)

# ── Movements ─────────────────────────────────────────────────────────────────

def _encode_cursor(created_at: datetime, row_id: int) -> str:
    raw = f"{created_at.isoformat()}|{row_id}"
    return base64.urlsafe_b64encode(raw.encode()).decode()


def _decode_cursor(cursor: str) -> tuple[datetime, int]:
    raw = base64.urlsafe_b64decode(cursor.encode()).decode()
    created_iso, id_str = raw.rsplit("|", 1)
    return datetime.fromisoformat(created_iso), int(id_str)


@full_router.get("/movements", response_model=MovementListOut)
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
    from sqlalchemy import and_, select, func as safunc

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
    products = {
        p.id: p.name
        for p in db.query(Product).filter(Product.organization_id == org.id, Product.id.in_(pids)).all()
    } if pids else {}

    items = [
        MovementOut(
            id=m.id, type=m.type,
            direction=_MOVEMENT_DIRECTION.get(m.type, "in"),
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


@full_router.post("/movements", response_model=MovementOut, status_code=status.HTTP_201_CREATED)
def create_movement(
    payload: MovementCreate,
    bg:   BackgroundTasks,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> MovementOut:
    product = _get_product(payload.product_id, org, db)
    if payload.quantity <= 0:
        raise HTTPException(status_code=400, detail="Quantity must be greater than zero")
    if payload.warehouse_from_id is not None:
        _get_warehouse(payload.warehouse_from_id, org, db)
    if payload.warehouse_to_id is not None:
        _get_warehouse(payload.warehouse_to_id, org, db)
    if payload.batch_id is not None:
        batch = db.query(ProductionBatch).filter_by(id=payload.batch_id, organization_id=org.id).first()
        if not batch:
            raise HTTPException(status_code=404, detail="Batch not found")
        if batch.product_id != payload.product_id and payload.type in (MovementType.PRODUCTION_IN, MovementType.DEFECT):
            raise HTTPException(status_code=400, detail="Movement product does not match batch product")
    if payload.order_id is not None:
        order = db.query(Order).filter_by(id=payload.order_id, organization_id=org.id).first()
        if not order:
            raise HTTPException(status_code=404, detail="Order not found")

    if payload.type in (MovementType.PURCHASE_IN, MovementType.RETURN_IN, MovementType.PRODUCTION_IN) and payload.warehouse_to_id is None:
        raise HTTPException(status_code=400, detail=f"{payload.type.value} requires warehouse_to_id")
    if payload.type in (MovementType.SALE_OUT, MovementType.PRODUCTION_OUT, MovementType.WRITE_OFF) and payload.warehouse_from_id is None:
        raise HTTPException(status_code=400, detail=f"{payload.type.value} requires warehouse_from_id")
    if payload.type == MovementType.TRANSFER:
        if payload.warehouse_from_id is None or payload.warehouse_to_id is None:
            raise HTTPException(status_code=400, detail="TRANSFER requires both warehouses")
        if payload.warehouse_from_id == payload.warehouse_to_id:
            raise HTTPException(status_code=400, detail="Transfer warehouses must differ")
    if payload.type == MovementType.DEFECT and payload.warehouse_from_id is None and payload.warehouse_to_id is None:
        raise HTTPException(status_code=400, detail="DEFECT requires at least one warehouse")
    if payload.type == MovementType.ADJUSTMENT:
        if bool(payload.warehouse_from_id) == bool(payload.warehouse_to_id):
            raise HTTPException(status_code=400, detail="ADJUSTMENT requires exactly one warehouse")

    if payload.type == MovementType.PURCHASE_IN and not payload.unit_cost:
        raise HTTPException(status_code=400, detail="Закупка потребує ціну за одиницю (unit_cost)")
    if payload.type == MovementType.RETURN_IN and payload.order_id:
        item = db.query(OrderItem).filter_by(
            order_id=payload.order_id, product_id=payload.product_id
        ).first()
        if not item:
            raise HTTPException(status_code=400, detail="Товар не входив у це замовлення")
        already_returned: Decimal = db.query(
            func.coalesce(func.sum(WarehouseMovement.quantity), 0)
        ).filter(
            WarehouseMovement.organization_id == org.id,
            WarehouseMovement.order_id == payload.order_id,
            WarehouseMovement.product_id == payload.product_id,
            WarehouseMovement.type == MovementType.RETURN_IN,
        ).scalar() or Decimal("0")
        if already_returned + payload.quantity > item.quantity:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Не можна повернути більше, ніж відвантажено "
                    f"(відвантажено {item.quantity}, вже повернуто {already_returned})"
                ),
            )
    total = (payload.quantity * payload.unit_cost) if payload.unit_cost else None
    data = payload.model_dump()
    cell_from_id = data.pop("cell_from_id", None)   # not WarehouseMovement columns
    cell_to_id   = data.pop("cell_to_id", None)
    m = WarehouseMovement(
        organization_id=org.id,
        created_by_id=user.id,
        total_cost=total,
        **data,
    )
    db.add(m)
    db.flush()

    # Honor an explicit source bin BEFORE the stock change so the FIFO clamp
    # inside _apply_movement leaves it alone (the cell is already drawn down).
    if cell_from_id and m.warehouse_from_id:
        src = _get_cell(cell_from_id, org, db, warehouse_id=m.warehouse_from_id)
        _pick_from_cell(src, m.product_id, m.quantity, org.id, db,
                        movement_id=m.id, created_by_id=user.id)

    _apply_movement(m, db)

    # Honor an explicit target bin AFTER stock increased (cap to what's unassigned).
    if cell_to_id and m.warehouse_to_id:
        dst = _get_cell(cell_to_id, org, db, warehouse_id=m.warehouse_to_id)
        avail = _unassigned_qty(m.product_id, m.warehouse_to_id, org.id, db)
        _putaway(dst, m.product_id, min(m.quantity, avail), org.id, db,
                 movement_id=m.id, created_by_id=user.id)

    if payload.type in (MovementType.SALE_OUT, MovementType.PRODUCTION_OUT, MovementType.DEFECT, MovementType.TRANSFER):
        _check_and_auto_replenish(m.product_id, org.id, db)

    db.commit()
    db.refresh(m)
    bg.add_task(broadcast_warehouse, org.id, "movements")
    bg.add_task(broadcast_warehouse, org.id, "stock")
    return MovementOut(
        id=m.id, type=m.type,
        direction=_MOVEMENT_DIRECTION.get(m.type, "in"),
        product_id=m.product_id, product_name=product.name,
        warehouse_from_id=m.warehouse_from_id, warehouse_to_id=m.warehouse_to_id,
        quantity=m.quantity, unit=m.unit,
        unit_cost=m.unit_cost, total_cost=m.total_cost,
        reason=m.reason, batch_id=m.batch_id, order_id=m.order_id,
        created_at=m.created_at,
    )

