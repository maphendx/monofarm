from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles
from app.core.db import get_db
from app.core.security import hash_password
from app.models.organization import PLAN_LIMITS, Organization
from app.models.user import User, UserRole
from app.schemas.user import UserAdminOut, UserCreate, UserUpdate
from app.services import telegram_bot


class TelegramLinkOut(BaseModel):
    code: str
    bot_username: str | None
    deep_link: str | None
    expires_at: str


router = APIRouter(prefix="/users", tags=["users"])


@router.get("", response_model=list[UserAdminOut])
def list_users(
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _admin: User = Depends(require_roles(UserRole.admin)),
) -> list[User]:
    return db.query(User).filter(User.organization_id == org.id).order_by(User.created_at).all()


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
    user = User(
        organization_id=org.id,
        email=payload.email,
        password_hash=hash_password(payload.password),
        name=payload.name,
        role=payload.role,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
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
