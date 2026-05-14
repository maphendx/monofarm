from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_roles
from app.core.db import get_db
from app.models.filament_color import FilamentColor
from app.models.user import UserRole
from app.schemas.filament_color import FilamentColorCreate, FilamentColorOut, FilamentColorUpdate

router = APIRouter(prefix="/filament-colors", tags=["filament-colors"])


@router.get("", response_model=list[FilamentColorOut])
def list_colors(
    _=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return (
        db.query(FilamentColor)
        .order_by(FilamentColor.sort_order, FilamentColor.id)
        .all()
    )


@router.post("", response_model=FilamentColorOut, status_code=status.HTTP_201_CREATED)
def create_color(
    body: FilamentColorCreate,
    _=Depends(require_roles(UserRole.admin, UserRole.operator)),
    db: Session = Depends(get_db),
):
    row = FilamentColor(**body.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.patch("/{color_id}", response_model=FilamentColorOut)
def update_color(
    color_id: int,
    body: FilamentColorUpdate,
    _=Depends(require_roles(UserRole.admin, UserRole.operator)),
    db: Session = Depends(get_db),
):
    row = db.get(FilamentColor, color_id)
    if not row:
        raise HTTPException(status_code=404, detail="Color not found")
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(row, k, v)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/{color_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_color(
    color_id: int,
    _=Depends(require_roles(UserRole.admin, UserRole.operator)),
    db: Session = Depends(get_db),
):
    row = db.get(FilamentColor, color_id)
    if not row:
        raise HTTPException(status_code=404, detail="Color not found")
    db.delete(row)
    db.commit()
