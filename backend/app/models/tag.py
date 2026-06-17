"""Tag model + junction tables.

Tag.kind values:
  'nozzle'   → meta = {"diameter": 0.4}
  'material' → meta = {"type": "PLA", "color": "#ff0000", "color_name": "Red"}
  'custom'   → label = "maintenance", color = "#e74c3c", meta = null
"""
from __future__ import annotations

import enum
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Integer, String, Table, Column, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base


class TagKind(str, enum.Enum):
    nozzle = "nozzle"
    material = "material"
    bed_type = "bed_type"
    custom = "custom"


# ── Junction tables ──────────────────────────────────────────────────────────────────

printer_tags_table = Table(
    "printer_tags",
    Base.metadata,
    Column("printer_id", Integer, ForeignKey("printers.id", ondelete="CASCADE"), primary_key=True),
    Column("tag_id", Integer, ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
)

gcode_file_tags_table = Table(
    "gcode_file_tags",
    Base.metadata,
    Column("gcode_file_id", Integer, ForeignKey("gcode_files.id", ondelete="CASCADE"), primary_key=True),
    Column("tag_id", Integer, ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
)

print_task_tags_table = Table(
    "print_task_tags",
    Base.metadata,
    Column("print_task_id", Integer, ForeignKey("print_tasks.id", ondelete="CASCADE"), primary_key=True),
    Column("tag_id", Integer, ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
)


# ── Tag model ──────────────────────────────────────────────────────────────────────────

class Tag(Base):
    __tablename__ = "tags"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[TagKind] = mapped_column(String(20), nullable=False)
    # For custom tags: display label (e.g. "maintenance")
    label: Mapped[str | None] = mapped_column(String(80), nullable=True)
    # For custom tags: badge background color (e.g. "#e74c3c")
    color: Mapped[str | None] = mapped_column(String(9), nullable=True)
    # Structured data per kind (see module docstring)
    meta: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # Relationships (back_populates defined on the parent models)
    printers: Mapped[list] = relationship(
        "Printer", secondary=printer_tags_table, back_populates="tags"
    )
    gcode_files: Mapped[list] = relationship(
        "GcodeFile", secondary=gcode_file_tags_table, back_populates="tags"
    )
    print_tasks: Mapped[list] = relationship(
        "PrintTask", secondary=print_task_tags_table, back_populates="tags"
    )

    # ── Helpers ────────────────────────────────────────────────────────────────────

    @property
    def display(self) -> str:
        """Human-readable label for the tag."""
        if self.kind == TagKind.nozzle:
            d = (self.meta or {}).get("diameter", "?")
            return f"Ø{d}mm"
        if self.kind == TagKind.material:
            m = self.meta or {}
            return f"{m.get('type', '?')} · {m.get('color_name', '')}".strip(" ·")
        if self.kind == TagKind.bed_type:
            return (self.meta or {}).get("bed_type", "") or self.label or ""
        return self.label or ""

    @property
    def nozzle_diameter(self) -> float | None:
        if self.kind == TagKind.nozzle:
            return float((self.meta or {}).get("diameter", 0)) or None
        return None

    @property
    def material_type(self) -> str | None:
        if self.kind == TagKind.material:
            return (self.meta or {}).get("type")
        return None

    @property
    def material_color_name(self) -> str | None:
        if self.kind == TagKind.material:
            return (self.meta or {}).get("color_name")
        return None

    @property
    def bed_type_name(self) -> str | None:
        if self.kind == TagKind.bed_type:
            return (self.meta or {}).get("bed_type")
        return None
