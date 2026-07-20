from __future__ import annotations

import io
import zipfile

import pytest

from app.services import bambu
from app.services.skip_objects import (
    InvalidSkipRequest,
    build_bambu_skip_payload,
    parse_bambu_plate_objects,
    validate_skip_request,
)


def test_rejects_unknown_excluded_and_last_remaining_object():
    objects = [
        {"id": "a", "name": "A", "excluded": False, "current": True, "bounds": None},
        {"id": "b", "name": "B", "excluded": True, "current": False, "bounds": None},
    ]

    with pytest.raises(InvalidSkipRequest, match="останній"):
        validate_skip_request(objects, ["a"])
    with pytest.raises(InvalidSkipRequest, match="вже пропущено"):
        validate_skip_request(objects, ["b"])
    with pytest.raises(InvalidSkipRequest, match="Невідомий"):
        validate_skip_request(objects, ["missing"])


def test_builds_native_bambu_payload():
    assert build_bambu_skip_payload([155, 165], sequence_id="42", timestamp=1_750_000_000) == {
        "print": {
            "command": "skip_objects",
            "sequence_id": "42",
            "timestamp": 1_750_000_000,
            "obj_list": [155, 165],
        }
    }


def test_parses_bambu_identify_ids_for_the_active_plate():
    xml = b"""<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="index" value="1"/>
    <object identify_id="155" name="Cube" skipped="false"/>
    <object identify_id="165" name="Cube (2)" skipped="false"/>
  </plate>
  <plate>
    <metadata key="index" value="2"/>
    <object identify_id="205" name="Other plate" skipped="false"/>
  </plate>
</config>"""
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("Metadata/slice_info.config", xml)

    objects = parse_bambu_plate_objects(archive.getvalue(), plate_index=1, excluded_ids={165})

    assert objects == [
        {"id": "155", "name": "Cube", "excluded": False, "current": False, "bounds": None},
        {"id": "165", "name": "Cube (2)", "excluded": True, "current": False, "bounds": None},
    ]


def test_bambu_report_tracks_skipped_objects_in_realtime(monkeypatch):
    bambu._state_cache.clear()
    bambu._last_state_redis_write.clear()
    bambu._dev_to_org["SKIP-REPORT"] = 42
    refreshes: list[tuple[str, str]] = []

    monkeypatch.setattr("app.services.cache.cache_get", lambda _key: None)
    monkeypatch.setattr("app.services.cache.cache_set", lambda *_args, **_kwargs: None)
    monkeypatch.setattr("app.services.cache.cache_delete", lambda _key: None)
    monkeypatch.setattr(bambu, "_sync_cloud_job_from_report", lambda *_args: None)
    monkeypatch.setattr(
        bambu,
        "_publish_printer_refresh",
        lambda dev_id, reason: refreshes.append((dev_id, reason)),
    )

    bambu._handle_report_payload(
        "SKIP-REPORT",
        {"print": {"gcode_state": "RUNNING", "s_obj": [155, "165"]}},
    )

    assert bambu._state_cache["SKIP-REPORT"]["skipped_object_ids"] == [155, 165]
    assert refreshes == [("SKIP-REPORT", "skip_objects")]
