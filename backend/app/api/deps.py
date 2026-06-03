from datetime import datetime

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.security import decode_token
from app.models.organization import OrgPlan, Organization, WAREHOUSE_FULL_PLANS
from app.models.user import User, UserRole


bearer_scheme = HTTPBearer(auto_error=False)


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
    return user


def get_current_org(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Organization:
    org = db.get(Organization, user.organization_id)
    if not org:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Organization not found")
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
        if user.role not in roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
        return user

    return checker


def require_module(module: str):
    """Block access to a module if the user has an explicit allowlist that excludes it.
    Admins always pass. null allowed_modules = unrestricted.
    """
    def checker(user: User = Depends(get_current_user)) -> User:
        if user.role == UserRole.admin:
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
