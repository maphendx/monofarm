from decimal import Decimal

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class OrgRegisterRequest(BaseModel):
    org_name: str = Field(..., min_length=2, max_length=120)
    admin_name: str = Field(..., min_length=1, max_length=120)
    admin_email: EmailStr
    admin_password: str = Field(..., min_length=8)


class OrgOut(BaseModel):
    id: int
    name: str
    slug: str

    model_config = ConfigDict(from_attributes=True)


class OrgSettingsUpdate(BaseModel):
    name: str | None = Field(None, min_length=2, max_length=120)
    bambu_email: str | None = None
    bambu_password: str | None = None
    bambu_refresh_token: str | None = None
    bambu_region: str | None = None
    tg_bot_token: str | None = None
    electricity_rate: Decimal | None = None
    labor_rate: Decimal | None = None
    notify_print_failed: bool | None = None
    notify_filament_low: bool | None = None
    workflows_enabled: bool | None = None
    filament_safety_margin_pct: int | None = Field(default=None, ge=0, le=100)
    preflight_block_dispatch: bool | None = None


class OrgSettingsOut(BaseModel):
    id: int
    name: str
    slug: str
    bambu_email: str
    bambu_region: str
    bambu_configured: bool
    tg_configured: bool
    tg_bot_username: str | None
    electricity_rate: Decimal
    labor_rate: Decimal
    notify_print_failed: bool
    notify_filament_low: bool
    workflows_enabled: bool
    filament_safety_margin_pct: int
    preflight_block_dispatch: bool
    has_workflows: bool = False
    notification_workflows: dict[str, list[str]] = Field(default_factory=dict)
    telegram_linked_users: int = 0

    model_config = ConfigDict(from_attributes=True)
