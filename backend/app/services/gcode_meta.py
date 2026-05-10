"""Parse slicer-emitted metadata comments from .gcode files.

Most slicers (PrusaSlicer / OrcaSlicer / SuperSlicer / Snaporca / Bambu Studio)
write metadata as comments at the END of the .gcode file, e.g.:

    ; filament_type = PLA;PLA
    ; filament_colour = #FF0000;#000000
    ; filament used [g] = 12.5;3.2
    ; estimated printing time (normal mode) = 4h 32m 15s

Multi-extruder/AMS values are joined with ';'. We split them into lists.
.3mf is a zip — not handled here yet.
"""
import logging
import re
from pathlib import Path

log = logging.getLogger(__name__)

# Read this much from the END of the file (where most slicers put their summary).
TAIL_BYTES = 64 * 1024
HEAD_BYTES = 32 * 1024  # some slicers also put metadata at the top

PATTERNS = {
    "filament_type": re.compile(r"^;\s*filament_type\s*=\s*(.+)$", re.IGNORECASE),
    "filament_colour": re.compile(r"^;\s*filament_colou?r\s*=\s*(.+)$", re.IGNORECASE),
    "filament_used_g": re.compile(r"^;\s*filament used\s*\[g\]\s*=\s*(.+)$", re.IGNORECASE),
    "filament_used_m": re.compile(r"^;\s*filament used\s*\[m\]\s*=\s*(.+)$", re.IGNORECASE),
    "estimated_time": re.compile(
        r"^;\s*estimated printing time(?:\s*\([^)]*\))?\s*=\s*(.+)$", re.IGNORECASE
    ),
    "total_layers": re.compile(r"^;\s*total layer(?:s| count)\s*=?\s*(\d+)$", re.IGNORECASE),
    "layer_height": re.compile(r"^;\s*layer_height\s*=\s*([\d.]+)", re.IGNORECASE),
    "nozzle_diameter": re.compile(
        r"^;\s*nozzle_diameter\s*=\s*(.+)$", re.IGNORECASE
    ),
}


def _read_chunks(path: Path) -> str:
    """Return TAIL + HEAD of file as one string (deduplicated when small)."""
    try:
        size = path.stat().st_size
    except OSError:
        return ""
    with path.open("rb") as f:
        if size <= HEAD_BYTES + TAIL_BYTES:
            data = f.read()
        else:
            head = f.read(HEAD_BYTES)
            f.seek(size - TAIL_BYTES)
            tail = f.read()
            data = head + b"\n" + tail
    return data.decode("utf-8", errors="ignore")


def _parse_time_str(s: str) -> int | None:
    """'4h 32m 15s' → minutes (rounded). Also handles '4h32m', '32m', '90s', '1d 2h'."""
    if not s:
        return None
    total = 0
    for n, unit in re.findall(r"(\d+)\s*([dhms])", s.lower()):
        n = int(n)
        if unit == "d":
            total += n * 24 * 60
        elif unit == "h":
            total += n * 60
        elif unit == "m":
            total += n
        elif unit == "s":
            total += round(n / 60)
    return total or None


def parse_gcode(path: Path) -> dict:
    """Return a structured metadata dict (always returns at least {})."""
    if path.suffix.lower() not in {".gcode", ".gco", ".g", ".bgcode"}:
        return {}

    text = _read_chunks(path)
    if not text:
        return {}

    raw: dict[str, str] = {}
    for line in text.splitlines():
        if not line.startswith(";"):
            continue
        for key, pattern in PATTERNS.items():
            if key in raw:
                continue
            m = pattern.match(line)
            if m:
                raw[key] = m.group(1).strip()

    out: dict = {}

    if "filament_type" in raw:
        out["types"] = [t.strip() for t in raw["filament_type"].split(";") if t.strip()]
    if "filament_colour" in raw:
        out["colors"] = [c.strip() for c in raw["filament_colour"].split(";") if c.strip()]
    if "filament_used_g" in raw:
        try:
            out["used_g"] = [
                round(float(x.strip()), 2)
                for x in raw["filament_used_g"].split(";")
                if x.strip()
            ]
        except ValueError:
            pass
    if "filament_used_m" in raw:
        try:
            out["used_m"] = [
                round(float(x.strip()), 2)
                for x in raw["filament_used_m"].split(";")
                if x.strip()
            ]
        except ValueError:
            pass

    minutes = _parse_time_str(raw.get("estimated_time", ""))
    if minutes:
        out["estimated_minutes"] = minutes

    if "total_layers" in raw:
        try:
            out["total_layers"] = int(raw["total_layers"])
        except ValueError:
            pass
    if "layer_height" in raw:
        try:
            out["layer_height"] = float(raw["layer_height"])
        except ValueError:
            pass

    return out
