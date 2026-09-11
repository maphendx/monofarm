"""Warehouse label-template and bank-account settings endpoints."""
from decimal import Decimal


from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles, require_warehouse_full
from app.core.db import get_db
from app.models.organization import Organization
from app.models.user import User, UserRole
from app.models.warehouse import (
    BankAccount, BankAccountStatus,
    LabelTemplate,
)
from app.services.label_templates import BUILTIN_TEMPLATES
from app.schemas.warehouse import (
    BankAccountCreate, BankAccountOut, BankAccountUpdate, LabelTemplateCreate,
    LabelTemplateOut, LabelTemplateUpdate,
)

public_router = APIRouter(tags=["warehouse"])

# All routes that require Starter plan or above (full warehouse access).
# Free plan can only access /products and /categories.
full_router = APIRouter(dependencies=[Depends(require_warehouse_full)])

@full_router.get("/label-templates", response_model=list[LabelTemplateOut])
def list_label_templates(
    item_type: str | None = None,
    org=Depends(get_current_org),
    db: Session = Depends(get_db),
):
    rows = db.query(LabelTemplate).filter(LabelTemplate.organization_id == org.id).all()
    custom = [
        LabelTemplateOut(
            id=r.id, name=r.name, item_type=r.item_type,
            width_mm=float(r.width_mm), height_mm=float(r.height_mm),
            elements=r.elements, is_default=r.is_default, is_builtin=False,
        )
        for r in rows
    ]
    builtins = [
        LabelTemplateOut(**{**t, "is_default": False, "is_builtin": True})
        for t in BUILTIN_TEMPLATES
        if not item_type or t["item_type"] in (item_type, "universal")
    ]
    result = builtins + custom
    if item_type:
        result = [t for t in result if t.item_type in (item_type, "universal")]
    return result


@full_router.post("/label-templates", response_model=LabelTemplateOut, status_code=201)
def create_label_template(
    body: LabelTemplateCreate,
    org=Depends(get_current_org),
    db: Session = Depends(get_db),
):
    tpl = LabelTemplate(
        organization_id=org.id,
        name=body.name, item_type=body.item_type,
        width_mm=body.width_mm, height_mm=body.height_mm,
        elements=body.elements, is_default=body.is_default,
    )
    db.add(tpl)
    db.commit()
    db.refresh(tpl)
    return LabelTemplateOut(
        id=tpl.id, name=tpl.name, item_type=tpl.item_type,
        width_mm=float(tpl.width_mm), height_mm=float(tpl.height_mm),
        elements=tpl.elements, is_default=tpl.is_default, is_builtin=False,
    )


@full_router.put("/label-templates/{tpl_id}", response_model=LabelTemplateOut)
def update_label_template(
    tpl_id: int,
    body: LabelTemplateUpdate,
    org=Depends(get_current_org),
    db: Session = Depends(get_db),
):
    tpl = db.query(LabelTemplate).filter(
        LabelTemplate.id == tpl_id, LabelTemplate.organization_id == org.id
    ).first()
    if not tpl:
        raise HTTPException(404, "Template not found")
    if body.name is not None:
        tpl.name = body.name
    if body.item_type is not None:
        tpl.item_type = body.item_type
    if body.width_mm is not None:
        tpl.width_mm = body.width_mm
    if body.height_mm is not None:
        tpl.height_mm = body.height_mm
    if body.elements is not None:
        tpl.elements = body.elements
    if body.is_default is not None:
        tpl.is_default = body.is_default
    db.commit()
    db.refresh(tpl)
    return LabelTemplateOut(
        id=tpl.id, name=tpl.name, item_type=tpl.item_type,
        width_mm=float(tpl.width_mm), height_mm=float(tpl.height_mm),
        elements=tpl.elements, is_default=tpl.is_default, is_builtin=False,
    )


@full_router.delete("/label-templates/{tpl_id}", status_code=204)
def delete_label_template(
    tpl_id: int,
    org=Depends(get_current_org),
    db: Session = Depends(get_db),
):
    tpl = db.query(LabelTemplate).filter(
        LabelTemplate.id == tpl_id, LabelTemplate.organization_id == org.id
    ).first()
    if not tpl:
        raise HTTPException(404, "Template not found")
    db.delete(tpl)
    db.commit()


# ── Bank Accounts ─────────────────────────────────────────────────────────────

@full_router.get("/bank-accounts", response_model=list[BankAccountOut])
def list_bank_accounts(
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[BankAccountOut]:
    rows = (
        db.query(BankAccount)
        .filter_by(organization_id=org.id)
        .order_by(BankAccount.sort_order, BankAccount.id)
        .all()
    )
    return [BankAccountOut.model_validate(r) for r in rows]


@full_router.post("/bank-accounts", response_model=BankAccountOut, status_code=status.HTTP_201_CREATED)
def create_bank_account(
    payload: BankAccountCreate,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> BankAccountOut:
    ba = BankAccount(
        organization_id=org.id,
        name=payload.name,
        balance=payload.initial_balance,
        initial_balance=payload.initial_balance,
        initial_balance_date=payload.initial_balance_date,
        sort_order=payload.sort_order,
    )
    db.add(ba)
    db.commit()
    db.refresh(ba)
    return BankAccountOut.model_validate(ba)


@full_router.patch("/bank-accounts/{ba_id}", response_model=BankAccountOut)
def update_bank_account(
    ba_id:   int,
    payload: BankAccountUpdate,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> BankAccountOut:
    ba = db.query(BankAccount).filter_by(id=ba_id, organization_id=org.id).first()
    if not ba:
        raise HTTPException(status_code=404, detail="Bank account not found")
    if payload.name is not None:
        ba.name = payload.name
    if payload.status is not None:
        ba.status = BankAccountStatus(payload.status)
    if payload.sort_order is not None:
        ba.sort_order = payload.sort_order
    db.commit()
    db.refresh(ba)
    return BankAccountOut.model_validate(ba)


@full_router.delete("/bank-accounts/{ba_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_bank_account(
    ba_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin)),
) -> None:
    ba = db.query(BankAccount).filter_by(id=ba_id, organization_id=org.id).first()
    if not ba:
        raise HTTPException(status_code=404, detail="Bank account not found")
    if abs(ba.balance) > Decimal("0"):
        raise HTTPException(status_code=422, detail="Не можна видалити рахунок з ненульовим балансом")
    db.delete(ba)
    db.commit()
