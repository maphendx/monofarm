"""Moonraker send/dispatch mechanics — gcode rewrite + upload + auto-start.

Extracted from `api/files.py:send_to_printer` so the unified print-job pipeline
can reuse it as the Moonraker provider dispatcher (Pass 2): the entry point is
transport-only and knows nothing about job rows or HTTP responses.

Raises `moonraker.MoonrakerError` on upload/start failure — callers map it to
their own result shape. Runs in the web process: agent tunnels terminate here,
not in the worker process.
"""
from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

from app.services import moonraker as mr
from app.services import tunnel as _tunnel


async def send_file_to_moonraker(
    *,
    org_id: int,
    moonraker_url: str,
    src: Path,
    file_name: str,
    filament_meta: dict,
    slot_map: dict[int, int],
    auto_bed_leveling: bool | None = None,
    timelapse: bool | None = None,
    ai_detection: bool | None = None,
    calibrate_slots: list[int] | None = None,
) -> None:
    """Apply slot remap / print options, then upload to Moonraker and start the print."""
    has_remap = any(k != v for k, v in slot_map.items())
    calibrate_set = set(calibrate_slots) if calibrate_slots is not None else None

    used_g = filament_meta.get("used_g") or []
    slot_count = max(len(filament_meta.get("colors") or []), len(filament_meta.get("types") or []), 0)
    used_set: set[int] | None = None
    if used_g and slot_count:
        candidate = {i for i in range(slot_count) if i >= len(used_g) or used_g[i] > 0}
        if 0 < len(candidate) < slot_count:
            used_set = candidate

    has_options = (
        auto_bed_leveling is not None
        or timelapse is not None
        or ai_detection is not None
        or used_set is not None
        or calibrate_set is not None
    )

    working: bytes | None = None
    if has_options:
        working = await asyncio.to_thread(
            mr.apply_print_options,
            src,
            auto_bed_leveling,
            timelapse,
            ai_detection,
            used_set,
            calibrate_set,
        )
    if has_remap:
        base = working if working is not None else src
        working = await asyncio.to_thread(mr.remap_slots, base, slot_map)

    upload_bytes: bytes | None = working
    if upload_bytes is None and _tunnel.has_tunnel(org_id):
        upload_bytes = src.read_bytes()

    if _tunnel.has_tunnel(org_id):
        await _tunnel.send_moonraker_upload(
            org_id,
            moonraker_url,
            file_name,
            upload_bytes,  # type: ignore[arg-type]
            start_print=True,
        )
    elif working is not None:
        with tempfile.NamedTemporaryFile(suffix=src.suffix, delete=False) as tmp:
            tmp.write(working)
            tmp_path = Path(tmp.name)
        try:
            await mr.async_upload_gcode(moonraker_url, tmp_path, file_name, start_print=True)
        finally:
            tmp_path.unlink(missing_ok=True)
    else:
        await mr.async_upload_gcode(moonraker_url, src, file_name, start_print=True)
