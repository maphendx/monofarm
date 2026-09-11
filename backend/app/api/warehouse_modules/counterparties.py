"""Supplier and customer counterparty endpoints."""


from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles, require_warehouse_full
from app.core.db import get_db
from app.models.organization import Organization
from app.models.user import User, UserRole
from app.models.warehouse import (
    Counterparty, Order,
)
from app.schemas.warehouse import (
    CounterpartyBalanceAdjust, CounterpartyCreate,
    CounterpartyOut, CounterpartyUpdate,
)

public_router = APIRouter(tags=["warehouse"])

# All routes that require Starter plan or above (full warehouse access).
# Free plan can only access /products and /categories.
full_router = APIRouter(dependencies=[Depends(require_warehouse_full)])

from app.api.warehouse_modules.common import (_get_counterparty)
from app.api.warehouse_modules.pagination import DEFAULT_PAGE_SIZE, PageLimit, PageOffset

# ── Counterparties ────────────────────────────────────────────────────────────

@full_router.get("/counterparties", response_model=list[CounterpartyOut])
def list_counterparties(
    cp_type: str | None = Query(None, alias="type"),
    search:  str | None = Query(None),
    skip: PageOffset = 0,
    limit: PageLimit = DEFAULT_PAGE_SIZE,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[CounterpartyOut]:
    q = db.query(Counterparty).filter(Counterparty.organization_id == org.id)
    if cp_type:
        q = q.filter(Counterparty.type == cp_type)
    if search:
        q = q.filter(Counterparty.name.ilike(f"%{search}%") | Counterparty.email.ilike(f"%{search}%"))
    rows = q.order_by(Counterparty.name, Counterparty.id).offset(skip).limit(limit).all()
    return [CounterpartyOut.model_validate(r) for r in rows]


@full_router.post("/counterparties", response_model=CounterpartyOut, status_code=status.HTTP_201_CREATED)
def create_counterparty(
    payload: CounterpartyCreate,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    _:    User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> CounterpartyOut:
    cp = Counterparty(**payload.model_dump(), organization_id=org.id)
    db.add(cp)
    db.commit()
    db.refresh(cp)
    return CounterpartyOut.model_validate(cp)


@full_router.get("/counterparties/{cp_id}", response_model=CounterpartyOut)
def get_counterparty(
    cp_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> CounterpartyOut:
    return CounterpartyOut.model_validate(_get_counterparty(cp_id, org, db))


@full_router.patch("/counterparties/{cp_id}", response_model=CounterpartyOut)
def update_counterparty(
    cp_id:   int,
    payload: CounterpartyUpdate,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> CounterpartyOut:
    cp = _get_counterparty(cp_id, org, db)
    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(cp, k, v)
    db.commit()
    db.refresh(cp)
    return CounterpartyOut.model_validate(cp)


@full_router.delete("/counterparties/{cp_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_counterparty(
    cp_id: int,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin)),
) -> None:
    cp = _get_counterparty(cp_id, org, db)
    # Nullify references before deletion so existing orders are not orphaned
    db.query(Order).filter_by(organization_id=org.id, counterparty_id=cp.id).update({"counterparty_id": None})
    db.delete(cp)
    db.commit()


@full_router.post("/counterparties/{cp_id}/adjust-balance", response_model=CounterpartyOut)
def adjust_balance(
    cp_id:   int,
    payload: CounterpartyBalanceAdjust,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> CounterpartyOut:
    """Manually adjust counterparty balance (record a payment)."""
    cp = _get_counterparty(cp_id, org, db)
    cp.balance -= payload.delta   # delta positive = they paid us → reduces their balance
    db.commit()
    db.refresh(cp)
    return CounterpartyOut.model_validate(cp)
