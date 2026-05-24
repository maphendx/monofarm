import enum
import re
from datetime import datetime

from sqlalchemy import DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


def _slugify(name: str) -> str:
    slug = name.lower().strip()
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    return slug.strip("-")[:60]


class OrgPlan(str, enum.Enum):
    free = "free"
    starter = "starter"
    pro = "pro"
    farm = "farm"


PLAN_LIMITS: dict[OrgPlan, dict[str, int]] = {
    OrgPlan.free:    {"printers": 2,   "users": 1},
    OrgPlan.starter: {"printers": 5,   "users": 3},
    OrgPlan.pro:     {"printers": 15,  "users": 10},
    OrgPlan.farm:    {"printers": 999, "users": 999},
}

PLAN_PRICE_USD: dict[OrgPlan, int] = {
    OrgPlan.free:    0,
    OrgPlan.starter: 19,
    OrgPlan.pro:     49,
    OrgPlan.farm:    99,
}


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

    # Bambu Lab credentials (per-org, stored in DB)
    bambu_email: Mapped[str] = mapped_column(String(255), default="", server_default="")
    bambu_password: Mapped[str] = mapped_column(String(255), default="", server_default="")
    bambu_refresh_token: Mapped[str] = mapped_column(String(512), default="", server_default="")
    bambu_region: Mapped[str] = mapped_column(String(8), default="", server_default="")

    # Telegram bot (per-org, runs in local agent)
    tg_bot_token:    Mapped[str] = mapped_column(String(512), default="", server_default="")  # Fernet-encrypted
    tg_bot_username: Mapped[str] = mapped_column(String(64),  default="", server_default="")  # cached after agent getMe

    # KeyCRM integration
    keycrm_api_key:        Mapped[str] = mapped_column(String(255), default="", server_default="")
    keycrm_webhook_secret: Mapped[str] = mapped_column(String(255), default="", server_default="")
