"""Auto-tag a newly uploaded GcodeFile based on its filament_meta.

Reads filament_meta.types (list of material strings) and color info,
creates or reuses Tag rows for material kind, then assigns them to the
file. Skips silently on any error so upload is never blocked.
"""
from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from app.models.gcode_file import GcodeFile
from app.models.organization import Organization
from app.models.tag import Tag, TagKind

log = logging.getLogger(__name__)

_MATERIAL_MAP: dict[str, str] = {
    "pla": "PLA",
    "petg": "PETG",
    "abs": "ABS",
    "asa": "ASA",
    "tpu": "TPU",
    "pa": "PA",
    "pc": "PC",
    "pla-cf": "PLA-CF",
    "petg-cf": "PETG-CF",
}


def _canonical_material(raw: str) -> str:
    low = raw.lower().strip()
    for prefix, canon in _MATERIAL_MAP.items():
        if low == prefix or low.startswith(prefix + " ") or low.startswith(prefix + "-"):
            return canon
    return raw.strip()


def _get_or_create_material_tag(db: Session, org_id: int, canon_type: str, color_hex: str | None) -> Tag:
    """Find existing material tag with same type (and color if given), or create."""
    existing = db.query(Tag).filter(
        Tag.organization_id == org_id,
        Tag.kind == TagKind.material,
    ).all()
    for t in existing:
        t_meta = t.meta or {}
        if t_meta.get("type") == canon_type:
            if color_hex is None or t_meta.get("color") == color_hex:
                return t
    meta: dict = {"type": canon_type}
    if color_hex:
        meta["color"] = color_hex
    tag = Tag(organization_id=org_id, kind=TagKind.material, meta=meta)
    db.add(tag)
    db.flush()
    return tag


def auto_tag_file(db: Session, org: Organization, gcode_file: GcodeFile) -> None:
    """Assign material tags to *gcode_file* derived from its filament_meta."""
    settings = org.tag_settings or {}
    if not settings.get("auto_tag_on_upload", True):
        return

    meta = gcode_file.filament_meta
    if not meta:
        return

    material_types: list[str] = meta.get("types") or []
    colors: list[str] = meta.get("colors") or []

    new_tags: list[Tag] = []
    seen: set[str] = set()

    for i, raw_type in enumerate(material_types):
        if not raw_type:
            continue
        canon = _canonical_material(raw_type)
        if canon in seen:
            continue
        seen.add(canon)
        color_hex = (colors[i] if i < len(colors) else None) or None

        try:
            tag = _get_or_create_material_tag(db, org.id, canon, color_hex)
            new_tags.append(tag)
        except Exception:
            log.exception("auto_tag: failed to create material tag for %s", canon)

    if not new_tags:
        return

    existing_ids = {t.id for t in (gcode_file.tags or [])}
    for t in new_tags:
        if t.id not in existing_ids:
            gcode_file.tags.append(t)

    try:
        db.commit()
    except Exception:
        log.exception("auto_tag: commit failed for file %d", gcode_file.id)
        db.rollback()
