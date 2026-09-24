"""Resolve actual sliced plates, not product configuration labels."""
import re
import zipfile

from fastapi import HTTPException

from app.services import storage
from app.services.cache import cache_get, cache_set

PLATE_CACHE_TTL_SECONDS = 300


def file_plates(file, org_id: int) -> list[int]:
    if not file.original_name.lower().endswith(".3mf"):
        return [1]
    key = f"file_plates:{org_id}:{file.stored_name}"
    cached = cache_get(key)
    if cached is not None:
        return cached
    try:
        with storage.local_path_for(file.stored_name, org_id) as path, zipfile.ZipFile(path) as archive:
            plates = sorted({int(m.group(1)) for name in archive.namelist()
                             if (m := re.fullmatch(r"Metadata/plate_(\d+)\.gcode", name))})
    except (FileNotFoundError, zipfile.BadZipFile):
        raise HTTPException(400, "Не вдалося прочитати пластини файлу") from None
    if not plates:
        raise HTTPException(400, "Файл не містить підготовленого G-коду пластин")
    cache_set(key, plates, PLATE_CACHE_TTL_SECONDS)
    return plates


def plate_metadata(file, org_id: int, plate: int) -> dict:
    from app.services.gcode_meta import parse_3mf_plate
    key = f"file_plate_meta:{org_id}:{file.stored_name}:{plate}"
    cached = cache_get(key)
    if cached is not None:
        return cached
    if plate not in file_plates(file, org_id):
        raise HTTPException(400, "Обрана пластина відсутня у файлі")
    if not file.original_name.lower().endswith(".3mf"):
        return file.filament_meta or {}
    with storage.local_path_for(file.stored_name, org_id) as path:
        meta = {**parse_3mf_plate(path, plate), "bambu_plate_gcode": f"Metadata/plate_{plate}.gcode"}
    cache_set(key, meta, PLATE_CACHE_TTL_SECONDS)
    return meta
