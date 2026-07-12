from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import DateTime, ForeignKey, Integer, String, func

from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base

if TYPE_CHECKING:
    from app.models.tag import Tag


class GcodeFile(Base):
    __tablename__ = "gcode_files"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # UUID-based storage name on disk (prevents collisions/path traversal)
    stored_name: Mapped[str] = mapped_column(String(80), unique=True, nullable=False)
    # Original filename as uploaded by the user
    original_name: Mapped[str] = mapped_column(String(255), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    notes: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # Parsed slicer metadata: {types, colors, used_g, estimated_minutes, total_layers, layer_height}
    filament_meta: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    folder_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("gcode_folders.id", ondelete="SET NULL"), nullable=True, index=True
    )
    uploaded_by_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # Tags
    tags: Mapped[list["Tag"]] = relationship(
        "Tag",
        secondary="gcode_file_tags",
        back_populates="gcode_files",
        lazy="selectin",
    )
