"""Production-batch lifecycle and progress endpoints."""
from decimal import Decimal


from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from app.api.ws import broadcast_warehouse
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles, require_warehouse_full
from app.core.db import get_db
from app.models.organization import Organization
from app.models.user import User, UserRole
from app.models.warehouse import (
    BatchStatus, MovementType, Order, OrderStatus, ProductionBatch, SpecComponent, StockEntry, WarehouseMovement,
)
from app.schemas.warehouse import (
    BatchClose, BatchCreate, BatchOut, BatchUpdate,
)

public_router = APIRouter(tags=["warehouse"])

# All routes that require Starter plan or above (full warehouse access).
# Free plan can only access /products and /categories.
full_router = APIRouter(dependencies=[Depends(require_warehouse_full)])

from app.api.warehouse_modules.common import (_apply_movement, _check_and_auto_replenish, _get_product, _get_spec_for_product, _get_warehouse)
from app.api.warehouse_modules.batch_serialization import _batch_to_out, _build_batch_prefetch
from app.api.warehouse_modules.pagination import DEFAULT_PAGE_SIZE, PageLimit, PageOffset

# ── ProductionBatch ───────────────────────────────────────────────────────────

@full_router.get("/batches", response_model=list[BatchOut])
def list_batches(
    batch_status: BatchStatus | None = Query(None),
    product_id:   int | None         = Query(None),
    skip: PageOffset = 0,
    limit: PageLimit = DEFAULT_PAGE_SIZE,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[BatchOut]:
    q = db.query(ProductionBatch).filter(ProductionBatch.organization_id == org.id)
    if batch_status:
        q = q.filter(ProductionBatch.status == batch_status)
    if product_id:
        q = q.filter(ProductionBatch.product_id == product_id)
    rows = (
        q.order_by(ProductionBatch.created_at.desc(), ProductionBatch.id.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )
    pf = _build_batch_prefetch(rows, db)
    return [_batch_to_out(b, db, pf) for b in rows]


@full_router.post("/batches", response_model=BatchOut, status_code=status.HTTP_201_CREATED)
def create_batch(
    payload: BatchCreate,
    bg:   BackgroundTasks,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> BatchOut:
    _get_product(payload.product_id, org, db)
    _get_spec_for_product(payload.specification_id, payload.product_id, org, db)
    if payload.order_id:
        order = db.query(Order).filter_by(id=payload.order_id, organization_id=org.id).first()
        if not order:
            raise HTTPException(status_code=404, detail="Order not found")
    if payload.print_task_id:
        from app.models.task import PrintTask
        task = db.query(PrintTask).filter_by(id=payload.print_task_id, organization_id=org.id).first()
        if not task:
            raise HTTPException(status_code=404, detail="Print task not found")
    b = ProductionBatch(organization_id=org.id, created_by_id=user.id, **payload.model_dump())
    db.add(b)
    # auto-advance linked order to in_production
    if payload.order_id:
        if order and order.status == OrderStatus.confirmed:
            order.status = OrderStatus.in_production
    db.commit()
    db.refresh(b)
    bg.add_task(broadcast_warehouse, org.id, "production")
    return _batch_to_out(b, db)


@full_router.get("/batches/{batch_id}", response_model=BatchOut)
def get_batch(
    batch_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> BatchOut:
    b = db.query(ProductionBatch).filter_by(id=batch_id, organization_id=org.id).first()
    if not b:
        raise HTTPException(status_code=404, detail="Batch not found")
    return _batch_to_out(b, db)


@full_router.patch("/batches/{batch_id}", response_model=BatchOut)
def update_batch(
    batch_id: int,
    payload:  BatchUpdate,
    bg:  BackgroundTasks,
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
    bg.add_task(broadcast_warehouse, org.id, "production")
    return _batch_to_out(b, db)


@full_router.delete("/batches/{batch_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_batch(
    batch_id: int,
    bg:  BackgroundTasks,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin)),
) -> None:
    b = db.query(ProductionBatch).filter_by(id=batch_id, organization_id=org.id).first()
    if not b:
        raise HTTPException(status_code=404, detail="Batch not found")
    if b.status == BatchStatus.done:
        raise HTTPException(
            status_code=400,
            detail="Завершену партію не можна видалити, бо вона вже могла створити складські рухи.",
        )
    db.delete(b)
    db.commit()
    bg.add_task(broadcast_warehouse, org.id, "production")


@full_router.patch("/batches/{batch_id}/progress", response_model=BatchOut)
def update_progress(
    batch_id:   int,
    bg:   BackgroundTasks,
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
    bg.add_task(broadcast_warehouse, org.id, "production")
    return _batch_to_out(b, db)


@full_router.post("/batches/{batch_id}/close", response_model=BatchOut)
def close_batch(
    batch_id: int,
    payload:  BatchClose,
    bg:   BackgroundTasks,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> BatchOut:
    b = db.query(ProductionBatch).filter_by(id=batch_id, organization_id=org.id).first()
    if not b:
        raise HTTPException(status_code=404, detail="Batch not found")
    if b.status == BatchStatus.done:
        raise HTTPException(status_code=400, detail="Batch already closed")
    if payload.good_qty < 0 or payload.defect_qty < 0:
        raise HTTPException(status_code=400, detail="Quantities must be non-negative")
    if payload.good_qty > 0 and payload.finished_warehouse_id is None:
        raise HTTPException(status_code=400, detail="finished_warehouse_id is required when good_qty > 0")
    if payload.defect_qty > 0 and payload.defect_warehouse_id is None:
        raise HTTPException(status_code=400, detail="defect_warehouse_id is required when defect_qty > 0")

    if payload.finished_warehouse_id is not None:
        _get_warehouse(payload.finished_warehouse_id, org, db)
    if payload.defect_warehouse_id is not None:
        _get_warehouse(payload.defect_warehouse_id, org, db)

    batch_product = _get_product(b.product_id, org, db)
    output_unit_cost = batch_product.full_cost or batch_product.direct_cost or batch_product.cost_price

    component_picks: list[tuple[SpecComponent, list[tuple[int, Decimal]]]] = []
    if b.specification_id and payload.good_qty > 0:
        spec_comps = db.query(SpecComponent).filter_by(specification_id=b.specification_id).all()
        shortages: list[str] = []
        for c in spec_comps:
            if not c.product_id:
                continue
            component_product = _get_product(c.product_id, org, db)
            qty_needed = c.quantity * Decimal(payload.good_qty)
            remaining = qty_needed
            picks: list[tuple[int, Decimal]] = []
            entries = (
                db.query(StockEntry)
                .filter_by(organization_id=org.id, product_id=c.product_id)
                .with_for_update()
                .all()
            )
            entries.sort(key=lambda e: float(e.quantity - e.reserved_qty), reverse=True)
            for entry in entries:
                available = max(Decimal("0"), entry.quantity - entry.reserved_qty)
                if available <= 0:
                    continue
                take = min(available, remaining)
                picks.append((entry.warehouse_id, take))
                remaining -= take
                if remaining <= 0:
                    break
            if remaining > 0:
                available = qty_needed - remaining
                shortages.append(f"{component_product.name}: потрібно {qty_needed}, доступно {available}")
            else:
                component_picks.append((c, picks))

        if shortages:
            raise HTTPException(
                status_code=422,
                detail="Недостатньо компонентів для закриття партії:\n" + "\n".join(shortages),
            )

    b.good_qty   = payload.good_qty
    b.defect_qty = payload.defect_qty
    b.status     = BatchStatus.done

    if payload.good_qty > 0 and payload.finished_warehouse_id:
        m_in = WarehouseMovement(
            organization_id=org.id, created_by_id=user.id,
            type=MovementType.PRODUCTION_IN,
            product_id=b.product_id,
            warehouse_to_id=payload.finished_warehouse_id,
            quantity=Decimal(payload.good_qty), unit=batch_product.unit,
            unit_cost=output_unit_cost,
            total_cost=(output_unit_cost * Decimal(payload.good_qty)) if output_unit_cost else None,
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
            quantity=Decimal(payload.defect_qty), unit=batch_product.unit,
            unit_cost=output_unit_cost,
            total_cost=(output_unit_cost * Decimal(payload.defect_qty)) if output_unit_cost else None,
            batch_id=b.id,
        )
        db.add(m_def)
        db.flush()
        _apply_movement(m_def, db)

    # Deduct spec components from stock for every good unit assembled
    for c, picks in component_picks:
        component_product = _get_product(c.product_id, org, db) if c.product_id else None
        unit_cost = component_product.cost_price if component_product else None
        for warehouse_id, quantity in picks:
            m_out = WarehouseMovement(
                organization_id=org.id, created_by_id=user.id,
                type=MovementType.PRODUCTION_OUT,
                product_id=c.product_id,
                warehouse_from_id=warehouse_id,
                quantity=quantity,
                unit=c.unit,
                unit_cost=unit_cost,
                total_cost=(unit_cost * quantity) if unit_cost else None,
                batch_id=b.id,
            )
            db.add(m_out)
            db.flush()
            _apply_movement(m_out, db)
            _check_and_auto_replenish(c.product_id, org.id, db)

    db.commit()
    db.refresh(b)
    bg.add_task(broadcast_warehouse, org.id, "production")
    bg.add_task(broadcast_warehouse, org.id, "stock")
    bg.add_task(broadcast_warehouse, org.id, "movements")
    return _batch_to_out(b, db)
