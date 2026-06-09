"""Klipper firmware compatibility matrix.

Maps feature names to the minimum Klipper version (major, minor, patch) that
introduced them. Used to show compatibility badges in the printer onboarding wizard
and on printer detail cards.
"""
from __future__ import annotations

import re

# feature → (major, minor, patch) minimum Klipper version
FEATURE_REQUIREMENTS: dict[str, tuple[int, int, int]] = {
    "exclude_object": (0, 11, 0),
    "input_shaper":   (0, 10, 0),
    "skew_correction":(0, 10, 0),
    "bed_mesh":       (0,  9, 0),
    "multi_extruder": (0, 10, 0),
}

FEATURE_LABELS: dict[str, str] = {
    "exclude_object": "Exclude Object",
    "input_shaper":   "Input Shaper",
    "skew_correction":"Skew Correction",
    "bed_mesh":       "Bed Mesh",
    "multi_extruder": "Multi-Extruder",
}


def parse_klipper_version(version_str: str) -> tuple[int, int, int] | None:
    """Parse 'v0.12.0-123-gabcdef' → (0, 12, 0). Returns None if unparseable."""
    m = re.match(r"v?(\d+)\.(\d+)\.(\d+)", version_str or "")
    if not m:
        return None
    return int(m.group(1)), int(m.group(2)), int(m.group(3))


def get_features(firmware_version: str | None) -> dict[str, bool | None]:
    """Return {feature: supported} for the given Klipper version string.

    Value is None when version cannot be parsed (unknown firmware).
    Value is True/False when a version is known.
    """
    ver = parse_klipper_version(firmware_version or "")
    if ver is None:
        return {k: None for k in FEATURE_REQUIREMENTS}
    return {
        feature: ver >= min_ver
        for feature, min_ver in FEATURE_REQUIREMENTS.items()
    }
