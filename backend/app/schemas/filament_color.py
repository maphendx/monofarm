from pydantic import BaseModel, Field


class FilamentColorCreate(BaseModel):
    name: str = Field(..., max_length=80)
    hex_color: str = Field(..., pattern=r"^#[0-9a-fA-F]{6}$")
    sort_order: int = 0


class FilamentColorUpdate(BaseModel):
    name: str | None = Field(None, max_length=80)
    hex_color: str | None = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")
    sort_order: int | None = None


class FilamentColorOut(BaseModel):
    id: int
    name: str
    hex_color: str
    sort_order: int

    class Config:
        from_attributes = True
