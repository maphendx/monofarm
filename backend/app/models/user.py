import enum
from datetime import datetime

from sqlalchemy import BigInteger, CheckConstraint, DateTime, Enum, ForeignKey, Integer, JSON, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class UserRole(str, enum.Enum):
    admin = "admin"
    operator = "operator"
    manager = "manager"


class CustomRole(Base):
    """Named role template per org.
    Assigning a CustomRole to a user overrides their individual allowed_modules.
    Changing the role propagates to all users with that role on the next request.
    """
    __tablename__ = "org_custom_roles"

    id:              Mapped[int]          = mapped_column(primary_key=True)
    organization_id: Mapped[int]          = mapped_column(Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    name:            Mapped[str]          = mapped_column(String(80), nullable=False)
    allowed_modules: Mapped[list[str]]    = mapped_column(JSON, nullable=False, default=list)
    created_at:      Mapped[datetime]     = mapped_column(DateTime(timezone=True), server_default=func.now())


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("role = 'admin' OR organization_id IS NOT NULL", name="ck_users_non_admin_requires_org"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=True, index=True
    )
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    name: Mapped[str] = mapped_column(String(120), default="")
    role: Mapped[UserRole] = mapped_column(Enum(UserRole), default=UserRole.operator)
    is_active: Mapped[bool] = mapped_column(default=True)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    telegram_chat_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True, unique=True, index=True)
    telegram_link_code: Mapped[str | None] = mapped_column(String(64), nullable=True, unique=True, index=True)
    telegram_link_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # null = unrestricted (all modules); list = explicit allowlist.
    # Admins always have full access regardless of this field.
    allowed_modules: Mapped[list[str] | None] = mapped_column(JSON, nullable=True, default=None)

    # If set, overrides allowed_modules — effective modules come from the CustomRole.
    custom_role_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("org_custom_roles.id", ondelete="SET NULL"), nullable=True, index=True
    )


def is_platform_admin(user: User) -> bool:
    """Transitional admin bridge: global operators are admin users without an org."""
    return user.role == UserRole.admin and user.organization_id is None


def is_tenant_admin(user: User) -> bool:
    """Transitional admin bridge: existing org admins stay tenant-scoped."""
    return user.role == UserRole.admin and user.organization_id is not None
