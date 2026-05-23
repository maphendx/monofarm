"""CRUD + reorder endpoints for printer groups."""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles
from app.core.db import get_db
from app.models.organization import Organization
from app.models.printer import Printer
from app.models.printer_group import PrinterGroup
from app.models.user import UserRole
from app.schemas.printer_group import (
    PrinterGroupCreate,
    PrinterGroupOut,
    PrinterGroupReorderItem,
    PrinterGroupUpdate,
)

router = APIRouter(prefix="/printer-groups", tags=["printer-groups"])


def _to_dto(group: PrinterGroup, db: Session, org_id: int) -> PrinterGroupOut:
    count = (
        db.query(func.count(Printer.id))
        .filter(Printer.group_id == group.id, Printer.organization_id == org_id)
        .scalar()
        or 0
    )
    return PrinterGroupOut(
        id=group.id,
        name=group.name,
        sort_order=group.sort_order,
        printer_count=count,
    )


@router.get("", response_model=list[PrinterGroupOut])
def list_groups(
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[PrinterGroupOut]:
    groups = (
        db.query(PrinterGroup)
        .filter(PrinterGroup.organization_id == org.id)
        .order_by(PrinterGroup.sort_order, PrinterGroup.name)
        .all()
    )
    return [_to_dto(g, db, org.id) for g in groups]


@router.post("", response_model=PrinterGroupOut, status_code=status.HTTP_201_CREATED)
def create_group(
    payload: PrinterGroupCreate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user=Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> PrinterGroupOut:
    max_order = (
        db.query(func.max(PrinterGroup.sort_order))
        .filter(PrinterGroup.organization_id == org.id)
        .scalar()
        or 0
    )
    group = PrinterGroup(organization_id=org.id, name=payload.name.strip(), sort_order=max_order + 1)
    db.add(group)
    db.commit()
    db.refresh(group)
    return _to_dto(group, db, org.id)


@router.patch("/{group_id}", response_model=PrinterGroupOut)
def update_group(
    group_id: int,
    payload: PrinterGroupUpdate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user=Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> PrinterGroupOut:
    group = db.query(PrinterGroup).filter(PrinterGroup.id == group_id, PrinterGroup.organization_id == org.id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    if payload.name is not None:
        group.name = payload.name.strip()
    db.commit()
    db.refresh(group)
    return _to_dto(group, db, org.id)


@router.delete("/{group_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_group(
    group_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user=Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> None:
    group = db.query(PrinterGroup).filter(PrinterGroup.id == group_id, PrinterGroup.organization_id == org.id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    db.delete(group)
    db.commit()


@router.post("/reorder", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def reorder_groups(
    items: list[PrinterGroupReorderItem],
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user=Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> None:
    for item in items:
        group = db.query(PrinterGroup).filter(PrinterGroup.id == item.id, PrinterGroup.organization_id == org.id).first()
        if group:
            group.sort_order = item.sort_order
    db.commit()
