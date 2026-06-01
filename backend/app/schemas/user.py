from datetime import datetime

from pydantic import BaseModel, EmailStr, Field, computed_field

from app.models.user import UserRole


class UserCreate(BaseModel):
    email: EmailStr
    name: str = ""
    role: UserRole = UserRole.operator


class UserUpdate(BaseModel):
    name: str | None = None
    role: UserRole | None = None
    is_active: bool | None = None
    password: str | None = Field(default=None, min_length=6)


class UserAdminOut(BaseModel):
    id: int
    email: EmailStr
    name: str
    role: UserRole
    is_active: bool
    created_at: datetime
    email_verified_at: datetime | None = None
    telegram_chat_id: int | None = None

    @computed_field
    @property
    def invite_pending(self) -> bool:
        return self.email_verified_at is None

    class Config:
        from_attributes = True
