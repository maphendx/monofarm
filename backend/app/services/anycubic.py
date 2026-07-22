"""Anycubic Kobra 3 / S1 local LAN state cache.

The local farm agent runs the actual MQTT client (see .claude/rules/agent.md —
"relay purity: nothing processed on our server"). This module only caches the
parsed reports the agent pushes and maps them to the unified status vocabulary
used across printer kinds (idle/printing/paused/error/offline/unknown).
"""
from __future__ import annotations

from app.services import anycubic_protocol
from app.services.cache import cache_get, cache_set

STATUS_CACHE_TTL = 30
STATUS_STALE_TTL = 15 * 60
ACE_CACHE_TTL = 15 * 60

# Anycubic `project.state` (busy) values -> unified vocabulary. `free` maps to
# "idle" directly by anycubic_protocol.parse_info.
_STATE_MAP: dict[str, str] = {
    "idle": "idle",
    "preheating": "printing",
    "auto_leveling": "printing",
    "vibrating": "printing",
    "flow_calibrating": "printing",
    "printing": "printing",
    "pausing": "paused",
    "paused": "paused",
    "resuming": "printing",
    "resumed": "printing",
    "stopping": "idle",
    "stoped": "idle",
    "finished": "idle",
}


def _unified_state(payload: dict) -> str:
    if payload.get("paused"):
        return "paused"
    raw = payload.get("status")
    return _STATE_MAP.get(raw or "", "unknown")


def handle_agent_report(dev_id: str, raw_data: dict) -> dict:
    """Parse a raw `info` report `.data` payload (as relayed by the agent) and cache it."""
    parsed = anycubic_protocol.parse_info(raw_data)
    state = {
        "state": _unified_state(parsed),
        "filename": parsed.get("filename"),
        "progress_pct": parsed.get("progress"),
        "eta_minutes": parsed.get("remain_time"),
        "nozzle_temp": parsed.get("nozzle_temp"),
        "nozzle_target": parsed.get("nozzle_target"),
        "bed_temp": parsed.get("bed_temp"),
        "bed_target": parsed.get("bed_target"),
        "current_layer": parsed.get("current_layer"),
        "total_layers": parsed.get("total_layers"),
        "camera_url": parsed.get("camera_url"),
    }
    cache_set(f"anycubic:state:{dev_id}", state, STATUS_CACHE_TTL)
    cache_set(f"anycubic:state:stale:{dev_id}", state, STATUS_STALE_TTL)
    return state


def handle_agent_ace_report(dev_id: str, raw_data: dict) -> list[dict]:
    """Parse a raw `multiColorBox` report `.data` payload, merge with cached boxes, and cache."""
    new_boxes = anycubic_protocol.parse_multicolorbox(raw_data)
    prev_boxes = cache_get(f"anycubic:ace:{dev_id}") or []
    merged = anycubic_protocol.merge_boxes(prev_boxes, new_boxes)
    cache_set(f"anycubic:ace:{dev_id}", merged, ACE_CACHE_TTL)
    return merged


def get_cached_state(dev_id: str) -> dict:
    """Return cached LAN state for a device, or an offline placeholder."""
    fresh = cache_get(f"anycubic:state:{dev_id}")
    if fresh is not None:
        return {**fresh, "state_stale": False}
    stale = cache_get(f"anycubic:state:stale:{dev_id}")
    if stale is not None:
        return {**stale, "state_stale": True}
    return {"state": "offline"}


def get_ace_filaments(dev_id: str) -> list[dict]:
    """Return cached ACE multi-material slot data for a device."""
    return cache_get(f"anycubic:ace:{dev_id}") or []
