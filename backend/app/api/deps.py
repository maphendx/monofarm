from datetime import datetime

from fastapi import Depends, Header, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.security import decode_token
from app.models.organization import OrgPlan, Organization, WAREHOUSE_FULL_PLANS
from app.models.user import User, UserRole, is_platform_admin, is_tenant_admin


bearer_scheme = HTTPBearer(auto_error=False)
SAFE_IMPERSONATION_METHODS = {"GET", "HEAD", "OPTIONS"}


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    if credentials is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    payload = decode_token(credentials.credentials)
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    user = db.get(User, int(user_id))
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User inactive")
    # If a custom role is set, override allowed_modules from the role (in-memory only)
    if user.custom_role_id and not (is_platform_admin(user) or is_tenant_admin(user)):
        from app.models.user import CustomRole
        cr = db.get(CustomRole, user.custom_role_id)
        if cr:
            user.allowed_modules = cr.allowed_modules
    return user


def get_current_admin(user: User = Depends(get_current_user)) -> User:
    if not is_platform_admin(user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Platform admin required")
    return user


def get_current_org_user(user: User = Depends(get_current_user)) -> User:
    if user.organization_id is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Organization context required")
    return user


def get_effective_org(
    request: Request,
    impersonated_org_id: int | None = Header(default=None, alias="X-Impersonated-Org-Id"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Organization:
    if impersonated_org_id is not None:
        if not is_platform_admin(user):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Impersonation requires platform admin")
        if request.method.upper() not in SAFE_IMPERSONATION_METHODS:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Impersonation is read-only")
        org = db.get(Organization, impersonated_org_id)
        if not org:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Organization not found")
        return _refresh_org_plan_if_needed(org, db)

    if user.organization_id is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Organization context required")
    org = db.get(Organization, user.organization_id)
    if not org:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Organization not found")
    return _refresh_org_plan_if_needed(org, db)


def get_current_org(org: Organization = Depends(get_effective_org)) -> Organization:
    return org


def _refresh_org_plan_if_needed(org: Organization, db: Session) -> Organization:
    if org.plan != OrgPlan.free and org.plan_expires_at:
        expires = org.plan_expires_at.replace(tzinfo=None) if org.plan_expires_at.tzinfo else org.plan_expires_at
        if expires < datetime.utcnow():
            org.plan = OrgPlan.free
            _enforce_printer_limit(org, db)
            db.commit()
    return org


def printer_limit(org: Organization) -> int:
    """Effective printer limit = base plan limit + purchased extra slots."""
    from app.models.organization import PLAN_LIMITS
    return PLAN_LIMITS[org.plan]["printers"] + (org.extra_printer_slots or 0)


def _enforce_printer_limit(org: Organization, db: Session) -> None:
    from app.models.printer import Printer
    limit = printer_limit(org)
    active = (
        db.query(Printer)
        .filter(Printer.organization_id == org.id, Printer.is_active.is_(True))
        .order_by(Printer.id.asc())
        .all()
    )
    for p in active[limit:]:
        p.is_active = False


def require_roles(*roles: UserRole):
    def checker(user: User = Depends(get_current_user)) -> User:
        if user.organization_id is None:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Organization context required")
        if user.role not in roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
        return user

    return checker


def require_module(module: str):
    """Block access to a module if the user has an explicit allowlist that excludes it.
    Admins always pass. null allowed_modules = unrestricted.
    """
    def checker(user: User = Depends(get_current_user)) -> User:
        if user.organization_id is None:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Organization context required")
        if is_tenant_admin(user):
            return user
        if user.allowed_modules is None:
            return user
        if module not in user.allowed_modules:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Доступ до модуля «{module}» не дозволено",
            )
        return user
    return checker


def require_warehouse_full(org: Organization = Depends(get_current_org)) -> Organization:
    """Blocks free-plan orgs from full warehouse access (stock, orders, batches, etc.)."""
    if org.plan not in WAREHOUSE_FULL_PLANS:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Повний доступ до складу потребує тарифу Starter або вище",
        )
    return org
