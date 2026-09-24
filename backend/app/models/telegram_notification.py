"""Durable delivery queue for the existing Telegram notification service."""
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class TelegramNotification(Base):
    __tablename__ = "telegram_notifications"
    __table_args__ = (UniqueConstraint("organization_id", "event_key", name="uq_telegram_notification_event"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    event_key: Mapped[str] = mapped_column(String(80))
    rule: Mapped[str] = mapped_column(String(40))
    payload: Mapped[dict] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(20), default="pending", server_default="pending", index=True)
    sent_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    attempted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
