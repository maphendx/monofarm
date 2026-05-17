from pydantic import BaseModel, EmailStr, Field


class OrgRegisterRequest(BaseModel):
    org_name: str = Field(..., min_length=2, max_length=120)
    admin_name: str = Field(..., min_length=1, max_length=120)
    admin_email: EmailStr
    admin_password: str = Field(..., min_length=8)


class OrgOut(BaseModel):
    id: int
    name: str
    slug: str

    class Config:
        from_attributes = True


class OrgSettingsUpdate(BaseModel):
    bambu_email: str | None = None
    bambu_password: str | None = None
    bambu_refresh_token: str | None = None
    bambu_region: str | None = None


class OrgSettingsOut(BaseModel):
    id: int
    name: str
    slug: str
    bambu_email: str
    bambu_region: str
    bambu_configured: bool

    class Config:
        from_attributes = True
