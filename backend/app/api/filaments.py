from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, get_current_user, require_roles
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


def _to_out(f: Filament) -> FilamentOut:
    return FilamentOut(
        id=f.id,
        sku=f.sku,
        material=f.material,
        color=f.color,
        brand=f.brand,
        grams_remaining=f.grams_remaining,
        min_grams=f.min_grams,
        cost_per_kg=f.cost_per_kg,
        note=f.note,
        updated_at=f.updated_at,
        is_low=f.grams_remaining <= f.min_grams,
    )


def _write_log(db: Session, f: Filament, delta: int, reason: str | None, user_id: int | None, task_id: int | None = None) -> None:
    entry = FilamentLog(
        organization_id=f.organization_id,
        filament_id=f.id,
        delta_grams=delta,
        grams_after=f.grams_remaining,
        reason=reason,
        task_id=task_id,
        user_id=user_id,
    )
    db.add(entry)


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
    db.flush()  # get id before commit
    f.sku = f"FL{org.id:04d}{f.id:05d}"
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
