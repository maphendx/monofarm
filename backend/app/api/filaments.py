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
    FilamentUpdate,
)


router = APIRouter(prefix="/filaments", tags=["filaments"])


# ── warehouse sync helpers ────────────────────────────────────────────────────

def _get_raw_warehouse(org_id: int, db: Session):
    from app.models.warehouse import Warehouse, WarehouseType
    wh = db.query(Warehouse).filter(
        Warehouse.organization_id == org_id,
        Warehouse.type == WarehouseType.raw,
        Warehouse.is_active.is_(True),
    ).first()
    if not wh:
        wh = Warehouse(organization_id=org_id, name="Сировина", type=WarehouseType.raw)
        db.add(wh)
        db.flush()
    return wh


def _get_or_create_wh_product(f: Filament, db: Session):
    from app.models.warehouse import Product as WhProduct
    if f.warehouse_product_id:
        prod = db.get(WhProduct, f.warehouse_product_id)
        if prod:
            return prod
    sku = f"FIL-{f.sku}" if f.sku else f"FIL-{f.id}"
    prod = db.query(WhProduct).filter(
        WhProduct.organization_id == f.organization_id,
        WhProduct.sku == sku,
    ).first()
    if not prod:
        parts = [p for p in [f.brand, f.material, f.color] if p]
        name = " · ".join(parts) or f"Пластик #{f.id}"
        prod = WhProduct(
            organization_id=f.organization_id,
            name=name,
            sku=sku,
            categories=["Пластик"],
            unit="г",
            cost_price=Decimal(str(f.cost_per_kg)) / 1000 if f.cost_per_kg else None,
        )
        db.add(prod)
        db.flush()
    f.warehouse_product_id = prod.id
    return prod


def _warehouse_movement(
    f: Filament, delta_grams: int, reason: str | None, user_id: int | None, db: Session
) -> None:
    """Sync a filament gram change to the warehouse as a movement."""
    from app.models.warehouse import WarehouseMovement, MovementType
    from app.api.warehouse import _apply_movement

    prod = _get_or_create_wh_product(f, db)
    wh = _get_raw_warehouse(f.organization_id, db)
    cost_per_g = Decimal(str(f.cost_per_kg)) / 1000 if f.cost_per_kg else None
    qty = Decimal(str(abs(delta_grams)))

    if delta_grams > 0:
        mv = WarehouseMovement(
            organization_id=f.organization_id,
            type=MovementType.PURCHASE_IN,
            product_id=prod.id,
            warehouse_to_id=wh.id,
            quantity=qty,
            unit="г",
            unit_cost=cost_per_g,
            total_cost=(qty * cost_per_g) if cost_per_g else None,
            reason=reason or "Нова котушка",
            created_by_id=user_id,
        )
    else:
        mv = WarehouseMovement(
            organization_id=f.organization_id,
            type=MovementType.PRODUCTION_OUT,
            product_id=prod.id,
            warehouse_from_id=wh.id,
            quantity=qty,
            unit="г",
            unit_cost=cost_per_g,
            total_cost=(qty * cost_per_g) if cost_per_g else None,
            reason=reason or "Списання пластику",
            created_by_id=user_id,
        )

    db.add(mv)
    db.flush()
    _apply_movement(mv, db)


# ── output helper ─────────────────────────────────────────────────────────────

def _to_out(f: Filament) -> FilamentOut:
    return FilamentOut(
        id=f.id,
        sku=f.sku,
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
        warehouse_product_id=f.warehouse_product_id,
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
    return [_to_out(f) for f in rows]


@router.post("", response_model=FilamentOut, status_code=status.HTTP_201_CREATED)
def create_filament(
    payload: FilamentCreate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> FilamentOut:
    f = Filament(**payload.model_dump(), organization_id=org.id)
    db.add(f)
    db.flush()
    f.sku = f"FL{org.id:04d}{f.id:05d}"
    # sync to warehouse
    if f.grams_remaining > 0:
        _warehouse_movement(f, f.grams_remaining, "Нова котушка", user.id, db)
    else:
        _get_or_create_wh_product(f, db)  # still create the product
    db.commit()
    db.refresh(f)
    return _to_out(f)


@router.patch("/{filament_id}", response_model=FilamentOut)
def update_filament(
    filament_id: int,
    payload: FilamentUpdate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user=Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> FilamentOut:
    f = db.query(Filament).filter(Filament.id == filament_id, Filament.organization_id == org.id).first()
    if not f:
        raise HTTPException(status_code=404, detail="Filament not found")
    for field, val in payload.model_dump(exclude_none=True).items():
        setattr(f, field, val)
    # keep warehouse product name/cost in sync
    if f.warehouse_product_id:
        from app.models.warehouse import Product as WhProduct
        prod = db.get(WhProduct, f.warehouse_product_id)
        if prod:
            parts = [p for p in [f.brand, f.material, f.color] if p]
            prod.name = " · ".join(parts) or prod.name
            if f.cost_per_kg:
                prod.cost_price = Decimal(str(f.cost_per_kg)) / 1000
    db.commit()
    db.refresh(f)
    return _to_out(f)


@router.post("/{filament_id}/adjust", response_model=FilamentOut)
def adjust_stock(
    filament_id: int,
    payload: FilamentAdjust,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> FilamentOut:
    f = db.query(Filament).filter(Filament.id == filament_id, Filament.organization_id == org.id).first()
    if not f:
        raise HTTPException(status_code=404, detail="Filament not found")
    new_value = f.grams_remaining + payload.delta_grams
    if new_value < 0:
        raise HTTPException(status_code=400, detail="Залишок не може бути від'ємним")
    f.grams_remaining = new_value
    _write_log(db, f, payload.delta_grams, payload.reason, user.id, payload.task_id)
    _warehouse_movement(f, payload.delta_grams, payload.reason, user.id, db)
    db.commit()
    db.refresh(f)
    return _to_out(f)


@router.get("/{filament_id}/log", response_model=list[FilamentLogOut])
def get_log(
    filament_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[FilamentLogOut]:
    f = db.query(Filament).filter(Filament.id == filament_id, Filament.organization_id == org.id).first()
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
    f = db.query(Filament).filter(Filament.id == filament_id, Filament.organization_id == org.id).first()
    if not f:
        raise HTTPException(status_code=404, detail="Filament not found")
    db.delete(f)
    db.commit()
