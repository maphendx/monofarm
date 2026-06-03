from datetime import datetime

from pydantic import BaseModel

from app.models.organization import OrgPlan


class PaginationOut(BaseModel):
    total: int
    limit: int
    offset: int


class AdminOverviewOut(BaseModel):
    organizations_total: int
    users_total: int
    printers_total: int
    printers_active_24h: int
    organizations_new_7d: int
    paid_organizations: int
    free_organizations: int


class AdminOrganizationListItem(BaseModel):
    id: int
    name: str
    slug: str
    plan: OrgPlan
    status: str
    created_at: datetime
    user_count: int
    printer_count: int
    active_printer_count: int
    last_login_at: datetime | None = None
    last_activity_at: datetime | None = None


class AdminOrganizationsOut(BaseModel):
    items: list[AdminOrganizationListItem]
    pagination: PaginationOut


class AdminOrganizationDetailOut(AdminOrganizationListItem):
    payment_customer_id: str | None = None
    payment_subscription_id: str | None = None
    plan_expires_at: datetime | None = None
    extra_printer_slots: int = 0


class AdminImpersonationRequest(BaseModel):
    organization_id: int


class AdminImpersonationOut(BaseModel):
    organization_id: int
    organization_name: str
    organization_slug: str
