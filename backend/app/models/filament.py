from datetime import datetime

from sqlalchemy import DateTime, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class Filament(Base):
    __tablename__ = "filaments"

    id: Mapped[int] = mapped_column(primary_key=True)
    material: Mapped[str] = mapped_column(String(40))
    color: Mapped[str] = mapped_column(String(40))
    brand: Mapped[str | None] = mapped_column(String(80), nullable=True)
    grams_remaining: Mapped[int] = mapped_column(Integer, default=0)
    min_grams: Mapped[int] = mapped_column(Integer, default=0)
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
