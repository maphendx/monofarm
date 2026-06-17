from typing import Any
from pydantic import BaseModel, model_validator
from app.models.tag import TagKind


class TagOut(BaseModel):
    id: int
    kind: TagKind
    label: str | None = None
    color: str | None = None
    meta: dict[str, Any] | None = None
    display: str = ""

    class Config:
        from_attributes = True


class TagCreate(BaseModel):
    kind: TagKind
    # Required for 'custom'
    label: str | None = None
    color: str | None = None
    # Required for 'nozzle': {"diameter": 0.4}
    # Required for 'material': {"type": "PLA", "color": "#ff0000", "color_name": "Red"}
    meta: dict[str, Any] | None = None

    @model_validator(mode="after")
    def validate_fields(self) -> "TagCreate":
        if self.kind == TagKind.nozzle:
            if not self.meta or "diameter" not in self.meta:
                raise ValueError("nozzle tag requires meta.diameter")
        elif self.kind == TagKind.material:
            if not self.meta or "type" not in self.meta:
                raise ValueError("material tag requires meta.type")
        elif self.kind == TagKind.bed_type:
            if not self.meta or "bed_type" not in self.meta:
                raise ValueError("bed_type tag requires meta.bed_type")
        elif self.kind == TagKind.custom:
            if not self.label:
                raise ValueError("custom tag requires label")
        return self


class TagUpdate(BaseModel):
    label: str | None = None
    color: str | None = None
    meta: dict[str, Any] | None = None


class TagAssign(BaseModel):
    """Assign/remove a set of tag IDs to an entity."""
    tag_ids: list[int]


class TagsMatchResult(BaseModel):
    """Result of matching a print task to printers via tags."""
    printer_id: int
    printer_name: str
    matches: bool
    reasons: list[str]  # why it doesn't match, if not


class TagSettingsOut(BaseModel):
    """Org-level tag behaviour settings."""
    auto_tag_on_upload: bool = True
    nozzle_match_strict: bool = True
    material_match_color: bool = False
    material_clusters: list[list[str]] = []
    bed_type_map: dict[str, str] = {}

    class Config:
        extra = "allow"


class TagSettingsUpdate(BaseModel):
    auto_tag_on_upload: bool | None = None
    nozzle_match_strict: bool | None = None
    material_match_color: bool | None = None
    material_clusters: list[list[str]] | None = None
    bed_type_map: dict[str, str] | None = None
