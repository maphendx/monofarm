from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, status
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.models.organization import OrgPlan, Organization
from app.models.print_history import PrintHistory
from app.models.printer import Printer
from app.models.task import FarmTask, PrintTask
from app.models.user import User
from app.schemas.admin import (
    AdminImpersonationOut,
    AdminOrganizationDetailOut,
    AdminOrganizationListItem,
    AdminOrganizationsOut,
    AdminOverviewOut,
    PaginationOut,
)


def get_overview(db: Session) -> AdminOverviewOut:
    cutoff_24h = datetime.now(timezone.utc) - timedelta(hours=24)
    cutoff_7d = datetime.now(timezone.utc) - timedelta(days=7)
    organizations_total = db.query(Organization.id).count()
    users_total = db.query(User.id).count()
    printers_total = db.query(Printer.id).count()
    printers_active_24h = db.query(Printer.id).filter(Printer.manual_updated_at >= cutoff_24h).count()
    organizations_new_7d = db.query(Organization.id).filter(Organization.created_at >= cutoff_7d).count()
    free_organizations = db.query(Organization.id).filter(Organization.plan == OrgPlan.free).count()
    return AdminOverviewOut(
        organizations_total=organizations_total,
        users_total=users_total,
        printers_total=printers_total,
        printers_active_24h=printers_active_24h,
        organizations_new_7d=organizations_new_7d,
        paid_organizations=organizations_total - free_organizations,
        free_organizations=free_organizations,
    )


def list_organizations(
    db: Session,
    *,
    search: str | None,
    plan: OrgPlan | None,
    status_filter: str | None,
    sort: str,
    limit: int,
    offset: int,
) -> AdminOrganizationsOut:
    if status_filter and status_filter != "active":
        return AdminOrganizationsOut(items=[], pagination=PaginationOut(total=0, limit=limit, offset=offset))

    query = db.query(Organization)
    if search:
        needle = f"%{search.strip()}%"
        query = query.filter(or_(Organization.name.ilike(needle), Organization.slug.ilike(needle)))
    if plan:
        query = query.filter(Organization.plan == plan)

    total = query.count()
    sort_map = {
        "name": Organization.name.asc(),
        "-name": Organization.name.desc(),
        "created_at": Organization.created_at.asc(),
        "-created_at": Organization.created_at.desc(),
        "plan": Organization.plan.asc(),
        "-plan": Organization.plan.desc(),
    }
    rows = query.order_by(sort_map.get(sort, Organization.created_at.desc())).offset(offset).limit(limit).all()
    return AdminOrganizationsOut(
        items=[_org_list_item(db, org) for org in rows],
        pagination=PaginationOut(total=total, limit=limit, offset=offset),
    )


def get_organization(db: Session, org_id: int) -> AdminOrganizationDetailOut:
    org = _get_org_or_404(db, org_id)
    item = _org_list_item(db, org)
    return AdminOrganizationDetailOut(
        **item.model_dump(),
        payment_customer_id=org.payment_customer_id,
        payment_subscription_id=org.payment_subscription_id,
        plan_expires_at=org.plan_expires_at,
        extra_printer_slots=org.extra_printer_slots,
    )


def start_impersonation(db: Session, *, org_id: int) -> AdminImpersonationOut:
    org = _get_org_or_404(db, org_id)
    return AdminImpersonationOut(organization_id=org.id, organization_name=org.name, organization_slug=org.slug)


def stop_impersonation() -> dict:
    return {"ok": True}


def _org_list_item(db: Session, org: Organization) -> AdminOrganizationListItem:
    user_count = db.query(User.id).filter(User.organization_id == org.id).count()
    printer_count = db.query(Printer.id).filter(Printer.organization_id == org.id).count()
    active_printer_count = (
        db.query(Printer.id).filter(Printer.organization_id == org.id, Printer.is_active.is_(True)).count()
    )
    last_login_at = db.query(func.max(User.last_login_at)).filter(User.organization_id == org.id).scalar()
    return AdminOrganizationListItem(
        id=org.id,
        name=org.name,
        slug=org.slug,
        plan=org.plan,
        status="active",
        created_at=org.created_at,
        user_count=user_count,
        printer_count=printer_count,
        active_printer_count=active_printer_count,
        last_login_at=last_login_at,
        last_activity_at=_last_activity_at(db, org.id),
    )


def _last_activity_at(db: Session, org_id: int) -> datetime | None:
    values = [
        db.query(func.max(User.last_login_at)).filter(User.organization_id == org_id).scalar(),
        db.query(func.max(Printer.manual_updated_at)).filter(Printer.organization_id == org_id).scalar(),
        db.query(func.max(PrintTask.created_at)).filter(PrintTask.organization_id == org_id).scalar(),
        db.query(func.max(FarmTask.created_at)).filter(FarmTask.organization_id == org_id).scalar(),
        db.query(func.max(PrintHistory.finished_at)).filter(PrintHistory.organization_id == org_id).scalar(),
        db.query(func.max(PrintHistory.started_at)).filter(PrintHistory.organization_id == org_id).scalar(),
    ]
    present = [value for value in values if value is not None]
    return max(present) if present else None


def _get_org_or_404(db: Session, org_id: int) -> Organization:
    org = db.get(Organization, org_id)
    if not org:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Organization not found")
    return org
