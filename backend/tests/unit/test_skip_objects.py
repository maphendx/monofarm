from __future__ import annotations

import io
import zipfile
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.services import bambu
from app.services.skip_objects import (
    InvalidSkipRequest,
    build_bambu_skip_payload,
    merge_bambu_excluded_state,
    parse_bambu_plate_objects,
    select_bambu_source_job,
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


def test_parses_bambu_objects_from_disk_without_loading_whole_file(tmp_path):
    source_path = tmp_path / "large-model.gcode.3mf"
    with zipfile.ZipFile(source_path, "w") as zf:
        zf.writestr(
            "Metadata/slice_info.config",
            '<config><plate><metadata key="index" value="1"/>'
            '<object identify_id="155" name="Cube" skipped="false"/>'
            '<object identify_id="165" name="Cube 2" skipped="false"/>'
            "</plate></config>",
        )

    objects = parse_bambu_plate_objects(source_path)

    assert [obj["id"] for obj in objects] == ["155", "165"]


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


def test_merges_live_skipped_ids_without_reparsing_the_3mf():
    objects = [
        {"id": "155", "name": "A", "excluded": False, "current": False, "bounds": None},
        {"id": "165", "name": "B", "excluded": False, "current": False, "bounds": None},
    ]

    merged = merge_bambu_excluded_state(objects, {165})

    assert merged[0]["excluded"] is False
    assert merged[1]["excluded"] is True
    assert objects[1]["excluded"] is False


def test_select_bambu_source_job_recovers_matching_large_file_after_timeout():
    now = datetime(2026, 7, 20, 13, 0, tzinfo=timezone.utc)
    unrelated_active = SimpleNamespace(
        id=8,
        status="printing",
        file_name="next-job.3mf",
        created_at=now,
    )
    matching_failed = SimpleNamespace(
        id=7,
        status="failed",
        file_name="Large Model_PLA_2d4h.gcode.3mf",
        created_at=now - timedelta(hours=4),
    )

    selected = select_bambu_source_job(
        [unrelated_active, matching_failed],
        "cache/Large+Model_PLA_2d4h.gcode.3mf",
        now=now,
    )

    assert selected is matching_failed


def test_select_bambu_source_job_does_not_reuse_stale_or_completed_print():
    now = datetime(2026, 7, 20, 13, 0, tzinfo=timezone.utc)
    jobs = [
        SimpleNamespace(
            status="failed",
            file_name="same-name.3mf",
            created_at=now - timedelta(days=8),
        ),
        SimpleNamespace(
            status="completed",
            file_name="same-name.3mf",
            created_at=now - timedelta(minutes=5),
        ),
    ]

    assert select_bambu_source_job(jobs, "same-name.3mf", now=now) is None
