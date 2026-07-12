"""Unit tests for the LAN project_file payload builder (OpenBambuAPI §6.7)."""
import io
import zipfile

from app.services.bambu import (
    build_ams_filament_setting_payload,
    build_start_print_payload,
    plate_gcode_entry,
    sanitize_sd_filename,
)
from app.services.bambu_lan_dispatch import _bambu_upload_target_dir
from app.services.bambu_mapping import build_ams_mapping


def _3mf_bytes(*entries: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name in entries:
            zf.writestr(name, b"G1 X0")
    return buf.getvalue()


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
    assert _bambu_upload_target_dir("N1") == "sdcard"
    assert _bambu_upload_target_dir(None, "030ABC123") == "sdcard"


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


def test_param_uses_detected_plate_gcode():
    cmd = build_start_print_payload(
        "DEV1", "model.3mf", ftp_filename="m.3mf", plate_gcode="Metadata/plate_2.gcode"
    )
    assert cmd["print"]["param"] == "Metadata/plate_2.gcode"


def test_plate_gcode_entry_keeps_project_plate_number():
    data = _3mf_bytes("Metadata/plate_2.gcode", "Metadata/plate_2.gcode.md5", "Metadata/plate_1.png")
    assert plate_gcode_entry(data) == "Metadata/plate_2.gcode"


def test_plate_gcode_entry_picks_lowest_plate():
    data = _3mf_bytes("Metadata/plate_10.gcode", "Metadata/plate_3.gcode")
    assert plate_gcode_entry(data) == "Metadata/plate_3.gcode"


def test_plate_gcode_entry_none_for_unsliced_or_garbage():
    assert plate_gcode_entry(_3mf_bytes("3D/3dmodel.model", "Metadata/plate_1.png")) is None
    assert plate_gcode_entry(b"not a zip") is None


def test_sanitize_sd_filename_replaces_spaces():
    assert (
        sanitize_sd_filename("Hero Light Fury 04026000_PLA_11h25m.gcode.3mf")
        == "Hero_Light_Fury_04026000_PLA_11h25m.gcode.3mf"
    )


def test_sanitize_sd_filename_drops_cyrillic_keeps_ascii_tail():
    assert sanitize_sd_filename("Сборка_PLA_5h27m.gcode.3mf") == "PLA_5h27m.gcode.3mf"


def test_sanitize_sd_filename_falls_back_when_stem_empties():
    assert sanitize_sd_filename("Сборка.gcode.3mf", fallback="job-7") == "job-7.gcode.3mf"
    assert sanitize_sd_filename("Сборка.3mf", fallback="job-7") == "job-7.3mf"


def test_ams_filament_setting_uses_local_tray_index_and_rgba_color():
    cmd = build_ams_filament_setting_payload(
        {"slot": 5, "type": "PLA", "color": "#ff0000", "empty": False}
    )
    p = cmd["print"]
    assert p["command"] == "ams_filament_setting"
    assert p["ams_id"] == 1
    assert p["tray_id"] == 1
    assert p["tray_color"] == "FF0000FF"
    assert p["tray_type"] == "PLA"


def test_ams_filament_setting_uses_external_spool_ids():
    cmd = build_ams_filament_setting_payload(
        {"slot": 254, "type": "PETG", "color": "#00ff00", "empty": False}
    )
    p = cmd["print"]
    assert p["ams_id"] == 255
    assert p["tray_id"] == 254
    assert p["tray_color"] == "00FF00FF"


def test_ams_filament_setting_clears_empty_tray():
    p = build_ams_filament_setting_payload({"slot": 0, "empty": True})["print"]
    assert p["tray_info_idx"] == ""
    assert p["tray_type"] == ""
    assert p["tray_color"] == "FFFFFF00"
