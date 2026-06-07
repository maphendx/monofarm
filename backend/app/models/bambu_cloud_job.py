import enum
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, Enum, ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class BambuCloudJobStatus(str, enum.Enum):
    queued = "queued"
    validating = "validating"
    creating_project = "creating_project"
    uploading = "uploading"
    task_creating = "task_creating"
    task_created = "task_created"
    acknowledged = "acknowledged"
    printing = "printing"
    paused = "paused"
    completed = "completed"
    failed = "failed"
    cancelled = "cancelled"
    lost = "lost"


class BambuCloudJob(Base):
    """Tracks the full lifecycle of a single Bambu Cloud print dispatch."""

    __tablename__ = "bambu_cloud_jobs"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    printer_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("printers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    gcode_file_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("gcode_files.id", ondelete="SET NULL"), nullable=True, index=True
    )
    created_by_user_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    printer_bambu_dev_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    file_name: Mapped[str | None] = mapped_column(String(512), nullable=True)
    file_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    file_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    region: Mapped[str | None] = mapped_column(String(8), nullable=True)
    dispatch_mode: Mapped[str] = mapped_column(String(16), default="cloud", server_default="cloud")

    status: Mapped[BambuCloudJobStatus] = mapped_column(
        Enum(BambuCloudJobStatus), default=BambuCloudJobStatus.queued, server_default="queued", nullable=False
    )
    status_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    correlation_id: Mapped[str] = mapped_column(String(64), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)

    bambu_project_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    bambu_model_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    bambu_task_id: Mapped[str | None] = mapped_column(String(64), nullable=True)

    request_payload_json: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    project_response_json: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    task_response_json: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)

    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error_details_json: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    retry_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    progress_pct: Mapped[int | None] = mapped_column(Integer, nullable=True)
    eta_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error_msg: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    uploaded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    task_created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    printer_ack_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    started_printing_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    failed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_mqtt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        Index("ix_bambu_cloud_jobs_org_created", "organization_id", "created_at"),
        Index("ix_bambu_cloud_jobs_printer_status", "printer_id", "status"),
        Index("ix_bambu_cloud_jobs_idempotency_key", "idempotency_key", unique=True),
        Index("ix_bambu_cloud_jobs_correlation_id", "correlation_id", unique=True),
        Index("ix_bambu_cloud_jobs_dev_id_status", "printer_bambu_dev_id", "status"),
    )
