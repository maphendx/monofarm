"""Bambu filament slot mapping helpers.

Slot indexes are 0-based. Bambu AMS slots are 0..N; external spool is 254.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class MaterialSlot:
    slot: int
    material: str | None
    color: str | None
    empty: bool = False


def normalize_color(color: str | None) -> str | None:
    if not color:
        return None
    raw = color.strip().lstrip("#")
    if len(raw) < 6:
        return None
    raw = raw[:6]
    if any(c not in "0123456789abcdefABCDEF" for c in raw):
        return None
    return raw.lower()


def normalize_material(material: str | None) -> str | None:
    if not material:
        return None
    value = material.strip().lower()
    return value or None


def used_file_slots(filament_meta: dict[str, Any] | None) -> list[int]:
    meta = filament_meta or {}
    total = max(len(meta.get("colors") or []), len(meta.get("types") or []), 1)
    used_g = meta.get("used_g") or []
    result: list[int] = []
    for idx in range(total):
        grams = used_g[idx] if idx < len(used_g) else None
        if grams is None or grams > 0:
            result.append(idx)
    return result


def slots_from_printer(printer: Any) -> list[MaterialSlot]:
    """Collect material slots from normalized rows and live/legacy JSON."""
    out: list[MaterialSlot] = []
    seen: set[int] = set()
    for slot in getattr(printer, "slots", None) or []:
        state = getattr(slot, "state", None)
        state_value = getattr(state, "value", state)
        idx = getattr(slot, "slot_index", None)
        if idx is None or idx in seen:
            continue
        material = getattr(slot, "material", None)
        color = getattr(slot, "hex_color", None) or getattr(slot, "color", None)
        empty = state_value == "empty" or (not material and not color and not getattr(slot, "filament_id", None))
        if not empty:
            out.append(MaterialSlot(int(idx), material, color, empty=False))
            seen.add(int(idx))

    for raw in getattr(printer, "loaded_filaments", None) or []:
        idx = raw.get("slot")
        if idx is None or idx in seen:
            continue
        empty = bool(raw.get("empty"))
        material = raw.get("type")
        color = raw.get("color")
        if not empty and (material or color or raw.get("filament_id")):
            out.append(MaterialSlot(int(idx), material, color, empty=False))
            seen.add(int(idx))
    return sorted(out, key=lambda s: (s.slot == 254, s.slot))


def build_ams_mapping(
    filament_meta: dict[str, Any] | None,
    printer: Any,
    override_slot_map: dict[int, int] | None = None,
) -> tuple[list[int], bool, dict[str, Any]]:
    """Build Bambu ams_mapping from file slots to printer slots.

    Manual override wins. Otherwise prefer exact material+color, then material,
    then same slot index, then first unused loaded slot. Unused file slots become
    -1 so the printer does not try to load material the plate does not use.
    """
    meta = filament_meta or {}
    colors = meta.get("colors") or []
    types = meta.get("types") or []
    file_slots = used_file_slots(meta)
    all_count = max(len(colors), len(types), max(file_slots, default=0) + 1, 1)
    targets = slots_from_printer(printer)
    used_targets: set[int] = set()
    override = override_slot_map or {}
    mapping: list[int] = []
    source: dict[int, str] = {}

    for idx in range(all_count):
        if idx not in file_slots:
            mapping.append(-1)
            source[idx] = "unused"
            continue
        if idx in override:
            target = int(override[idx])
            mapping.append(target)
            used_targets.add(target)
            source[idx] = "manual"
            continue

        file_color = normalize_color(colors[idx] if idx < len(colors) else None)
        file_type = normalize_material(types[idx] if idx < len(types) else None)
        candidates = [t for t in targets if t.slot not in used_targets]

        picked = next(
            (
                t for t in candidates
                if file_color
                and normalize_color(t.color) == file_color
                and (not file_type or not normalize_material(t.material) or normalize_material(t.material) == file_type)
            ),
            None,
        )
        if picked is None and file_type:
            picked = next((t for t in candidates if normalize_material(t.material) == file_type), None)
        if picked is None:
            picked = next((t for t in candidates if t.slot == idx), None)
        if picked is None:
            picked = candidates[0] if candidates else None

        target = picked.slot if picked else idx
        mapping.append(target)
        used_targets.add(target)
        source[idx] = "auto" if picked else "identity"

    use_ams = any(0 <= v < 254 for v in mapping)
    return mapping, use_ams, {
        "source": source,
        "targets": [{"slot": t.slot, "material": t.material, "color": t.color} for t in targets],
    }


def is_a1_series(model: str | None) -> bool:
    normalized = (model or "").upper().replace("-", " ")
    return "A1" in normalized
