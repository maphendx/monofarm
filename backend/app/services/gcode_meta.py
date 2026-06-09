"""Parse slicer-emitted metadata comments from .gcode / .3mf files.

Most slicers (PrusaSlicer / OrcaSlicer / SuperSlicer / Snaporca / Bambu Studio)
write metadata as comments at the END of the .gcode file, e.g.:

    ; filament_type = PLA;PLA
    ; filament_colour = #FF0000;#000000
    ; filament used [g] = 12.5;3.2
    ; estimated printing time (normal mode) = 4h 32m 15s

Multi-extruder/AMS values are joined with ';'. We split them into lists.

.3mf / .gcode.3mf: ZIP archive — we extract the embedded gcode and parse it.
OrcaSlicer places gcode at Metadata/plate_N.gcode inside the ZIP.
"""
import logging
import re
import zipfile
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
    # Bounding box — PrusaSlicer / Snaporca / OrcaSlicer
    "min_x": re.compile(r"^;(?:MINX|min_x)\s*[:=]\s*([\d.]+)", re.IGNORECASE),
    "max_x": re.compile(r"^;(?:MAXX|max_x)\s*[:=]\s*([\d.]+)", re.IGNORECASE),
    "min_y": re.compile(r"^;(?:MINY|min_y)\s*[:=]\s*([\d.]+)", re.IGNORECASE),
    "max_y": re.compile(r"^;(?:MAXY|max_y)\s*[:=]\s*([\d.]+)", re.IGNORECASE),
    "min_z": re.compile(r"^;(?:MINZ|min_z)\s*[:=]\s*([\d.]+)", re.IGNORECASE),
    "max_z": re.compile(r"^;(?:MAXZ|max_z)\s*[:=]\s*([\d.]+)", re.IGNORECASE),
    # OrcaSlicer / Bambu Studio: "; model size X: 85.4"
    "size_x": re.compile(r"^;\s*model size X\s*:\s*([\d.]+)", re.IGNORECASE),
    "size_y": re.compile(r"^;\s*model size Y\s*:\s*([\d.]+)", re.IGNORECASE),
    "size_z": re.compile(r"^;\s*model size Z\s*:\s*([\d.]+)", re.IGNORECASE),
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


def _read_chunks_from_bytes(data: bytes) -> str:
    """Same as _read_chunks but from an in-memory bytes object."""
    if len(data) <= HEAD_BYTES + TAIL_BYTES:
        return data.decode("utf-8", errors="ignore")
    head = data[:HEAD_BYTES]
    tail = data[len(data) - TAIL_BYTES:]
    return (head + b"\n" + tail).decode("utf-8", errors="ignore")


def _extract_gcode_from_3mf(path: Path) -> str:
    """Open a .3mf ZIP and return the text of the embedded gcode.

    OrcaSlicer stores gcode at Metadata/plate_N.gcode.
    We pick the first (lowest N) plate gcode found.
    """
    try:
        with zipfile.ZipFile(path, "r") as zf:
            names = zf.namelist()
            # Prefer Metadata/plate_N.gcode (OrcaSlicer / Bambu), fall back to any .gcode
            candidates = sorted(
                [n for n in names if n.lower().endswith((".gcode", ".gco", ".g"))],
                key=lambda n: (0 if "plate" in n.lower() else 1, n),
            )
            if not candidates:
                log.debug("No gcode found inside 3MF: %s", path)
                return ""
            gcode_name = candidates[0]
            log.debug("Extracting gcode from 3MF: %s → %s", path.name, gcode_name)
            raw = zf.read(gcode_name)
            return _read_chunks_from_bytes(raw)
    except (zipfile.BadZipFile, KeyError, OSError) as e:
        log.debug("Failed to read 3MF %s: %s", path, e)
        return ""


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


def _parse_text(text: str) -> dict:
    """Parse slicer comment metadata from gcode text."""
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
    # Snaporca/OrcaSlicer write 'filament used [g]/[m]' as comma-separated values;
    # PrusaSlicer's older format used semicolons. Accept either.
    if "filament_used_g" in raw:
        try:
            out["used_g"] = [
                round(float(x.strip()), 2)
                for x in raw["filament_used_g"].replace(";", ",").split(",")
                if x.strip()
            ]
        except ValueError:
            pass
    if "filament_used_m" in raw:
        try:
            out["used_m"] = [
                round(float(x.strip()), 2)
                for x in raw["filament_used_m"].replace(";", ",").split(",")
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

    # Print dimensions — prefer explicit model size, fall back to MINX/MAXX bbox
    try:
        if "size_x" in raw:
            out["print_size_x"] = round(float(raw["size_x"]), 1)
        elif "min_x" in raw and "max_x" in raw:
            out["print_size_x"] = round(float(raw["max_x"]) - float(raw["min_x"]), 1)
        if "size_y" in raw:
            out["print_size_y"] = round(float(raw["size_y"]), 1)
        elif "min_y" in raw and "max_y" in raw:
            out["print_size_y"] = round(float(raw["max_y"]) - float(raw["min_y"]), 1)
        if "size_z" in raw:
            out["print_size_z"] = round(float(raw["size_z"]), 1)
        elif "min_z" in raw and "max_z" in raw:
            out["print_size_z"] = round(float(raw["max_z"]) - float(raw["min_z"]), 1)
    except (ValueError, KeyError):
        pass

    return out


def parse_gcode(path: Path) -> dict:
    """Return a structured metadata dict (always returns at least {}).

    Supports: .gcode, .gco, .g, .bgcode, .3mf (including .gcode.3mf from OrcaSlicer).
    """
    suffixes = {s.lower() for s in path.suffixes}

    # 3MF: extract embedded gcode first
    if ".3mf" in suffixes:
        text = _extract_gcode_from_3mf(path)
        if not text:
            return {}
        return _parse_text(text)

    if path.suffix.lower() not in {".gcode", ".gco", ".g", ".bgcode"}:
        return {}

    text = _read_chunks(path)
    if not text:
        return {}
    return _parse_text(text)
