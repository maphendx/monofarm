from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles
from app.core.config import settings
from app.core.db import get_db
from app.core.security import create_invite_token
from app.models.organization import PLAN_LIMITS, Organization
from app.models.user import CustomRole, User, UserRole
from app.schemas.user import CustomRoleCreate, CustomRoleOut, CustomRoleUpdate, UserAdminOut, UserCreate, UserUpdate
from app.services import email, telegram_bot


class TelegramLinkOut(BaseModel):
    code: str
    bot_username: str | None
    deep_link: str | None
    expires_at: str


router = APIRouter(prefix="/users", tags=["users"])


def _user_out(user: User, db: Session) -> UserAdminOut:
    """Build UserAdminOut with resolved custom_role_name."""
    cr_name: str | None = None
    if user.custom_role_id:
        cr = db.get(CustomRole, user.custom_role_id)
        cr_name = cr.name if cr else None
    return UserAdminOut(
        id=user.id, email=user.email, name=user.name, role=user.role,
        is_active=user.is_active, created_at=user.created_at,
        email_verified_at=user.email_verified_at,
        telegram_chat_id=user.telegram_chat_id,
        allowed_modules=user.allowed_modules,
        custom_role_id=user.custom_role_id,
        custom_role_name=cr_name,
    )


@router.get("", response_model=list[UserAdminOut])
def list_users(
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _admin: User = Depends(require_roles(UserRole.admin)),
) -> list[UserAdminOut]:
    users = db.query(User).filter(User.organization_id == org.id).order_by(User.created_at).all()
    return [_user_out(u, db) for u in users]


@router.post("", response_model=UserAdminOut, status_code=status.HTTP_201_CREATED)
def create_user(
    payload: UserCreate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    admin: User = Depends(require_roles(UserRole.admin)),
) -> User:
    if db.query(User).filter(User.email == payload.email).first():
        raise HTTPException(status_code=400, detail="Користувач з таким email вже існує")
    active_count = db.query(User).filter(
        User.organization_id == org.id, User.is_active == True  # noqa: E712
    ).count()
    limit = PLAN_LIMITS[org.plan]["users"]
    if active_count >= limit:
        raise HTTPException(
            status_code=402,
            detail=f"Ліміт плану «{org.plan.value}»: {limit} активних користувачів. Перейдіть на вищий план.",
        )
    if payload.custom_role_id is not None:
        if not db.query(CustomRole).filter_by(id=payload.custom_role_id, organization_id=org.id).first():
            raise HTTPException(status_code=404, detail="Роль не знайдена")
    user = User(
        organization_id=org.id,
        email=payload.email,
        password_hash="",  # set on accept-invite
        name=payload.name,
        role=payload.role,
        email_verified_at=None,
        allowed_modules=payload.allowed_modules,
        custom_role_id=payload.custom_role_id,
    )
    db.add(user)
    db.flush()
    token = create_invite_token(user.id, org.id)
    invite_url = f"{settings.FARM_PUBLIC_URL}/accept-invite?token={token}"
    email.send_invite(user.email, admin.name or admin.email, org.name, invite_url)
    db.commit()
    db.refresh(user)
    return user


@router.post("/{user_id}/resend-invite", response_model=UserAdminOut)
def resend_invite(
    user_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    admin: User = Depends(require_roles(UserRole.admin)),
) -> User:
    user = db.query(User).filter(User.id == user_id, User.organization_id == org.id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Користувача не знайдено")
    if user.email_verified_at is not None:
        raise HTTPException(status_code=400, detail="Користувач вже прийняв запрошення")
    token = create_invite_token(user.id, org.id)
    invite_url = f"{settings.FARM_PUBLIC_URL}/accept-invite?token={token}"
    email.send_invite(user.email, admin.name or admin.email, org.name, invite_url)
    return user


@router.patch("/{user_id}", response_model=UserAdminOut)
def update_user(
    user_id: int,
    payload: UserUpdate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    admin: User = Depends(require_roles(UserRole.admin)),
) -> User:
    user = db.query(User).filter(User.id == user_id, User.organization_id == org.id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Користувача не знайдено")

    if user.id == admin.id:
        if payload.role is not None and payload.role != UserRole.admin:
            raise HTTPException(status_code=400, detail="Не можна змінити власну роль")
        if payload.is_active is False:
            raise HTTPException(status_code=400, detail="Не можна деактивувати власний акаунт")

    if payload.name is not None:
        user.name = payload.name
    if payload.role is not None:
        user.role = payload.role
    if payload.is_active is not None:
        user.is_active = payload.is_active
    if payload.password:
        user.password_hash = hash_password(payload.password)
    if "allowed_modules" in payload.model_fields_set:
        user.allowed_modules = payload.allowed_modules
    if "custom_role_id" in payload.model_fields_set:
        if payload.custom_role_id is not None:
            if not db.query(CustomRole).filter_by(id=payload.custom_role_id, organization_id=org.id).first():
                raise HTTPException(status_code=404, detail="Роль не знайдена")
        user.custom_role_id = payload.custom_role_id

    db.commit()
    db.refresh(user)
    return user


@router.post("/{user_id}/telegram/link", response_model=TelegramLinkOut)
def generate_telegram_link(
    user_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _admin: User = Depends(require_roles(UserRole.admin)),
) -> TelegramLinkOut:
    user = db.query(User).filter(User.id == user_id, User.organization_id == org.id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Користувача не знайдено")
    code = telegram_bot.generate_link_code(db, user)
    bot_username = telegram_bot.get_bot_username(db, org.id)
    deep_link = f"https://t.me/{bot_username}?start={code}" if bot_username else None
    return TelegramLinkOut(
        code=code,
        bot_username=bot_username,
        deep_link=deep_link,
        expires_at=user.telegram_link_expires_at.isoformat() if user.telegram_link_expires_at else "",
    )


@router.delete("/{user_id}/telegram", response_model=UserAdminOut)
def unlink_telegram(
    user_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _admin: User = Depends(require_roles(UserRole.admin)),
) -> User:
    user = db.query(User).filter(User.id == user_id, User.organization_id == org.id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Користувача не знайдено")
    user.telegram_chat_id = None
    user.telegram_link_code = None
    user.telegram_link_expires_at = None
    db.commit()
    db.refresh(user)
    return user


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    admin: User = Depends(require_roles(UserRole.admin)),
) -> None:
    user = db.query(User).filter(User.id == user_id, User.organization_id == org.id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Користувача не знайдено")
    if user.id == admin.id:
        raise HTTPException(status_code=400, detail="Не можна видалити власний акаунт")
    db.delete(user)
    db.commit()


# ── Custom Roles ──────────────────────────────────────────────────────────────

roles_router = APIRouter(prefix="/roles", tags=["users"])


@roles_router.get("", response_model=list[CustomRoleOut])
def list_roles(
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _admin: User = Depends(require_roles(UserRole.admin)),
) -> list[CustomRole]:
    return db.query(CustomRole).filter_by(organization_id=org.id).order_by(CustomRole.created_at).all()


@roles_router.post("", response_model=CustomRoleOut, status_code=status.HTTP_201_CREATED)
def create_role(
    payload: CustomRoleCreate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _admin: User = Depends(require_roles(UserRole.admin)),
) -> CustomRole:
    cr = CustomRole(organization_id=org.id, name=payload.name, allowed_modules=payload.allowed_modules)
    db.add(cr)
    db.commit()
    db.refresh(cr)
    return cr


@roles_router.patch("/{role_id}", response_model=CustomRoleOut)
def update_role(
    role_id: int,
    payload: CustomRoleUpdate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _admin: User = Depends(require_roles(UserRole.admin)),
) -> CustomRole:
    cr = db.query(CustomRole).filter_by(id=role_id, organization_id=org.id).first()
    if not cr:
        raise HTTPException(status_code=404, detail="Роль не знайдена")
    if payload.name is not None:
        cr.name = payload.name
    if payload.allowed_modules is not None:
        cr.allowed_modules = payload.allowed_modules
    db.commit()
    db.refresh(cr)
    return cr


@roles_router.delete("/{role_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_role(
    role_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _admin: User = Depends(require_roles(UserRole.admin)),
) -> None:
    cr = db.query(CustomRole).filter_by(id=role_id, organization_id=org.id).first()
    if not cr:
        raise HTTPException(status_code=404, detail="Роль не знайдена")
    # unassign from all users
    db.query(User).filter_by(custom_role_id=role_id).update({"custom_role_id": None})
    db.delete(cr)
    db.commit()
