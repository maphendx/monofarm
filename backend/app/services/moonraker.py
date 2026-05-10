"""Thin Moonraker REST client.

Uses sync `requests` (network-bound, lightweight) — call from async via `asyncio.to_thread`.

The user's Mainsail URL may include a `?printer=<id>` query param — that's a Mainsail UI
bookkeeping detail and is NOT needed for Moonraker API calls. We strip it.
"""
from __future__ import annotations

import logging
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import requests


log = logging.getLogger(__name__)
TIMEOUT = 30


class MoonrakerError(Exception):
    """Raised when Moonraker returns an error response."""


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
    return _request("POST", base, f"/printer/print/start?filename={filename}").get("result", {})


def pause_print(moonraker_url: str) -> dict:
    base = _api_base(moonraker_url)
    return _request("POST", base, "/printer/print/pause").get("result", {})


def resume_print(moonraker_url: str) -> dict:
    base = _api_base(moonraker_url)
    return _request("POST", base, "/printer/print/resume").get("result", {})


def cancel_print(moonraker_url: str) -> dict:
    base = _api_base(moonraker_url)
    return _request("POST", base, "/printer/print/cancel").get("result", {})
