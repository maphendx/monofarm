from datetime import datetime

from pydantic import BaseModel, EmailStr, Field

from app.models.organization import OrgPlan
from app.models.user import UserRole


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str = Field(min_length=8, max_length=128)


class UserOut(BaseModel):
    id: int
    email: EmailStr
    name: str
    role: UserRole
    organization_id: int | None = None
    org_plan: OrgPlan | None = None
    is_platform_admin: bool = False
    created_at: datetime
    email_verified_at: datetime | None = None
    telegram_chat_id: int | None = None

    class Config:
        from_attributes = True
