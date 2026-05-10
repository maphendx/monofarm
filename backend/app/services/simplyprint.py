"""SimplyPrint API client + state extraction.

GetFarmOverview returns "buckets" — a printer can appear in several buckets
simultaneously (e.g. `printing` + `requires_attention`). We collapse buckets
into one record per printer with a primary state and a list of flags.
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
            existing = printers.get(pid)
            if existing is None or prio > _STATE_PRIORITY.get(existing["state"], 0):
                printers[pid] = {
                    "id": pid,
                    "name": p.get("name", str(pid)),
                    "state": state,
                    "flags": [],
                }

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
