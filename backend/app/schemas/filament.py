from datetime import datetime

from pydantic import BaseModel, Field


class FilamentCreate(BaseModel):
    material: str
    color: str
    brand: str | None = None
    grams_remaining: int = 0
    min_grams: int = 0
    cost_per_kg: int | None = None
    note: str | None = None


class FilamentUpdate(BaseModel):
    material: str | None = None
    color: str | None = None
    brand: str | None = None
    grams_remaining: int | None = None
    min_grams: int | None = None
    cost_per_kg: int | None = None
    note: str | None = None


class FilamentAdjust(BaseModel):
    """Add or remove grams. Positive = add, negative = consume."""
    delta_grams: int = Field(..., description="Грами +/-")
    reason: str | None = None
    task_id: int | None = None


class FilamentLogOut(BaseModel):
    id: int
    filament_id: int
    delta_grams: int
    grams_after: int
    reason: str | None
    task_id: int | None
    user_id: int | None
    created_at: datetime

    class Config:
        from_attributes = True


class FilamentOut(BaseModel):
    id: int
    sku: str | None
    material: str
    color: str
    brand: str | None
    grams_remaining: int
    min_grams: int
    cost_per_kg: int | None
    note: str | None
    updated_at: datetime
    is_low: bool

    class Config:
        from_attributes = True
