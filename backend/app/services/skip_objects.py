from __future__ import annotations

import io
import time
import xml.etree.ElementTree as ET
import zipfile
from typing import Any


class InvalidSkipRequest(ValueError):
    pass


def _pick_bounds(zf: zipfile.ZipFile, plate_index: int, object_ids: set[int]) -> dict[int, list[float]]:
    """Extract normalized object bounds from Bambu's color-coded pick image."""
    try:
        from PIL import Image

        image = Image.open(io.BytesIO(zf.read(f"Metadata/pick_{plate_index}.png"))).convert("RGB")
    except (KeyError, OSError, ValueError):
        return {}

    wanted = {
        (object_id & 0xFF, (object_id >> 8) & 0xFF, (object_id >> 16) & 0xFF): object_id
        for object_id in object_ids
    }
    boxes: dict[int, list[int]] = {}
    for y in range(image.height):
        for x in range(image.width):
            object_id = wanted.get(image.getpixel((x, y)))
            if object_id is None:
                continue
            box = boxes.setdefault(object_id, [x, y, x, y])
            box[0] = min(box[0], x)
            box[1] = min(box[1], y)
            box[2] = max(box[2], x)
            box[3] = max(box[3], y)

    width = max(1, image.width - 1)
    height = max(1, image.height - 1)
    return {
        object_id: [x1 / width, y1 / height, x2 / width, y2 / height]
        for object_id, (x1, y1, x2, y2) in boxes.items()
    }


def parse_bambu_plate_objects(
    file_bytes: bytes,
    *,
    plate_index: int | None = None,
    excluded_ids: set[int] | None = None,
) -> list[dict[str, Any]]:
    """Read native Bambu skip IDs from a sliced 3MF's active plate."""
    excluded = excluded_ids or set()
    try:
        with zipfile.ZipFile(io.BytesIO(file_bytes)) as zf:
            root = ET.fromstring(zf.read("Metadata/slice_info.config"))
            plates: list[tuple[int, ET.Element]] = []
            for plate in root.findall(".//plate"):
                index = None
                for metadata in plate.findall("metadata"):
                    if metadata.get("key") == "index":
                        try:
                            index = int(metadata.get("value", ""))
                        except ValueError:
                            index = None
                        break
                if index is not None:
                    plates.append((index, plate))
            if not plates:
                return []

            selected_index, selected_plate = next(
                ((index, plate) for index, plate in plates if index == plate_index),
                plates[0],
            )
            raw_objects: list[tuple[int, str]] = []
            for element in selected_plate.findall("object"):
                if element.get("skipped", "false").lower() == "true":
                    continue
                try:
                    object_id = int(element.get("identify_id", ""))
                except ValueError:
                    continue
                raw_objects.append((object_id, element.get("name") or f"Object {object_id}"))

            bounds = _pick_bounds(zf, selected_index, {object_id for object_id, _ in raw_objects})
    except (zipfile.BadZipFile, KeyError, ET.ParseError):
        return []

    return [
        {
            "id": str(object_id),
            "name": name,
            "excluded": object_id in excluded,
            "current": False,
            "bounds": bounds.get(object_id),
        }
        for object_id, name in raw_objects
    ]


def merge_bambu_excluded_state(
    objects: list[dict[str, Any]],
    excluded_ids: set[int],
) -> list[dict[str, Any]]:
    """Overlay fast-changing MQTT `s_obj` state on immutable 3MF metadata."""
    return [
        {
            **obj,
            "excluded": int(obj["id"]) in excluded_ids,
        }
        for obj in objects
    ]


def validate_skip_request(objects: list[dict[str, Any]], requested_ids: list[str]) -> list[str]:
    requested = list(dict.fromkeys(str(object_id) for object_id in requested_ids))
    if not requested:
        raise InvalidSkipRequest("Оберіть хоча б один об’єкт")

    by_id = {str(obj["id"]): obj for obj in objects}
    unknown = [object_id for object_id in requested if object_id not in by_id]
    if unknown:
        raise InvalidSkipRequest("Невідомий об’єкт у запиті")
    if any(by_id[object_id].get("excluded") for object_id in requested):
        raise InvalidSkipRequest("Один з об’єктів вже пропущено")

    remaining = sum(not bool(obj.get("excluded")) for obj in objects)
    if len(requested) >= remaining:
        raise InvalidSkipRequest("Не можна пропустити останній об’єкт друку")
    return requested


def build_bambu_skip_payload(
    object_ids: list[int],
    *,
    sequence_id: str,
    timestamp: int | None = None,
) -> dict[str, Any]:
    return {
        "print": {
            "command": "skip_objects",
            "sequence_id": sequence_id,
            "timestamp": int(time.time()) if timestamp is None else timestamp,
            "obj_list": object_ids,
        }
    }
