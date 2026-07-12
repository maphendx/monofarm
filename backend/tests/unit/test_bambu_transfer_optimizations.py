from app.services.bambu_lan_dispatch import (
    bambu_upload_progress_update,
    plate_gcode_from_metadata,
)


def test_uses_cached_plate_gcode_metadata_without_reading_the_3mf():
    assert plate_gcode_from_metadata({"bambu_plate_gcode": "Metadata/plate_2.gcode"}) == "Metadata/plate_2.gcode"


def test_missing_plate_gcode_metadata_returns_none_for_legacy_files():
    assert plate_gcode_from_metadata({"types": ["PLA"]}) is None


def test_upload_progress_resets_when_agent_switches_from_download_to_ftps():
    state = (None, -1)

    state = bambu_upload_progress_update(*state, {"phase": "downloading", "sent": 90, "total": 100})
    assert state == ("downloading", 90, True)

    state = bambu_upload_progress_update(state[0], state[1], {"phase": "uploading", "sent": 0, "total": 100})
    assert state == ("uploading", 0, True)

    state = bambu_upload_progress_update(state[0], state[1], {"phase": "uploading", "sent": 4, "total": 100})
    assert state == ("uploading", 0, False)
