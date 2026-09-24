from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base


class GcodeFileOutput(Base):
    """Operator-configured production output of one file: products per run.

    One file may produce several products (mixed plate), and one product may
    be produced by several files. Quantities are operator-declared — never
    inferred from slicer object counts. The frozen per-run snapshot for a
    dispatched print lives on ``BambuCloudJob.output_plan``.
    """

    __tablename__ = "gcode_file_outputs"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    gcode_file_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("gcode_files.id", ondelete="CASCADE"), nullable=False, index=True
    )
    product_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("wh_products.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    # Finished units of this product produced by one run of the file.
    qty_per_run: Mapped[int] = mapped_column(Integer, nullable=False)
    # Slicer plate number (1-based, as in 3MF Metadata/plate_N.gcode); NULL = any plate.
    plate: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    product = relationship("Product", lazy="selectin")

    __table_args__ = (
        Index(
            "uq_gcode_file_outputs", "gcode_file_id", "product_id", "plate",
            unique=True, postgresql_nulls_not_distinct=True,
        ),
    )
