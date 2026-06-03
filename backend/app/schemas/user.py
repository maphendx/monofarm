from datetime import datetime

from pydantic import BaseModel, EmailStr, Field, computed_field

from app.models.user import UserRole


class CustomRoleCreate(BaseModel):
    name: str
    allowed_modules: list[str] = []


class CustomRoleUpdate(BaseModel):
    name: str | None = None
    allowed_modules: list[str] | None = None


class CustomRoleOut(BaseModel):
    id:              int
    name:            str
    allowed_modules: list[str]
    created_at:      datetime

    class Config:
        from_attributes = True


class UserCreate(BaseModel):
    email: EmailStr
    name: str = ""
    role: UserRole = UserRole.operator
    allowed_modules: list[str] | None = None
    custom_role_id: int | None = None


class UserUpdate(BaseModel):
    name: str | None = None
    role: UserRole | None = None
    is_active: bool | None = None
    password: str | None = Field(default=None, min_length=6)
    # Use model_fields_set to distinguish "not sent" from "sent as null"
    allowed_modules: list[str] | None = Field(default=None)
    custom_role_id: int | None = Field(default=None)


class UserAdminOut(BaseModel):
    id: int
    email: EmailStr
    name: str
    role: UserRole
    is_active: bool
    created_at: datetime
    email_verified_at: datetime | None = None
    telegram_chat_id: int | None = None
    allowed_modules: list[str] | None = None
    custom_role_id:  int | None = None
    custom_role_name: str | None = None

    @computed_field
    @property
    def invite_pending(self) -> bool:
        return self.email_verified_at is None

    class Config:
        from_attributes = True
