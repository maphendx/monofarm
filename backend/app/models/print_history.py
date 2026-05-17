from datetime import datetime, timezone

from sqlalchemy import ForeignKey, Index, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class PrintHistory(Base):
    __tablename__ = "print_history"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    printer_id: Mapped[int] = mapped_column(ForeignKey("printers.id", ondelete="CASCADE"), nullable=False)
    printer_name: Mapped[str] = mapped_column(String(255), nullable=False)
    file_name: Mapped[str | None] = mapped_column(String(512))
    started_at: Mapped[datetime] = mapped_column(nullable=False, default=lambda: datetime.now(timezone.utc))
    finished_at: Mapped[datetime | None]
    duration_minutes: Mapped[int | None]
    # completed | failed | cancelled | in_progress
    result: Mapped[str] = mapped_column(String(32), nullable=False, default="in_progress")
    filament_g: Mapped[float | None]

    __table_args__ = (
        Index("ix_print_history_org_started", "organization_id", "started_at"),
    )
