from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles
from app.core.db import get_db
from app.models.filament_color import FilamentColor
from app.models.organization import Organization
from app.models.user import UserRole
from app.schemas.filament_color import FilamentColorCreate, FilamentColorOut, FilamentColorUpdate

router = APIRouter(prefix="/filament-colors", tags=["filament-colors"])


@router.get("", response_model=list[FilamentColorOut])
def list_colors(
    org: Organization = Depends(get_current_org),
    db: Session = Depends(get_db),
):
    return (
        db.query(FilamentColor)
        .filter(FilamentColor.organization_id == org.id)
        .order_by(FilamentColor.sort_order, FilamentColor.id)
        .all()
    )


@router.post("", response_model=FilamentColorOut, status_code=status.HTTP_201_CREATED)
def create_color(
    body: FilamentColorCreate,
    org: Organization = Depends(get_current_org),
    _=Depends(require_roles(UserRole.admin, UserRole.operator)),
    db: Session = Depends(get_db),
):
    row = FilamentColor(**body.model_dump(), organization_id=org.id)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.patch("/{color_id}", response_model=FilamentColorOut)
def update_color(
    color_id: int,
    body: FilamentColorUpdate,
    org: Organization = Depends(get_current_org),
    _=Depends(require_roles(UserRole.admin, UserRole.operator)),
    db: Session = Depends(get_db),
):
    row = db.query(FilamentColor).filter(FilamentColor.id == color_id, FilamentColor.organization_id == org.id).first()
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
    org: Organization = Depends(get_current_org),
    _=Depends(require_roles(UserRole.admin, UserRole.operator)),
    db: Session = Depends(get_db),
):
    row = db.query(FilamentColor).filter(FilamentColor.id == color_id, FilamentColor.organization_id == org.id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Color not found")
    db.delete(row)
    db.commit()
