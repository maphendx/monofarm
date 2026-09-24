"""Operator-configured production outputs of a gcode file."""
from pydantic import BaseModel, Field, model_validator


class FileOutputItem(BaseModel):
    product_id: int = Field(gt=0)
    qty_per_run: int = Field(ge=1, le=1_000_000, strict=True)
    # 1-based slicer plate (3MF Metadata/plate_N.gcode); NULL = any plate.
    plate: int | None = Field(default=None, ge=1, le=1_000)


class FileOutputSet(BaseModel):
    warehouse_id: int | None = Field(default=None, gt=0)
    items: list[FileOutputItem] = Field(default=[], min_length=0, max_length=100)

    @model_validator(mode="after")
    def unique_positions(self):
        keys = {(item.product_id, item.plate) for item in self.items}
        if len(keys) != len(self.items):
            raise ValueError("Duplicate product/plate positions are not allowed")
        return self


class FileOutputOut(BaseModel):
    product_id: int
    product_name: str | None = None
    qty_per_run: int
    plate: int | None = None
