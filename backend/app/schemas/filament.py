from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class FilamentCreate(BaseModel):
    material: str
    color: str
    hex_color: str | None = None
    brand: str | None = None
    grams_remaining: int = Field(default=0, ge=0)
    min_grams: int = 0
    cost_per_kg: int | None = None
    note: str | None = None
    label_id: str | None = None


class FilamentUpdate(BaseModel):
    material: str | None = None
    color: str | None = None
    hex_color: str | None = None
    brand: str | None = None
    grams_remaining: int | None = Field(default=None, ge=0)
    min_grams: int | None = None
    cost_per_kg: int | None = None
    note: str | None = None
    label_id: str | None = None


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

    model_config = ConfigDict(from_attributes=True)


class FilamentOut(BaseModel):
    id: int
    sku: str | None
    label_id: str | None
    material: str
    color: str
    hex_color: str | None
    brand: str | None
    grams_remaining: int
    min_grams: int
    cost_per_kg: int | None
    note: str | None
    updated_at: datetime
    is_low: bool
    warehouse_product_id: int | None = None
    warehouse_id: int | None = None
    warehouse_name: str | None = None
    # Physical spool inventory (computed server-side; derived, never client-set).
    status: str = "in_stock"
    location: dict | None = None
    reserved_g: int = 0
    available_g: int = 0

    model_config = ConfigDict(from_attributes=True)




class SpoolStatusPayload(BaseModel):
    status: str


class SpoolReceiveItem(BaseModel):
    grams: int = Field(gt=0, le=1_000_000)
    count: int = Field(default=1, ge=1, le=1000)


class SpoolReceivePayload(BaseModel):
    product_id: int
    warehouse_id: int | None = None
    warehouse_name: str | None = Field(default=None, min_length=1, max_length=100)
    convert_to_grams: bool = False
    spools: list[SpoolReceiveItem] = Field(min_length=1, max_length=100)
    material: str | None = Field(default=None, max_length=40)
    color: str | None = Field(default=None, max_length=40)
    hex_color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    brand: str | None = Field(default=None, max_length=80)
    cost_per_kg: int | None = Field(default=None, ge=0)
    request_id: str | None = Field(default=None, min_length=8, max_length=64, pattern=r"^[A-Za-z0-9-]+$")
    note: str | None = Field(default=None, max_length=255)


class FilamentSetRemaining(BaseModel):
    grams_remaining: int = Field(ge=0, le=1_000_000)
    expected_grams: int = Field(ge=0)
    reason: str | None = Field(default=None, max_length=255)
