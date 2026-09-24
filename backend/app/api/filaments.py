import random


from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles
from app.core.db import get_db
from app.models.filament import Filament, FilamentLog
from app.models.organization import Organization
from app.models.user import User, UserRole
from app.schemas.filament import (
    FilamentAdjust,
    FilamentCreate,
    FilamentLogOut,
    FilamentOut,
    FilamentUpdate, FilamentSetRemaining, SpoolReceivePayload, SpoolStatusPayload,
)


router = APIRouter(prefix="/materials", tags=["materials"])

_LABEL_CHARS = "ABCDEFGHJKLMNPRSTUVWXYZ23456789"


def _gen_label_id() -> str:
    return "".join(random.choices(_LABEL_CHARS, k=4))


def _warehouse_name(db, filament):
    from app.models.warehouse import Warehouse
    if db is None or filament.warehouse_id is None:
        return None
    warehouse = db.query(Warehouse).filter_by(id=filament.warehouse_id, organization_id=filament.organization_id).first()
    return warehouse.name if warehouse else None


def _to_out(f: Filament, db: Session | None = None) -> FilamentOut:
    from app.services import filament_inventory

    location = None
    reserved = 0
    available = f.grams_remaining
    if db is not None:
        location = filament_inventory.spool_location(db, f.id)
        reserved = filament_inventory.active_reserved_g(db, f.id)
        available = max(0, f.grams_remaining - reserved)
    return FilamentOut(
        warehouse_product_id=f.warehouse_product_id,
        warehouse_id=f.warehouse_id,
        warehouse_name=_warehouse_name(db, f),
        id=f.id,
        sku=f.sku,
        label_id=f.label_id,
        status=f.status,
        location=location,
        reserved_g=reserved,
        available_g=available,
        material=f.material,
        color=f.color,
        hex_color=f.hex_color,
        brand=f.brand,
        grams_remaining=f.grams_remaining,
        min_grams=f.min_grams,
        cost_per_kg=f.cost_per_kg,
        note=f.note,
        updated_at=f.updated_at,
        is_low=f.grams_remaining <= f.min_grams,
    )


def _write_log(
    db: Session, f: Filament, delta: int, reason: str | None,
    user_id: int | None, task_id: int | None = None,
) -> None:
    db.add(FilamentLog(
        organization_id=f.organization_id,
        filament_id=f.id,
        delta_grams=delta,
        grams_after=f.grams_remaining,
        reason=reason,
        task_id=task_id,
        user_id=user_id,
    ))


# ── endpoints ─────────────────────────────────────────────────────────────────

@router.get("", response_model=list[FilamentOut])
def list_filaments(
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[FilamentOut]:
    rows = db.query(Filament).filter(Filament.organization_id == org.id).order_by(Filament.material, Filament.color).all()
    return [_to_out(f, db) for f in rows]


@router.post("", response_model=FilamentOut, status_code=status.HTTP_201_CREATED)
def create_filament(
    payload: FilamentCreate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> FilamentOut:
    f = Filament(**payload.model_dump(), organization_id=org.id)
    if not f.label_id:
        f.label_id = _gen_label_id()
    db.add(f)
    db.flush()
    f.sku = f"FL{org.id:04d}{f.id:05d}"
    _write_log(db, f, f.grams_remaining, "Початковий залишок", user.id)
    db.commit()
    db.refresh(f)
    return _to_out(f, db)


@router.patch("/{filament_id}", response_model=FilamentOut)
def update_filament(
    filament_id: int,
    payload: FilamentUpdate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user=Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> FilamentOut:
    f = db.query(Filament).filter(Filament.id == filament_id, Filament.organization_id == org.id).with_for_update().first()
    if not f:
        raise HTTPException(status_code=404, detail="Filament not found")
    prev_value = f.grams_remaining
    values = payload.model_dump(exclude_none=True)
    if "grams_remaining" in values:
        from app.services.filament_accounting import adjust_remaining
        adjust_remaining(db, org.id, f, values.pop("grams_remaining"), user_id=_user.id)
    for field, val in values.items():
        setattr(f, field, val)
    from app.services.telegram_notify import notify_filament_low_if_crossed
    notify_filament_low_if_crossed(db, org.id, f, prev_grams=prev_value)
    db.commit()
    db.refresh(f)
    return _to_out(f, db)


@router.post("/{filament_id}/adjust", response_model=FilamentOut)
def adjust_stock(
    filament_id: int,
    payload: FilamentAdjust,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> FilamentOut:
    f = db.query(Filament).filter(Filament.id == filament_id, Filament.organization_id == org.id).with_for_update().first()
    if not f:
        raise HTTPException(status_code=404, detail="Filament not found")
    from app.services.filament_accounting import adjust_remaining
    if payload.task_id:
        from app.models.task import PrintTask
        if not db.query(PrintTask).filter_by(id=payload.task_id, organization_id=org.id).first():
            raise HTTPException(404, "Задачу не знайдено")
    adjust_remaining(db, org.id, f, f.grams_remaining + payload.delta_grams,
                     user_id=user.id, reason=payload.reason, task_id=payload.task_id)
    db.commit()
    db.refresh(f)
    return _to_out(f, db)


@router.post("/{filament_id}/remaining", response_model=FilamentOut)
def set_remaining(
    filament_id: int, payload: FilamentSetRemaining,
    db: Session = Depends(get_db), org: Organization = Depends(get_current_org),
    user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
):
    from app.services.filament_accounting import adjust_remaining
    f = db.query(Filament).filter_by(id=filament_id, organization_id=org.id).with_for_update().first()
    if f is None:
        raise HTTPException(404, "Котушку не знайдено")
    # Absolute value requests replay safely, but cannot overwrite a newer print deduction.
    if f.grams_remaining != payload.grams_remaining:
        if f.grams_remaining != payload.expected_grams:
            raise HTTPException(409, "Залишок змінився. Оновіть котушку та повторіть корекцію")
        adjust_remaining(db, org.id, f, payload.grams_remaining, user_id=user.id, reason=payload.reason)
    db.commit()
    return _to_out(f, db)


SPOOL_STATUSES = ("in_stock", "empty", "retired")


@router.post("/{filament_id}/status", response_model=FilamentOut)
def set_spool_status(
    filament_id: int,
    payload: SpoolStatusPayload,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> FilamentOut:
    """Warehouse-side spool lifecycle: mark empty / put back in stock / retire.

    A status change is not a stock movement — grams never change here.
    """
    if payload.status not in SPOOL_STATUSES:
        raise HTTPException(status_code=400, detail="Невідомий статус котушки")
    f = db.query(Filament).filter(Filament.id == filament_id, Filament.organization_id == org.id).with_for_update().first()
    if not f:
        raise HTTPException(status_code=404, detail="Filament not found")
    if payload.status == "empty" and f.grams_remaining > 0:
        raise HTTPException(409, "Спочатку уточніть залишок котушки до 0 г")
    f.status = payload.status
    db.commit()
    db.refresh(f)
    return _to_out(f, db)


@router.get("/reconciliation")
def materials_reconciliation(
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[dict]:
    """Warehouse ledger vs physical spools per linked material — diagnostics only."""
    from app.services import filament_inventory

    return [
        {
            "product_id": r.product_id,
            "product_name": r.product_name,
            "ledger_g": round(r.ledger_g, 1),
            "spools_g": r.spools_g,
            "loaded_g": r.loaded_g,
            "reserved_g": r.reserved_g,
            "difference_g": round(r.difference_g, 1),
            "empty_spools": r.empty_spools,
            "total_spools": r.total_spools,
        }
        for r in filament_inventory.reconciliation(db, org.id)
    ]


@router.post("/receive", response_model=list[FilamentOut], status_code=status.HTTP_201_CREATED)
def receive_spools(
    payload: SpoolReceivePayload,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> list[FilamentOut]:
    """Receive filament as one warehouse PURCHASE_IN plus physical spool records.

    The ledger movement happens exactly once for the whole delivery; each
    spool record is a container of that inventory, never a second receipt.
    """
    from app.api.deps import require_warehouse_full
    from app.models.warehouse import MovementType, Product, Warehouse, WarehouseMovement

    require_warehouse_full(org)
    db.query(Organization).filter_by(id=org.id).with_for_update().one()
    product = db.query(Product).filter_by(id=payload.product_id, organization_id=org.id).with_for_update().first()
    if not product or not product.is_active:
        raise HTTPException(status_code=400, detail="Товар не знайдено або архівовано")
    from app.services.filament_accounting import grams_per_unit
    try:
        factor = grams_per_unit(product.unit)
    except HTTPException:
        if not payload.convert_to_grams:
            raise HTTPException(422, "Підтвердьте облік цього матеріалу в грамах")
        from app.models.warehouse import StockEntry, SpecComponent, OrderItem, Order, ProductionBatch
        # A new, unused catalog entry can change units; existing quantities and
        # prices must never be silently reinterpreted as grams.
        used = any(db.query(model).filter_by(organization_id=org.id, product_id=product.id).first()
                   for model in (StockEntry, WarehouseMovement, ProductionBatch))
        used = used or db.query(OrderItem).join(Order).filter(Order.organization_id == org.id, OrderItem.product_id == product.id).first()
        used = used or db.query(SpecComponent).join(Product, Product.id == SpecComponent.product_id).filter(Product.organization_id == org.id, Product.id == product.id).first()
        used = used or db.query(Filament).filter_by(organization_id=org.id, warehouse_product_id=product.id).first()
        if used or any((product.cost_price, product.sale_price, product.direct_cost, product.full_cost)):
            raise HTTPException(409, "Товар уже має облік або ціни в іншій одиниці. Створіть для пластику окремий товар з одиницею г або кг")
        product.unit = "г"
        factor = Decimal(1)

    if payload.warehouse_id is not None:
        warehouse = db.query(Warehouse).filter_by(
            id=payload.warehouse_id, organization_id=org.id, is_active=True,
        ).first()
    elif payload.warehouse_name and payload.warehouse_name.strip():
        from app.models.warehouse import WarehouseType
        name = payload.warehouse_name.strip()
        warehouse = db.query(Warehouse).filter_by(organization_id=org.id, name=name, is_active=True).first()
        if warehouse is None:
            warehouse = Warehouse(organization_id=org.id, name=name, type=WarehouseType.raw, is_active=True)
            db.add(warehouse)
            db.flush()
    else:
        warehouse = None
    if warehouse is None:
        raise HTTPException(400, "Оберіть склад або вкажіть назву нового")

    reference = f"spool_receive:{payload.request_id}" if payload.request_id else None
    if reference:
        previous = db.query(WarehouseMovement).filter_by(organization_id=org.id, reason=reference).first()
        if previous:
            requested_qty = Decimal(sum(item.grams * item.count for item in payload.spools)) / factor
            requested_cost = Decimal(payload.cost_per_kg) / 1000 * factor if payload.cost_per_kg is not None else None
            if previous.product_id != product.id or previous.warehouse_to_id != warehouse.id or previous.quantity != requested_qty or previous.unit_cost != requested_cost:
                raise HTTPException(409, "Це надходження вже збережено з іншими параметрами")
            return [_to_out(f, db) for f in db.query(Filament).filter_by(organization_id=org.id, receipt_id=previous.id).order_by(Filament.id).all()]
    if sum(item.count for item in payload.spools) > 1000:
        raise HTTPException(422, "За один раз можна прийняти до 1000 котушок")
    total_g = sum(item.grams * item.count for item in payload.spools)
    if total_g <= 0:
        raise HTTPException(status_code=400, detail="Вкажіть грами котушок")

    movement = WarehouseMovement(
        organization_id=org.id,
        type=MovementType.PURCHASE_IN,
        product_id=product.id,
        warehouse_to_id=warehouse.id,
        quantity=Decimal(total_g) / factor,
        unit=product.unit,
        unit_cost=Decimal(payload.cost_per_kg) / 1000 * factor if payload.cost_per_kg is not None else None,
        total_cost=Decimal(payload.cost_per_kg) / 1000 * total_g if payload.cost_per_kg is not None else None,
        reason=reference or payload.note or f"Надходження котушок × {sum(i.count for i in payload.spools)}",
        created_by_id=user.id,
    )
    db.add(movement)
    db.flush()
    from app.api.warehouse_modules.common import _apply_movement
    _apply_movement(movement, db)

    created: list[Filament] = []
    for item in payload.spools:
        for _ in range(item.count):
            fil = Filament(
                organization_id=org.id,
                material=product.name,  # refine below from product name parts
                color=product.name,
                grams_remaining=item.grams,
                min_grams=0,
                warehouse_product_id=product.id,
                warehouse_id=warehouse.id,
                receipt_id=movement.id,
                cost_per_kg=payload.cost_per_kg,
                hex_color=payload.hex_color,
                status="in_stock",
            )
            # Brand/material/color come from the SKU name when it follows the
            # "Brand · Material · Color" convention; otherwise keep product name.
            parts = [p.strip() for p in product.name.split("·")]
            if len(parts) >= 3:
                fil.brand = parts[0]
                fil.material = parts[1]
                fil.color = parts[2]
            fil.material = payload.material.strip() if payload.material and payload.material.strip() else fil.material
            fil.color = payload.color.strip() if payload.color and payload.color.strip() else fil.color
            fil.brand = payload.brand.strip() if payload.brand and payload.brand.strip() else fil.brand
            db.add(fil)
            db.flush()
            fil.label_id = fil.label_id or _gen_label_id()
            fil.sku = f"FL{org.id:04d}{fil.id:05d}"
            db.add(FilamentLog(
                organization_id=org.id,
                filament_id=fil.id,
                delta_grams=item.grams,
                grams_after=item.grams,
                reason=f"Надходження ({movement.reason[:80]})",
                user_id=user.id,
            ))
            created.append(fil)
    db.commit()
    return [_to_out(f, db) for f in created]


@router.get("/{filament_id}/log", response_model=list[FilamentLogOut])
def get_log(
    filament_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[FilamentLogOut]:
    f = db.query(Filament).filter(Filament.id == filament_id, Filament.organization_id == org.id).with_for_update().first()
    if not f:
        raise HTTPException(status_code=404, detail="Filament not found")
    return db.query(FilamentLog).filter(FilamentLog.filament_id == filament_id).order_by(FilamentLog.created_at.desc()).all()


@router.delete("/{filament_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_filament(
    filament_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user=Depends(require_roles(UserRole.admin)),
) -> None:
    f = db.query(Filament).filter(Filament.id == filament_id, Filament.organization_id == org.id).with_for_update().first()
    if not f:
        raise HTTPException(status_code=404, detail="Filament not found")
    if f.warehouse_product_id or db.query(FilamentLog.id).filter_by(filament_id=f.id, organization_id=org.id).first():
        raise HTTPException(409, "Котушка має історію обліку. Архівуйте її замість видалення")
    db.delete(f)
    db.commit()
