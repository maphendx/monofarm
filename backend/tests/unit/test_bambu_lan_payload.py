"""Unit tests for the LAN project_file payload builder (OpenBambuAPI §6.7)."""
from app.services.bambu import build_start_print_payload
from app.services.bambu_lan_dispatch import _bambu_upload_target_dir
from app.services.bambu_mapping import build_ams_mapping


class _Printer:
    def __init__(self, loaded_filaments):
        self.loaded_filaments = loaded_filaments
        self.slots = []


def test_cache_path_uses_ftp_url():
    cmd = build_start_print_payload("DEV1", "model.3mf", ftp_filename="cache/model.3mf")
    assert cmd["print"]["url"] == "ftp:///cache/model.3mf"


def test_root_path_uses_sdcard_url():
    cmd = build_start_print_payload("DEV1", "model.3mf", ftp_filename="model.3mf")
    assert cmd["print"]["url"] == "file:///sdcard/model.3mf"


def test_a1_uploads_to_sdcard_root():
    assert _bambu_upload_target_dir("A1") == "sdcard"
    assert _bambu_upload_target_dir("A1 mini") == "sdcard"


def test_p_and_x_series_upload_to_cache():
    assert _bambu_upload_target_dir("P1S") == "cache"
    assert _bambu_upload_target_dir("X1 Carbon") == "cache"


def test_ams_mapping_matches_material_and_color():
    printer = _Printer([
        {"slot": 0, "type": "PLA", "color": "#ffffff", "empty": False},
        {"slot": 1, "type": "PETG", "color": "#ff0000", "empty": False},
    ])
    mapping, use_ams, details = build_ams_mapping(
        {"types": ["PETG"], "colors": ["#ff0000"], "used_g": [12]},
        printer,
    )
    assert mapping == [1]
    assert use_ams is True
    assert details["source"][0] == "auto"


def test_external_spool_mapping_disables_ams():
    printer = _Printer([
        {"slot": 254, "type": "PLA", "color": "#00ff00", "empty": False},
    ])
    mapping, use_ams, _details = build_ams_mapping(
        {"types": ["PLA"], "colors": ["#00ff00"], "used_g": [8]},
        printer,
    )
    assert mapping == [254]
    assert use_ams is False


def test_http_url_takes_priority():
    cmd = build_start_print_payload(
        "DEV1", "model.3mf", http_url="https://r2.example/m.3mf", ftp_filename="cache/m.3mf"
    )
    assert cmd["print"]["url"] == "https://r2.example/m.3mf"


def test_task_id_override_for_job_correlation():
    cmd = build_start_print_payload("DEV1", "model.3mf", ftp_filename="m.3mf", task_id="corr123")
    assert cmd["print"]["task_id"] == "corr123"


def test_task_id_generated_when_absent():
    cmd = build_start_print_payload("DEV1", "model.3mf", ftp_filename="m.3mf")
    assert cmd["print"]["task_id"]


def test_ams_mapping_and_required_fields():
    cmd = build_start_print_payload(
        "DEV1", "model.3mf", ams_mapping=[1, -1], use_ams=True, ftp_filename="cache/m.3mf"
    )
    p = cmd["print"]
    assert p["ams_mapping"] == [1, -1]
    assert p["use_ams"] is True
    assert p["command"] == "project_file"
    assert p["param"] == "Metadata/plate_1.gcode"
    # both spellings — firmware generations disagree
    assert p["bed_leveling"] is True
    assert p["bed_levelling"] is True
    assert p["file"] == ""
    assert p["md5"] == ""
