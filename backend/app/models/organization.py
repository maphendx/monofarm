import enum
import re
from datetime import datetime
from decimal import Decimal

from sqlalchemy import Boolean, DateTime, Enum, Integer, Numeric, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


def _slugify(name: str) -> str:
    slug = name.lower().strip()
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    return slug.strip("-")[:60]


class BambuAuthType(str, enum.Enum):
    password = "password"
    email_code = "email_code"
    oauth_like = "oauth_like"


class OrgPlan(str, enum.Enum):
    free = "free"
    starter = "starter"
    pro = "pro"
    farm = "farm"


PLAN_LIMITS: dict[OrgPlan, dict[str, int]] = {
    OrgPlan.free:    {"printers": 2,  "users": 1},
    OrgPlan.starter: {"printers": 5,  "users": 3},
    OrgPlan.pro:     {"printers": 10, "users": 10},
    OrgPlan.farm:    {"printers": 20, "users": 999},
}

# None = unlimited
WAREHOUSE_PRODUCT_LIMIT: dict[OrgPlan, int | None] = {
    OrgPlan.free:    100,
    OrgPlan.starter: 200,
    OrgPlan.pro:     1000,
    OrgPlan.farm:    None,
}

# Plans with full warehouse access (all modules: stock, orders, batches, etc.)
WAREHOUSE_FULL_PLANS = {OrgPlan.starter, OrgPlan.pro, OrgPlan.farm}

# Hard cap — max printers even with extra slots (None = unlimited)
PLAN_MAX_PRINTERS: dict[OrgPlan, int | None] = {
    OrgPlan.free:    2,
    OrgPlan.starter: 5,
    OrgPlan.pro:     15,
    OrgPlan.farm:    None,
}

# USD per extra printer slot per month (only allowed on pro/farm)
EXTRA_PRINTER_PRICE_USD: dict[OrgPlan, int | None] = {
    OrgPlan.free:    None,
    OrgPlan.starter: None,
    OrgPlan.pro:     2,
    OrgPlan.farm:    2,
}

PLAN_PRICE_USD: dict[OrgPlan, int] = {
    OrgPlan.free:    0,
    OrgPlan.starter: 12,
    OrgPlan.pro:     29,
    OrgPlan.farm:    69,
}

# Annual billing: pay yearly, save 20% vs 12× monthly.
YEARLY_DISCOUNT_PCT = 20


def yearly_price_usd(plan: OrgPlan) -> int:
    """Annual price = 12 months − discount, rounded to whole USD."""
    return round(PLAN_PRICE_USD[plan] * 12 * (100 - YEARLY_DISCOUNT_PCT) / 100)


class Organization(Base):
    __tablename__ = "organizations"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    slug: Mapped[str] = mapped_column(String(60), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # Subscription
    plan: Mapped[OrgPlan] = mapped_column(default=OrgPlan.free, server_default="free")
    payment_customer_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    payment_subscription_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    plan_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    extra_printer_slots: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    # Bambu Lab credentials (per-org, stored in DB)
    bambu_email: Mapped[str] = mapped_column(String(255), default="", server_default="")
    bambu_password: Mapped[str] = mapped_column(String(255), default="", server_default="")
    bambu_refresh_token: Mapped[str] = mapped_column(String(512), default="", server_default="")
    bambu_region: Mapped[str] = mapped_column(String(8), default="", server_default="")

    # Bambu Cloud auth lifecycle (encrypted token fields, populated by bambu_auth service)
    bambu_access_token: Mapped[str] = mapped_column(String(2048), default="", server_default="")
    bambu_access_token_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    bambu_auth_type: Mapped[BambuAuthType | None] = mapped_column(Enum(BambuAuthType), nullable=True)
    bambu_user_id: Mapped[str] = mapped_column(String(64), default="", server_default="")
    bambu_last_auth_success_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    bambu_last_auth_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    bambu_reauth_required: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")

    # Telegram bot (per-org, runs in local agent)
    tg_bot_token:    Mapped[str] = mapped_column(String(512), default="", server_default="")  # Fernet-encrypted
    tg_bot_username: Mapped[str] = mapped_column(String(64),  default="", server_default="")  # cached after agent getMe

    # Ready-made notification rules (work without the workflow engine).
    # Delivered through the org's existing Telegram bot connection.
    notify_print_failed: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true", nullable=False)
    notify_filament_low: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true", nullable=False)

    # Pre-flight material validation (validation only, never the accounting math).
    filament_safety_margin_pct: Mapped[int] = mapped_column(Integer, default=5, server_default="5", nullable=False)
    preflight_block_dispatch: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false", nullable=False)

    # Experimental workflow editor. New orgs start disabled; an admin can turn
    # it on deliberately. Already-enabled automations keep executing while the
    # flag is off — hiding the UI must not silently stop live processes.
    workflows_enabled: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false", nullable=False)

    # KeyCRM integration
    keycrm_api_key:        Mapped[str] = mapped_column(String(255), default="", server_default="")
    keycrm_webhook_secret: Mapped[str] = mapped_column(String(255), default="", server_default="")

    # Horoshop integration
    horoshop_domain:         Mapped[str] = mapped_column(String(255), default="", server_default="")
    horoshop_login:          Mapped[str] = mapped_column(String(255), default="", server_default="")
    horoshop_password:       Mapped[str] = mapped_column(String(512), default="", server_default="")  # Fernet-encrypted
    horoshop_webhook_secret: Mapped[str] = mapped_column(String(255), default="", server_default="")
    horoshop_verify_ssl:     Mapped[bool] = mapped_column(Boolean, default=True, server_default="true", nullable=False)
    horoshop_hook_ids:       Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    horoshop_last_sync_at:   Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Tag settings (auto-tag, clusters, matching behaviour)
    tag_settings: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")

    # Costing rates for spec cost calculations
    electricity_rate: Mapped[Decimal] = mapped_column(Numeric(8, 4), default=Decimal("4.5"), server_default="4.5")
    labor_rate:       Mapped[Decimal] = mapped_column(Numeric(8, 4), default=Decimal("150"), server_default="150")
