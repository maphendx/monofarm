from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_roles
from app.core.db import get_db
from app.models.filament import Filament
from app.models.user import User, UserRole
from app.schemas.filament import (
    FilamentAdjust,
    FilamentCreate,
    FilamentOut,
    FilamentUpdate,
)


router = APIRouter(prefix="/filaments", tags=["filaments"])


def _to_out(f: Filament) -> FilamentOut:
    return FilamentOut(
        id=f.id,
        material=f.material,
        color=f.color,
        brand=f.brand,
        grams_remaining=f.grams_remaining,
        min_grams=f.min_grams,
        note=f.note,
        updated_at=f.updated_at,
        is_low=f.grams_remaining <= f.min_grams,
    )


@router.get("", response_model=list[FilamentOut])
def list_filaments(
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[FilamentOut]:
    rows = db.query(Filament).order_by(Filament.material, Filament.color).all()
    return [_to_out(f) for f in rows]


@router.post("", response_model=FilamentOut, status_code=status.HTTP_201_CREATED)
def create_filament(
    payload: FilamentCreate,
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> FilamentOut:
    f = Filament(**payload.model_dump())
    db.add(f)
    db.commit()
    db.refresh(f)
    return _to_out(f)


@router.patch("/{filament_id}", response_model=FilamentOut)
def update_filament(
    filament_id: int,
    payload: FilamentUpdate,
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> FilamentOut:
    f = db.get(Filament, filament_id)
    if not f:
        raise HTTPException(status_code=404, detail="Filament not found")
    for field, val in payload.model_dump(exclude_none=True).items():
        setattr(f, field, val)
    db.commit()
    db.refresh(f)
    return _to_out(f)


@router.post("/{filament_id}/adjust", response_model=FilamentOut)
def adjust_stock(
    filament_id: int,
    payload: FilamentAdjust,
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> FilamentOut:
    f = db.get(Filament, filament_id)
    if not f:
        raise HTTPException(status_code=404, detail="Filament not found")
    new_value = f.grams_remaining + payload.delta_grams
    if new_value < 0:
        raise HTTPException(status_code=400, detail="Залишок не може бути від'ємним")
    f.grams_remaining = new_value
    db.commit()
    db.refresh(f)
    return _to_out(f)


@router.delete("/{filament_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_filament(
    filament_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin)),
) -> None:
    f = db.get(Filament, filament_id)
    if not f:
        raise HTTPException(status_code=404, detail="Filament not found")
    db.delete(f)
    db.commit()
