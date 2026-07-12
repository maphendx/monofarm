from app.services.bambu_lan_dispatch import plate_gcode_from_metadata


def test_uses_cached_plate_gcode_metadata_without_reading_the_3mf():
    assert plate_gcode_from_metadata({"bambu_plate_gcode": "Metadata/plate_2.gcode"}) == "Metadata/plate_2.gcode"


def test_missing_plate_gcode_metadata_returns_none_for_legacy_files():
    assert plate_gcode_from_metadata({"types": ["PLA"]}) is None
