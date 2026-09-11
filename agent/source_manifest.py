"""Source bundle manifest shared by packaging tests and tooling."""
from __future__ import annotations

import json
from pathlib import Path


SOURCE_FILES = tuple(
    json.loads(Path(__file__).with_name("source_manifest.json").read_text(encoding="utf-8"))
)
