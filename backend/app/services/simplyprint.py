"""SimplyPrint API client + state extraction.

GetFarmOverview returns "buckets" — a printer can appear in several buckets
simultaneously (e.g. `printing` + `requires_attention`). We collapse buckets
into one record per printer with a primary state and a list of flags.

Printer action functions (clear_bed, cancel_print, pause_print, resume_print,
send_gcode) call the SimplyPrint REST API and invalidate the overview cache so
the next dashboard poll reflects the updated state.
"""
import logging
import time
from typing import Any

import requests

from app.core.config import settings


log = logging.getLogger(__name__)

BASE_URL = "https://api.simplyprint.io"
TIMEOUT = 30
CACHE_TTL_SECONDS = 30


FLAG_STATES = {"requires_attention", "ai_running", "ai_detected_low", "ai_detected_high"}

_STATE_PRIORITY = {
    "online": 0,
    "print_pending": 1,
    "operational": 2,
    "printing": 2,
    "in_maintenance": 3,
    "awaiting_bed_clear": 4,
    "paused": 5,
    "not_connected": 7,
    "offline": 8,
}

OK_STATES = {"online", "operational", "printing", "print_pending"}


_cache: dict[str, Any] = {"ts": 0.0, "data": None}


def _is_configured() -> bool:
    return bool(settings.SIMPLYPRINT_API_KEY and settings.SIMPLYPRINT_ORG_ID)


# ── Printer actions ──────────────────────────────────────────────────────────


class SimplyPrintError(Exception):
    """Raised when a SimplyPrint action call fails."""


def _sp_post(endpoint: str, pid: str, body: dict | None = None) -> dict:
    """Call a SimplyPrint printer action endpoint synchronously.

    Use via ``asyncio.to_thread`` from async FastAPI routes.
    Raises SimplyPrintError on network or API-level failure.
    """
    if not _is_configured():
        raise SimplyPrintError("SimplyPrint не налаштовано (відсутній API key або org id)")
    url = f"{BASE_URL}/{settings.SIMPLYPRINT_ORG_ID}/{endpoint}?pid={pid}"
    headers = {"X-API-KEY": settings.SIMPLYPRINT_API_KEY}
    try:
        resp = requests.post(url, headers=headers, json=body, timeout=TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException as e:
        raise SimplyPrintError(f"Не вдалося зв'язатися з SimplyPrint: {e}") from e
    if not data.get("status"):
        raise SimplyPrintError(data.get("message") or "SimplyPrint повернув помилку")
    return data


def invalidate_cache() -> None:
    """Force the next get_farm_overview() call to bypass the cache."""
    _cache["ts"] = 0.0


def clear_bed(sp_id: str, success: bool = True) -> dict:
    """Mark bed cleared after a finished print (printer must be operational/offline)."""
    result = _sp_post("printers/actions/ClearBed", sp_id, {"success": success})
    invalidate_cache()
    return result


def cancel_print(sp_id: str) -> dict:
    """Cancel active print (printer must be printing/paused/pausing)."""
    result = _sp_post("printers/actions/Cancel", sp_id, {})
    invalidate_cache()
    return result


def pause_print(sp_id: str) -> dict:
    """Pause active print (printer must be printing)."""
    result = _sp_post("printers/actions/Pause", sp_id)
    invalidate_cache()
    return result


def resume_print(sp_id: str) -> dict:
    """Resume paused print (printer must be paused)."""
    result = _sp_post("printers/actions/Resume", sp_id)
    invalidate_cache()
    return result


def send_gcode(sp_id: str, gcode: list[str]) -> dict:
    """Send raw G-code lines to an operational printer."""
    if not gcode:
        raise SimplyPrintError("Список G-code команд не може бути порожнім")
    return _sp_post("printers/actions/SendGcode", sp_id, {"gcode": gcode})


def get_farm_overview(force: bool = False) -> dict:
    """Cached fetch of the SimplyPrint farm overview.

    Returns the raw response dict, or `{}` if not configured / on error.
    """
    if not _is_configured():
        return {}
    now = time.monotonic()
    if not force and _cache["data"] is not None and now - _cache["ts"] < CACHE_TTL_SECONDS:
        return _cache["data"]
    url = f"{BASE_URL}/{settings.SIMPLYPRINT_ORG_ID}/printers/GetFarmOverview"
    headers = {"X-API-KEY": settings.SIMPLYPRINT_API_KEY}
    try:
        resp = requests.post(url, headers=headers, timeout=TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        log.exception("SimplyPrint GetFarmOverview failed")
        return _cache["data"] or {}
    _cache["data"] = data
    _cache["ts"] = now
    return data


def extract_printers(data: dict) -> list[dict]:
    """Collapse buckets → list of {id, name, state, flags}."""
    if not isinstance(data, dict):
        return []
    buckets = data.get("buckets")
    if not isinstance(buckets, dict):
        return []

    printers: dict[Any, dict] = {}

    for state, bucket in buckets.items():
        if state in FLAG_STATES or not isinstance(bucket, dict):
            continue
        prio = _STATE_PRIORITY.get(state, 3)
        for p in bucket.get("printers") or []:
            pid = p.get("id")
            if pid is None:
                continue
            # Extract print progress (SP may nest it as print.progress or top-level progress)
            raw_progress = None
            if isinstance(p.get("print"), dict):
                raw_progress = p["print"].get("progress")
            if raw_progress is None:
                raw_progress = p.get("progress")
            progress = int(raw_progress) if raw_progress is not None else None

            existing = printers.get(pid)
            if existing is None or prio > _STATE_PRIORITY.get(existing["state"], 0):
                printers[pid] = {
                    "id": pid,
                    "name": p.get("name", str(pid)),
                    "state": state,
                    "flags": [],
                    "progress": progress,
                }
            # Keep progress from whichever bucket has it
            elif progress is not None and existing.get("progress") is None:
                existing["progress"] = progress

    for flag, bucket in buckets.items():
        if flag not in FLAG_STATES or not isinstance(bucket, dict):
            continue
        for p in bucket.get("printers") or []:
            pid = p.get("id")
            if pid is None:
                continue
            if pid in printers:
                printers[pid]["flags"].append(flag)
            else:
                printers[pid] = {
                    "id": pid,
                    "name": p.get("name", str(pid)),
                    "state": flag,
                    "flags": [flag],
                }

    return list(printers.values())
