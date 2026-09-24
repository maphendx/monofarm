"""Thin Moonraker REST client.

Uses sync `requests` (network-bound, lightweight) — call from async via `asyncio.to_thread`.

The user's Mainsail URL may include a `?printer=<id>` query param — that's a Mainsail UI
bookkeeping detail and is NOT needed for Moonraker API calls. We strip it.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit

import httpx
import requests


log = logging.getLogger(__name__)
TIMEOUT = 30
UPLOAD_TIMEOUT_MIN = 300.0
UPLOAD_TIMEOUT_MAX = 3600.0
UPLOAD_RATE_GUESS = 256 * 1024  # conservative 256 KiB/s for WAN + LAN relay
STATUS_TIMEOUT = 1.5  # short timeout for live status polling
STATUS_CACHE_TTL = 35.0  # seconds — slightly above the 30s frontend poll interval so polls always hit cache
STALE_CACHE_TTL = 300    # 5 min stale fallback for the very first load
META_CACHE_TTL = 300.0  # file metadata is static for a given filename
META_TAIL_BYTES = 96 * 1024  # how much to download from remote file for parsing
BED_CLEARED_TTL_SECONDS = 24 * 60 * 60


class MoonrakerError(Exception):
    """Raised when Moonraker returns an error response."""


def upload_timeout_for_size(size_bytes: int) -> float:
    """Give large uploads a generous budget; retain only a dead-tunnel guard."""
    size = max(0, int(size_bytes))
    return min(UPLOAD_TIMEOUT_MAX, max(UPLOAD_TIMEOUT_MIN, UPLOAD_TIMEOUT_MIN + size / UPLOAD_RATE_GUESS))


# Local cache kept as stale-data fallback when Redis is unavailable or a fetch fails.
# Some tunnel paths store `(monotonic_timestamp, status)` so readers must unwrap it.
_status_cache: dict[tuple[int, str], object] = {}
_meta_cache: dict[tuple[int, str, str], dict] = {}


def _api_base(url: str) -> str:
    """Strip path and query from a Mainsail URL → bare scheme://host[:port]."""
    s = urlsplit(url.strip())
    if not s.scheme or not s.netloc:
        raise MoonrakerError("Невалідний URL Moonraker")
    return urlunsplit((s.scheme, s.netloc, "", "", ""))


def _status_cache_url(url: str) -> str:
    """Use one status-cache identity for DB URLs and agent-pushed URLs."""
    try:
        return _api_base(url)
    except MoonrakerError:
        return url.strip().rstrip("/")


def _status_cache_key(kind: str, url: str, org_id: int) -> str:
    if type(org_id) is not int or org_id <= 0:
        raise ValueError("Moonraker cache requires an organization")
    return f"mr:org:{org_id}:{kind}:{_status_cache_url(url)}"


def _request(method: str, base: str, path: str, **kw) -> dict:
    url = f"{base}{path}"
    try:
        resp = requests.request(method, url, timeout=TIMEOUT, **kw)
    except requests.RequestException as e:
        raise MoonrakerError(f"Не вдалося зʼєднатись з принтером: {e}") from e
    if resp.status_code >= 400:
        try:
            err = resp.json().get("error", {}).get("message") or resp.text
        except Exception:
            err = resp.text
        raise MoonrakerError(f"Moonraker {resp.status_code}: {err}")
    try:
        return resp.json()
    except ValueError:
        return {}


async def _async_request(method: str, base: str, path: str, timeout: float | None = None, **kw) -> dict:
    url = f"{base}{path}"
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout if timeout is not None else TIMEOUT)) as client:
            resp = await client.request(method, url, **kw)
    except httpx.RequestError as e:
        raise MoonrakerError(f"Не вдалося зʼєднатись з принтером: {e}") from e
    if resp.status_code >= 400:
        try:
            err = resp.json().get("error", {}).get("message") or resp.text
        except Exception:
            err = resp.text
        raise MoonrakerError(f"Moonraker {resp.status_code}: {err}")
    try:
        return resp.json()
    except ValueError:
        return {}


def get_printer_state(moonraker_url: str) -> dict:
    """Returns a dict with at least: state, state_message, hostname.
    Use it to verify connectivity before more complex operations.
    """
    base = _api_base(moonraker_url)
    return _request("GET", base, "/printer/info").get("result", {})


def query_objects(moonraker_url: str, objects: list[str] | None = None) -> dict:
    """Query Klipper objects (e.g. print_stats, display_status, extruder)."""
    base = _api_base(moonraker_url)
    objs = objects or ["print_stats", "display_status", "virtual_sdcard", "extruder", "heater_bed"]
    query = "&".join(o for o in objs)
    return _request("GET", base, f"/printer/objects/query?{query}").get("result", {})


def upload_gcode(
    moonraker_url: str,
    file_path: Path | bytes,
    filename: str | None = None,
    start_print: bool = False,
) -> dict:
    """Upload a .gcode/.3mf to Moonraker's `gcodes` root."""
    base = _api_base(moonraker_url)

    if isinstance(file_path, bytes):
        name = filename or "upload.gcode"
        content = file_path
    else:
        name = filename or file_path.name
        content = file_path.read_bytes()

    files = {"file": (name, content, "application/octet-stream")}
    data = {"root": "gcodes", "print": "true" if start_print else "false"}
    return _request("POST", base, "/server/files/upload", files=files, data=data)


async def async_upload_gcode(
    moonraker_url: str,
    file_path: Path | bytes,
    filename: str | None = None,
    start_print: bool = False,
    timeout: float | None = None,
) -> dict:
    """Async upload a .gcode/.3mf to Moonraker's `gcodes` root."""
    base = _api_base(moonraker_url)

    if isinstance(file_path, bytes):
        name = filename or "upload.gcode"
        content = file_path
    else:
        import asyncio
        name = filename or file_path.name
        content = await asyncio.to_thread(file_path.read_bytes)

    files = {"file": (name, content, "application/octet-stream")}
    data = {"root": "gcodes", "print": "true" if start_print else "false"}
    return await _async_request(
        "POST",
        base,
        "/server/files/upload",
        timeout=timeout if timeout is not None else upload_timeout_for_size(len(content)),
        files=files,
        data=data,
    )


def start_print(moonraker_url: str, filename: str) -> dict:
    """Start printing an already-uploaded file (no path, just bare filename)."""
    base = _api_base(moonraker_url)
    safe = quote(filename, safe="")
    return _request("POST", base, f"/printer/print/start?filename={safe}").get("result", {})


async def async_start_print(moonraker_url: str, filename: str) -> dict:
    """Async start printing an already-uploaded file."""
    base = _api_base(moonraker_url)
    safe = quote(filename, safe="")
    res = await _async_request("POST", base, f"/printer/print/start?filename={safe}")
    return res.get("result", {})


def pause_print(moonraker_url: str) -> dict:
    base = _api_base(moonraker_url)
    return _request("POST", base, "/printer/print/pause").get("result", {})


def resume_print(moonraker_url: str) -> dict:
    base = _api_base(moonraker_url)
    return _request("POST", base, "/printer/print/resume").get("result", {})


def cancel_print(moonraker_url: str) -> dict:
    base = _api_base(moonraker_url)
    return _request("POST", base, "/printer/print/cancel").get("result", {})


def send_gcode(moonraker_url: str, script: str) -> dict:
    """Send a G-code script line (or multiple lines joined by '\\n') to Klipper."""
    base = _api_base(moonraker_url)
    return _request("POST", base, "/printer/gcode/script", json={"script": script}).get("result", {})


def get_webcams(moonraker_url: str) -> list[dict]:
    """Return Moonraker's configured webcam list (name, snapshot_url, stream_url).

    Returns an empty list if the endpoint is unavailable or no webcams are configured.
    Each entry: {name, snapshot_url, stream_url, enabled, ...}
    """
    base = _api_base(moonraker_url)
    try:
        result = _request("GET", base, "/server/webcams/list")
        return result.get("result", {}).get("webcams", [])
    except MoonrakerError:
        return []


def skip_object(moonraker_url: str) -> dict:
    """Cancel the currently-printing object using Klipper's EXCLUDE_OBJECT module.

    Requires [exclude_object] in printer.cfg and SET_EXCLUDE_OBJECT_CURRENT enabled.
    Sends EXCLUDE_OBJECT_CURRENT which marks the active object for exclusion so
    Klipper skips it and moves on to the next object in the print.
    """
    return send_gcode(moonraker_url, "EXCLUDE_OBJECT_CURRENT")


# ── Aggregated live status (cached) ─────────────────────────────────────────


# Map Moonraker print_stats.state → our printer state vocabulary
_STATE_MAP = {
    "standby": "idle",
    "ready": "idle",
    "printing": "printing",
    "pausing": "pausing",
    "paused": "paused",
    "resuming": "resuming",
    "cancelling": "cancelling",
    "canceling": "cancelling",
    "complete": "operational",
    "completed": "operational",
    "cancelled": "idle",
    "canceled": "idle",
    "error": "error",
}


LIVE_STATUS_OBJECTS = "print_stats&display_status&virtual_sdcard&extruder&heater_bed&print_task_config"


def apply_bed_cleared_override(status: dict, marker: dict | None) -> dict:
    """Hide a completed Moonraker job after the operator confirms the bed is clear."""
    if not marker:
        return status

    state = status.get("state")
    expected_filename = marker.get("filename")
    current_filename = status.get("filename")
    if state in {"printing", "paused", "pausing", "resuming", "cancelling"}:
        return status
    if expected_filename and current_filename and current_filename != expected_filename:
        return status
    if state not in {"idle", "operational"}:
        return status

    return {
        **status,
        "state": "idle",
        "filename": None,
        "progress_pct": None,
        "eta_minutes": None,
        "error_msg": None,
    }


def mark_bed_cleared(moonraker_url: str, filename: str | None = None, *, org_id: int) -> dict:
    """Persist operator confirmation until the next print starts."""
    from app.services.cache import cache_set

    marker = {
        "cleared_at": datetime.now(timezone.utc).isoformat(),
        "filename": filename,
    }
    cache_set(_status_cache_key("bed_cleared", moonraker_url, org_id), marker, BED_CLEARED_TTL_SECONDS)
    return marker


def _apply_cached_bed_cleared(moonraker_url: str, status: dict, org_id: int) -> dict:
    from app.services.cache import cache_delete, cache_get

    key = _status_cache_key("bed_cleared", moonraker_url, org_id)
    marker = cache_get(key)
    if not isinstance(marker, dict):
        return status

    overridden = apply_bed_cleared_override(status, marker)
    if overridden is status and (
        status.get("state") in {"printing", "paused", "pausing", "resuming", "cancelling"}
        or (
            marker.get("filename")
            and status.get("filename")
            and status.get("filename") != marker.get("filename")
        )
    ):
        cache_delete(key)
    return overridden


def _parse_moonraker_status(status: dict) -> dict:
    """Convert a Moonraker .result.status dict → our normalized live-state dict.

    Extracted so the tunnel path can reuse it without duplicating the mapping logic.
    """
    print_stats = status.get("print_stats") or {}
    display = status.get("display_status") or {}
    sdcard = status.get("virtual_sdcard") or {}
    extruder = status.get("extruder") or {}
    bed = status.get("heater_bed") or {}

    raw_state = (print_stats.get("state") or "").lower()
    state = _STATE_MAP.get(raw_state, raw_state or "unknown")

    progress = (
        display.get("progress")
        if display.get("progress") is not None
        else sdcard.get("progress")
    )
    progress_pct = round(progress * 100) if isinstance(progress, (int, float)) else None

    filament_used_mm: float | None = None
    try:
        raw_used = print_stats.get("filament_used")
        if raw_used:
            filament_used_mm = float(raw_used)
    except (TypeError, ValueError):
        filament_used_mm = None

    print_duration = print_stats.get("print_duration") or 0
    eta_minutes: int | None = None
    if state == "printing" and progress and progress > 0.01 and print_duration > 0:
        total_estimated = print_duration / progress
        remaining = max(0, total_estimated - print_duration)
        eta_minutes = round(remaining / 60)

    error_msg: str | None = None
    raw_msg = (print_stats.get("message") or "").strip()
    if raw_msg and state in ("error", "unknown"):
        error_msg = raw_msg[:200]

    return {
        "state": state,
        "raw_state": raw_state,
        "filename": print_stats.get("filename") or None,
        "filament_used_mm": filament_used_mm,
        "progress_pct": progress_pct,
        "eta_minutes": eta_minutes,
        "print_duration_s": int(print_duration) if print_duration else None,
        "total_duration_s": int(print_stats.get("total_duration") or 0) or None,
        "extruder_temp": extruder.get("temperature"),
        "extruder_target": extruder.get("target"),
        "bed_temp": bed.get("temperature"),
        "bed_target": bed.get("target"),
        "error_msg": error_msg,
        "u1_filaments": u1_slots_from_task_config(status.get("print_task_config") or {}),
    }


def u1_slots_from_task_config(ptc: dict) -> list[dict] | None:
    """Decode Snapmaker U1 `print_task_config` into FilamentSlot-shaped dicts.

    Colors live in print_task_config (touchscreen-assigned, persists with the
    spool until unload) — NOT in filament_detect, which only reports RFID-tagged
    official spools (semantics hardware-verified by the u1hub project).
    """
    exist = ptc.get("filament_exist") or []
    if not exist:
        return None
    rgba = ptc.get("filament_color_rgba") or []
    types = ptc.get("filament_type") or []
    official = ptc.get("filament_official") or []
    slots: list[dict] = []
    for i in range(4):
        loaded = bool(exist[i]) if i < len(exist) else False
        hex_color = None
        if loaded and i < len(rgba) and rgba[i]:
            m = re.match(r"#?([0-9a-fA-F]{6})", str(rgba[i]))
            if m:
                hex_color = "#" + m.group(1).upper()
        material = types[i] if loaded and i < len(types) and types[i] else "PLA"
        slots.append({
            "slot": i,
            "color": hex_color or "#888888",
            "color_name": None,
            "type": material,
            "brand": "Snapmaker" if loaded and i < len(official) and official[i] else None,
            "filament_id": None,
            "empty": not loaded,
            "unit_id": None,
            "verified": True,
        })
    return slots


def _fetch_live_status(moonraker_url: str) -> dict:
    """Single Moonraker call returning normalized state for the dashboard."""
    base = _api_base(moonraker_url)
    try:
        resp = requests.get(
            f"{base}/printer/objects/query?{LIVE_STATUS_OBJECTS}", timeout=STATUS_TIMEOUT
        )
        resp.raise_for_status()
        status = resp.json().get("result", {}).get("status", {})
    except (requests.RequestException, ValueError) as e:
        raise MoonrakerError(str(e)) from e
    return _parse_moonraker_status(status)


# ── File metadata fetch (for color swatches when local task isn't available) ─


def _split_csv_or_semi(value) -> list[str]:
    """Slicers/Moonraker emit some fields as 'a;b' strings, others as lists."""
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if isinstance(value, str):
        return [v.strip() for v in value.replace(";", ",").split(",") if v.strip()]
    return []


def _from_moonraker_metadata(data: dict) -> dict:
    """Best-effort conversion of Moonraker's metadata dict → our filament_meta."""
    out: dict = {}

    # Types
    types = data.get("filament_type") or data.get("filament_name")
    if types:
        out["types"] = _split_csv_or_semi(types)

    # Colors — Moonraker key varies; OrcaSlicer/Snaporca often expose it
    for key in ("filament_color", "filament_colour", "filament_colors", "filament_colours"):
        if key in data:
            colors = _split_csv_or_semi(data[key])
            if colors:
                out["colors"] = colors
                break

    # Weight (grams) — Moonraker exposes per-filament list as `filament_weight`
    weights = (
        data.get("filament_weight")
        or data.get("filament_weights")
        or data.get("filament_weight_total")
    )
    if isinstance(weights, list):
        out["used_g"] = [round(float(w), 2) for w in weights if w is not None]
    elif isinstance(weights, (int, float)):
        out["used_g"] = [round(float(weights), 2)]

    if data.get("estimated_time"):
        try:
            out["estimated_minutes"] = round(float(data["estimated_time"]) / 60)
        except (TypeError, ValueError):
            pass
    if data.get("layer_count"):
        try:
            out["total_layers"] = int(data["layer_count"])
        except (TypeError, ValueError):
            pass
    if data.get("layer_height"):
        try:
            out["layer_height"] = float(data["layer_height"])
        except (TypeError, ValueError):
            pass

    return out


def _fetch_moonraker_metadata(moonraker_url: str, filename: str) -> dict:
    base = _api_base(moonraker_url)
    safe = quote(filename, safe="")
    try:
        resp = requests.get(
            f"{base}/server/files/metadata?filename={safe}",
            timeout=STATUS_TIMEOUT,
        )
        resp.raise_for_status()
        return _from_moonraker_metadata(resp.json().get("result", {}))
    except (requests.RequestException, ValueError) as e:
        log.debug("Moonraker metadata fetch failed for %s: %s", filename, e)
        return {}


def _fetch_file_tail_and_parse(moonraker_url: str, filename: str) -> dict:
    """Range-download the last META_TAIL_BYTES of the file and run our gcode parser."""
    import tempfile
    from app.services.gcode_meta import parse_gcode

    base = _api_base(moonraker_url)
    safe = quote(filename, safe="")
    file_url = f"{base}/server/files/gcodes/{safe}"
    try:
        resp = requests.get(
            file_url,
            headers={"Range": f"bytes=-{META_TAIL_BYTES}"},
            timeout=STATUS_TIMEOUT,
        )
        if resp.status_code not in (200, 206):
            return {}
        with tempfile.NamedTemporaryFile(suffix=Path(filename).suffix, delete=False) as f:
            f.write(resp.content)
            tmp_path = Path(f.name)
        try:
            return parse_gcode(tmp_path)
        finally:
            tmp_path.unlink(missing_ok=True)
    except requests.RequestException as e:
        log.debug("Moonraker file tail download failed for %s: %s", filename, e)
        return {}


def get_remote_file_meta(moonraker_url: str, filename: str | None, *, org_id: int) -> dict:
    """Get filament metadata for a file stored on the printer.

    Tries Moonraker's own metadata first; falls back to downloading the file
    tail and running our gcode parser. Result is cached per (url, filename)
    for META_CACHE_TTL seconds.
    """
    if not moonraker_url or not filename:
        return {}

    from app.services.cache import cache_get, cache_set
    redis_key = f"{_status_cache_key('meta', moonraker_url, org_id)}:{filename}"
    fresh = cache_get(redis_key)
    if fresh is not None:
        return fresh

    meta = _fetch_moonraker_metadata(moonraker_url, filename)
    # If colors are missing, fall back to parsing the file ourselves
    if not meta.get("colors"):
        parsed = _fetch_file_tail_and_parse(moonraker_url, filename)
        if parsed:
            meta = {**meta, **parsed}

    cache_set(redis_key, meta, int(META_CACHE_TTL))
    _meta_cache[(org_id, _status_cache_url(moonraker_url), filename)] = meta
    return meta


def remap_slots(src: Path | bytes, slot_map: dict[int, int]) -> bytes:
    """Return gcode bytes with tool-change commands remapped.

    Replaces:
      - standalone tool-change lines (`^T<n>`)
      - tool-select params in temperature commands (`M104/M109/M116 T<n>`)
      - Snapmaker macro EXTRUDER params (`SM_PRINT_* EXTRUDER=<n>`) — preheat,
        auto-feed and flow-calibrate must run against the physical slot that
        will actually be used after remap, not the slicer's source slot.

    Uses a two-pass placeholder strategy to avoid collisions when slots swap
    (A→B and B→A).

    slot_map: {old_slot_index: new_slot_index}  (0-based)
    """
    import re

    raw = src if isinstance(src, bytes) else src.read_bytes()
    content = raw.decode("utf-8", errors="ignore")

    changes = {k: v for k, v in slot_map.items() if k != v}
    if not changes:
        return raw

    # Pass 1 — T<n> tool-change / temperature params → placeholders
    def to_tool_placeholder(m: re.Match) -> str:
        n = int(m.group(1))
        if n in changes:
            return f"__TOOL_{n}__"
        return m.group(0)

    tool_pattern = re.compile(
        r"(?:(?<=\s)|^)T(\d+)(?=\s|;|$)",
        re.MULTILINE,
    )
    intermediate = tool_pattern.sub(to_tool_placeholder, content)

    # Pass 1b — SM_PRINT_* EXTRUDER=<n> params → placeholders
    def to_ext_placeholder(m: re.Match) -> str:
        prefix, n_str = m.group(1), m.group(2)
        n = int(n_str)
        if n in changes:
            return f"{prefix}__SLOT_{n}__"
        return m.group(0)

    ext_pattern = re.compile(
        r"^(SM_PRINT_\w+\s+(?:[^=\s]+=\S+\s+)*EXTRUDER=)(\d+)",
        re.MULTILINE,
    )
    intermediate = ext_pattern.sub(to_ext_placeholder, intermediate)

    # Pass 2 — placeholders → final slot numbers
    for old, new in changes.items():
        intermediate = intermediate.replace(f"__TOOL_{old}__", f"T{new}")
        intermediate = intermediate.replace(f"__SLOT_{old}__", str(new))

    return intermediate.encode("utf-8")


def apply_print_options(
    src: Path,
    auto_bed_leveling: bool | None,
    timelapse: bool | None,
    ai_detection: bool | None,
    used_slots: set[int] | None,
    calibrate_slots: set[int] | None,
) -> bytes | None:
    """Disable specific Snaporca-emitted operations by commenting them out.

    Disabling toggles only the *actual* command — the `SET_*` status macros
    written by the slicer (e.g. `SET_PRINT_AUTO_BED_LEVELING ENABLE=1`) are
    left alone, because they only set firmware state and do not gate whether
    `BED_MESH_CALIBRATE`/`TIMELAPSE_*`/`SM_PRINT_FLOW_CALIBRATE` run.

    - `auto_bed_leveling=False` → comment out `BED_MESH_CALIBRATE …` lines
    - `timelapse=False` → comment out `TIMELAPSE_START` and `TIMELAPSE_TAKE_FRAME`
    - `ai_detection=False` → comment out Snapmaker's AI/camera macros
      (`DEFECT_DETECTION_START`, `DEFECT_DETECTION_DETECT[_BED]`, `DETECT_BED_PLATE`)
    - `used_slots={n,…}` → comment out all `SM_PRINT_(EXTRUDER_PREHEAT|AUTO_FEED|
      FLOW_CALIBRATE) EXTRUDER=k` whose `k` is NOT in the set (skips preheat,
      loading, and calibration for filament slots the print never uses)
    - `calibrate_slots={n,…}` → additionally restrict `SM_PRINT_FLOW_CALIBRATE`
      to only those slots (intersected with `used_slots`)

    `None` / `True` mean "leave the slicer's output untouched". Returns the
    rewritten bytes, or `None` when nothing needed changing.
    """
    import re

    needs_rewrite = (
        auto_bed_leveling is False
        or timelapse is False
        or ai_detection is False
        or used_slots is not None
        or calibrate_slots is not None
    )
    if not needs_rewrite:
        return None

    content = src.read_bytes().decode("utf-8", errors="ignore")
    out = content

    if auto_bed_leveling is False:
        out = re.sub(
            r"^(BED_MESH_CALIBRATE\b.*)$",
            r"; SKIPPED \1",
            out,
            flags=re.MULTILINE,
        )

    if timelapse is False:
        out = re.sub(
            r"^(TIMELAPSE_(?:START|TAKE_FRAME)\b.*)$",
            r"; SKIPPED \1",
            out,
            flags=re.MULTILINE,
        )

    if ai_detection is False:
        out = re.sub(
            r"^((?:DEFECT_DETECTION_(?:START|DETECT(?:_BED)?)|DETECT_BED_PLATE)\b.*)$",
            r"; SKIPPED \1",
            out,
            flags=re.MULTILINE,
        )

    # Drop preheat + auto-feed for unused slots
    if used_slots is not None:
        out = re.sub(
            r"^SM_PRINT_(?:EXTRUDER_PREHEAT|AUTO_FEED)\s+EXTRUDER=(\d+).*$",
            lambda m: m.group(0) if int(m.group(1)) in used_slots else "; SKIPPED " + m.group(0),
            out,
            flags=re.MULTILINE,
        )

    # Flow calibrate: intersect user's choice with the actually-used slots
    effective: set[int] | None = None
    if calibrate_slots is not None and used_slots is not None:
        effective = calibrate_slots & used_slots
    elif calibrate_slots is not None:
        effective = calibrate_slots
    elif used_slots is not None:
        effective = used_slots

    if effective is not None:
        out = re.sub(
            r"^SM_PRINT_FLOW_CALIBRATE\s+EXTRUDER=(\d+).*$",
            lambda m: m.group(0) if int(m.group(1)) in effective else "; SKIPPED " + m.group(0),
            out,
            flags=re.MULTILINE,
        )

    if out == content:
        return None
    return out.encode("utf-8")


def get_live_status(moonraker_url: str, *, org_id: int) -> dict:
    """Get cached live status. On error, returns stale data or {state:'offline'}."""
    if not moonraker_url:
        return {"state": "unknown"}

    cached = get_cached_live_status(moonraker_url, org_id=org_id)
    if cached is not None:
        return cached

    # No cached data at all — must fetch (first ever load or >5min gap)
    try:
        status = _fetch_live_status(moonraker_url)
    except MoonrakerError as e:
        log.debug("Moonraker status fetch failed for %s: %s", moonraker_url, e)
        return {"state": "offline"}

    from app.services.cache import cache_set
    cache_url = _status_cache_url(moonraker_url)
    fresh_key = _status_cache_key("status", cache_url, org_id)
    stale_key = _status_cache_key("stale", cache_url, org_id)
    cache_set(fresh_key, status, int(STATUS_CACHE_TTL))
    cache_set(stale_key, status, STALE_CACHE_TTL)
    _status_cache[(org_id, cache_url)] = status
    return _apply_cached_bed_cleared(moonraker_url, status, org_id)


def _unwrap_cached_status(value: object) -> dict | None:
    if isinstance(value, dict):
        return value
    if (
        isinstance(value, tuple)
        and len(value) == 2
        and isinstance(value[1], dict)
    ):
        return value[1]
    return None


def get_cached_live_status(moonraker_url: str, *, org_id: int) -> dict | None:
    """Return fresh/stale cached status without network I/O."""
    if not moonraker_url:
        return None

    from app.services.cache import cache_get
    cache_url = _status_cache_url(moonraker_url)
    fresh_key = _status_cache_key("status", cache_url, org_id)
    stale_key = _status_cache_key("stale", cache_url, org_id)

    fresh = cache_get(fresh_key)
    if isinstance(fresh, dict):
        return _apply_cached_bed_cleared(moonraker_url, fresh, org_id)

    stale = cache_get(stale_key)
    if isinstance(stale, dict):
        return _apply_cached_bed_cleared(moonraker_url, stale, org_id)

    cached = _unwrap_cached_status(_status_cache.get((org_id, cache_url)))
    return _apply_cached_bed_cleared(moonraker_url, cached, org_id) if cached is not None else None


def invalidate_status(moonraker_url: str, *, org_id: int) -> None:
    """Force the next poll to fetch fresh state (call after pause/resume/cancel)."""
    from app.services.cache import cache_delete
    cache_url = _status_cache_url(moonraker_url)
    cache_delete(_status_cache_key("status", cache_url, org_id))
    _status_cache.pop((org_id, cache_url), None)
