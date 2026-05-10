"""Thin Moonraker REST client.

Uses sync `requests` (network-bound, lightweight) — call from async via `asyncio.to_thread`.

The user's Mainsail URL may include a `?printer=<id>` query param — that's a Mainsail UI
bookkeeping detail and is NOT needed for Moonraker API calls. We strip it.
"""
from __future__ import annotations

import logging
import time
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit

import requests


log = logging.getLogger(__name__)
TIMEOUT = 30
STATUS_TIMEOUT = 5  # short timeout for live status polling
STATUS_CACHE_TTL = 10.0  # seconds
META_CACHE_TTL = 300.0  # file metadata is static for a given filename
META_TAIL_BYTES = 96 * 1024  # how much to download from remote file for parsing


class MoonrakerError(Exception):
    """Raised when Moonraker returns an error response."""


_status_cache: dict[str, tuple[float, dict]] = {}
_meta_cache: dict[tuple[str, str], tuple[float, dict]] = {}


def _api_base(url: str) -> str:
    """Strip path and query from a Mainsail URL → bare scheme://host[:port]."""
    s = urlsplit(url.strip())
    if not s.scheme or not s.netloc:
        raise MoonrakerError("Невалідний URL Moonraker")
    return urlunsplit((s.scheme, s.netloc, "", "", ""))


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


def upload_gcode(moonraker_url: str, file_path: Path, filename: str | None = None) -> dict:
    """Upload a .gcode/.3mf to Moonraker's `gcodes` root.

    Returns Moonraker's response: {item: {...}, print_started: bool, ...}.
    """
    base = _api_base(moonraker_url)
    name = filename or file_path.name
    with file_path.open("rb") as f:
        files = {"file": (name, f, "application/octet-stream")}
        data = {"root": "gcodes", "print": "false"}
        return _request("POST", base, "/server/files/upload", files=files, data=data)


def start_print(moonraker_url: str, filename: str) -> dict:
    """Start printing an already-uploaded file (no path, just bare filename)."""
    base = _api_base(moonraker_url)
    safe = quote(filename, safe="")
    return _request("POST", base, f"/printer/print/start?filename={safe}").get("result", {})


def pause_print(moonraker_url: str) -> dict:
    base = _api_base(moonraker_url)
    return _request("POST", base, "/printer/print/pause").get("result", {})


def resume_print(moonraker_url: str) -> dict:
    base = _api_base(moonraker_url)
    return _request("POST", base, "/printer/print/resume").get("result", {})


def cancel_print(moonraker_url: str) -> dict:
    base = _api_base(moonraker_url)
    return _request("POST", base, "/printer/print/cancel").get("result", {})


# ── Aggregated live status (cached) ─────────────────────────────────────────


# Map Moonraker print_stats.state → our printer state vocabulary
_STATE_MAP = {
    "standby": "idle",
    "ready": "idle",
    "printing": "printing",
    "paused": "paused",
    "complete": "operational",
    "completed": "operational",
    "cancelled": "idle",
    "canceled": "idle",
    "error": "error",
}


def _fetch_live_status(moonraker_url: str) -> dict:
    """Single Moonraker call returning normalized state for the dashboard."""
    base = _api_base(moonraker_url)
    objs = "print_stats&display_status&virtual_sdcard&extruder&heater_bed"
    try:
        resp = requests.get(
            f"{base}/printer/objects/query?{objs}", timeout=STATUS_TIMEOUT
        )
        resp.raise_for_status()
        data = resp.json().get("result", {}).get("status", {})
    except (requests.RequestException, ValueError) as e:
        raise MoonrakerError(str(e)) from e

    print_stats = data.get("print_stats") or {}
    display = data.get("display_status") or {}
    sdcard = data.get("virtual_sdcard") or {}
    extruder = data.get("extruder") or {}
    bed = data.get("heater_bed") or {}

    raw_state = (print_stats.get("state") or "").lower()
    state = _STATE_MAP.get(raw_state, raw_state or "unknown")

    progress = (
        display.get("progress")
        if display.get("progress") is not None
        else sdcard.get("progress")
    )
    progress_pct = round(progress * 100) if isinstance(progress, (int, float)) else None

    print_duration = print_stats.get("print_duration") or 0
    total_duration = print_stats.get("total_duration") or 0
    eta_minutes: int | None = None
    if state == "printing" and progress and progress > 0.01 and print_duration > 0:
        # naive estimate: assumes consistent speed
        total_estimated = print_duration / progress
        remaining = max(0, total_estimated - print_duration)
        eta_minutes = round(remaining / 60)

    return {
        "state": state,
        "raw_state": raw_state,
        "filename": print_stats.get("filename") or None,
        "progress_pct": progress_pct,
        "eta_minutes": eta_minutes,
        "print_duration_s": int(print_duration) if print_duration else None,
        "total_duration_s": int(total_duration) if total_duration else None,
        "extruder_temp": extruder.get("temperature"),
        "extruder_target": extruder.get("target"),
        "bed_temp": bed.get("temperature"),
        "bed_target": bed.get("target"),
    }


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


def get_remote_file_meta(moonraker_url: str, filename: str | None) -> dict:
    """Get filament metadata for a file stored on the printer.

    Tries Moonraker's own metadata first; falls back to downloading the file
    tail and running our gcode parser. Result is cached per (url, filename)
    for META_CACHE_TTL seconds.
    """
    if not moonraker_url or not filename:
        return {}
    key = (moonraker_url, filename)
    now = time.monotonic()
    cached = _meta_cache.get(key)
    if cached and now - cached[0] < META_CACHE_TTL:
        return cached[1]

    meta = _fetch_moonraker_metadata(moonraker_url, filename)
    # If colors are missing, fall back to parsing the file ourselves
    if not meta.get("colors"):
        parsed = _fetch_file_tail_and_parse(moonraker_url, filename)
        if parsed:
            # parsed wins for any field it has, but keep moonraker fields too
            meta = {**meta, **parsed}

    _meta_cache[key] = (now, meta)
    return meta


def get_live_status(moonraker_url: str) -> dict:
    """Get cached live status. On error, returns stale data or {state:'offline'}."""
    if not moonraker_url:
        return {"state": "unknown"}
    now = time.monotonic()
    cached = _status_cache.get(moonraker_url)
    if cached and now - cached[0] < STATUS_CACHE_TTL:
        return cached[1]
    try:
        status = _fetch_live_status(moonraker_url)
    except MoonrakerError as e:
        log.debug("Moonraker status fetch failed for %s: %s", moonraker_url, e)
        if cached:
            # serve stale within a longer window so transient blips don't flap UI
            return cached[1]
        status = {"state": "offline"}
    _status_cache[moonraker_url] = (now, status)
    return status
