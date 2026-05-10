from datetime import datetime

from pydantic import BaseModel, Field


class FilamentCreate(BaseModel):
    material: str
    color: str
    brand: str | None = None
    grams_remaining: int = 0
    min_grams: int = 0
    note: str | None = None


class FilamentUpdate(BaseModel):
    material: str | None = None
    color: str | None = None
    brand: str | None = None
    grams_remaining: int | None = None
    min_grams: int | None = None
    note: str | None = None


class FilamentAdjust(BaseModel):
    """Add or remove grams. Positive = add, negative = consume."""
    delta_grams: int = Field(..., description="Грами +/-")
    reason: str | None = None


class FilamentOut(BaseModel):
    id: int
    material: str
    color: str
    brand: str | None
    grams_remaining: int
    min_grams: int
    note: str | None
    updated_at: datetime
    is_low: bool

    class Config:
        from_attributes = True
