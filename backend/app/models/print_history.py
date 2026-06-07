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
    result_reason: Mapped[str | None] = mapped_column(String(255), nullable=True)
    filament_g: Mapped[float | None]

    # cloud | lan | moonraker | manual
    source: Mapped[str | None] = mapped_column(String(16), nullable=True)
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    file_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)

    bambu_cloud_job_id: Mapped[int | None] = mapped_column(
        ForeignKey("bambu_cloud_jobs.id", ondelete="SET NULL"), nullable=True, index=True
    )
    bambu_task_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    bambu_project_id: Mapped[str | None] = mapped_column(String(64), nullable=True)

    __table_args__ = (
        Index("ix_print_history_org_started", "organization_id", "started_at"),
    )
