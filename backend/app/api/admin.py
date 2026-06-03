from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin
from app.core.db import get_db
from app.models.organization import OrgPlan
from app.models.user import User
from app.schemas.admin import (
    AdminImpersonationOut,
    AdminImpersonationRequest,
    AdminOrganizationDetailOut,
    AdminOrganizationsOut,
    AdminOverviewOut,
)
from app.services import admin_service


router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/overview", response_model=AdminOverviewOut)
def overview(
    _admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> AdminOverviewOut:
    return admin_service.get_overview(db)


@router.get("/orgs", response_model=AdminOrganizationsOut)
def orgs(
    search: str | None = None,
    plan: OrgPlan | None = None,
    status_filter: str | None = Query(default=None, alias="status"),
    sort: str = "-created_at",
    limit: int = Query(default=25, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    _admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> AdminOrganizationsOut:
    return admin_service.list_organizations(
        db,
        search=search,
        plan=plan,
        status_filter=status_filter,
        sort=sort,
        limit=limit,
        offset=offset,
    )


@router.get("/orgs/{org_id}", response_model=AdminOrganizationDetailOut)
def org_detail(
    org_id: int,
    _admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> AdminOrganizationDetailOut:
    return admin_service.get_organization(db, org_id)


@router.post("/impersonation", response_model=AdminImpersonationOut)
def start_impersonation(
    payload: AdminImpersonationRequest,
    _admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
) -> AdminImpersonationOut:
    return admin_service.start_impersonation(db, org_id=payload.organization_id)


@router.delete("/impersonation", status_code=status.HTTP_200_OK)
def stop_impersonation(
    _admin: User = Depends(get_current_admin),
) -> dict:
    return admin_service.stop_impersonation()
