from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class FilamentReservation(Base):
    """Future demand on a physical spool from a dispatched job.

    Reservations never change ``grams_remaining`` and are not warehouse
    movements — they make queued work visible so two dispatches cannot
    promise the same grams. Availability is always
    ``grams_remaining - sum(active reservations)``.
    """

    __tablename__ = "filament_reservations"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    filament_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("filaments.id", ondelete="CASCADE"), nullable=False, index=True
    )
    job_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("bambu_cloud_jobs.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # Deterministic per (spool, demand unit) — "job:{id}:slot{n}".
    reference: Mapped[str] = mapped_column(String(80), nullable=False)
    reserved_g: Mapped[int] = mapped_column(Integer, nullable=False)
    # active | consumed | released
    status: Mapped[str] = mapped_column(String(16), default="active", server_default="active", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    released_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        Index(
            "uq_filament_reservations_reference", "filament_id", "reference",
            unique=True, postgresql_nulls_not_distinct=True,
            postgresql_where=text("status = 'active'"),
        ),
    )
