"""Unit tests for the LAN project_file payload builder (OpenBambuAPI §6.7)."""
from app.services.bambu import build_start_print_payload


def test_cache_path_uses_ftp_url():
    cmd = build_start_print_payload("DEV1", "model.3mf", ftp_filename="cache/model.3mf")
    assert cmd["print"]["url"] == "ftp:///cache/model.3mf"


def test_root_path_uses_sdcard_url():
    cmd = build_start_print_payload("DEV1", "model.3mf", ftp_filename="model.3mf")
    assert cmd["print"]["url"] == "file:///sdcard/model.3mf"


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
