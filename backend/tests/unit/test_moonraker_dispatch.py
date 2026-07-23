"""Pure U1/Moonraker dispatch contract tests."""

import asyncio

import pytest

from app.models.printer import PrinterKind
from app.services.moonraker import MoonrakerError, upload_timeout_for_size
from app.services.moonraker_dispatch import (
    build_u1_mapping_script,
    interpret_upload_result,
    send_file_to_moonraker,
    validate_moonraker_filename,
)


def test_u1_mapping_uses_logical_to_physical_head_macros():
    assert build_u1_mapping_script({0: 2, 1: 0}) == (
        "SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=0 MAP_EXTRUDER=2\n"
        "SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=1 MAP_EXTRUDER=0\n"
        "SET_PRINT_USED_EXTRUDERS EXTRUDERS=2,0"
    )


def test_u1_mapping_rejects_two_logical_colors_on_one_head():
    with pytest.raises(MoonrakerError, match="одну голову"):
        build_u1_mapping_script({0: 1, 1: 1})


def test_u1_filename_is_basenamed_and_rejects_non_gcode():
    assert validate_moonraker_filename(PrinterKind.snapmaker_u1, "nested/part.gcode") == "part.gcode"
    with pytest.raises(MoonrakerError, match="Snapmaker U1"):
        validate_moonraker_filename(PrinterKind.snapmaker_u1, "part.3mf")


def test_upload_result_distinguishes_started_and_queued():
    assert interpret_upload_result({"result": {"print_started": True}}) == "started"
    assert interpret_upload_result({"result": {"print_queued": True}}) == "queued"
    assert interpret_upload_result({"result": {"print_started": False, "print_queued": False}}) == "not_started"


def test_upload_timeout_scales_for_large_files():
    assert upload_timeout_for_size(0) == 300.0
    assert upload_timeout_for_size(500 * 1024 * 1024) > 300.0
    assert upload_timeout_for_size(10 * 1024 * 1024 * 1024) == 3600.0


def test_u1_upload_maps_then_explicitly_starts_without_rewriting_logical_tools(tmp_path, monkeypatch):
    from app.services import moonraker, tunnel

    source = tmp_path / "part.gcode"
    source.write_bytes(b"T0\nT1\n")
    calls: list[tuple[str, object]] = []

    async def fake_upload(url, path, filename, start_print=False, timeout=None):
        calls.append(("upload", start_print))
        return {"result": {"print_started": False, "print_queued": False}}

    monkeypatch.setattr(tunnel, "has_tunnel", lambda _org_id: False)
    monkeypatch.setattr(moonraker, "async_upload_gcode", fake_upload)
    monkeypatch.setattr(moonraker, "send_gcode", lambda _url, script: calls.append(("gcode", script)) or {})

    result = asyncio.run(send_file_to_moonraker(
        org_id=1,
        moonraker_url="http://u1.local",
        src=source,
        file_name="part.gcode",
        filament_meta={},
        slot_map={0: 2, 1: 0},
        printer_kind=PrinterKind.snapmaker_u1,
    ))

    # U1 unloads any stale "loaded" file before uploading, then maps + starts.
    assert calls[0] == ("gcode", "SDCARD_RESET_FILE")
    assert calls[1] == ("upload", False)
    assert calls[2] == ("gcode", build_u1_mapping_script({0: 2, 1: 0}))
    assert calls[3] == ("gcode", 'SDCARD_PRINT_FILE FILENAME="part.gcode"')
    assert result["start_requested"] is True
    assert source.read_bytes() == b"T0\nT1\n"


def test_u1_unloads_loaded_file_before_upload_then_other_kind_does_not(tmp_path, monkeypatch):
    """U1 must reset the loaded file first (avoids Moonraker 403 on re-dispatch);
    non-U1 Moonraker printers must not, since the upload itself starts them."""
    from app.services import moonraker, tunnel

    def run(kind: PrinterKind) -> list[tuple[str, object]]:
        source = tmp_path / "part.gcode"
        source.write_bytes(b"G1 X1\n")
        calls: list[tuple[str, object]] = []

        async def fake_upload(url, path, filename, start_print=False, timeout=None):
            calls.append(("upload", start_print))
            return {"result": {"print_started": True}}

        monkeypatch.setattr(tunnel, "has_tunnel", lambda _org_id: False)
        monkeypatch.setattr(moonraker, "async_upload_gcode", fake_upload)
        monkeypatch.setattr(
            moonraker, "send_gcode",
            lambda _url, script: calls.append(("gcode", script)) or {},
        )
        asyncio.run(send_file_to_moonraker(
            org_id=1,
            moonraker_url="http://mr.local",
            src=source,
            file_name="part.gcode",
            filament_meta={},
            slot_map={0: 0},
            printer_kind=kind,
        ))
        return calls

    u1_calls = run(PrinterKind.snapmaker_u1)
    assert ("gcode", "SDCARD_RESET_FILE") in u1_calls
    assert u1_calls.index(("gcode", "SDCARD_RESET_FILE")) < u1_calls.index(("upload", False))

    other_calls = run(PrinterKind.other)
    assert ("gcode", "SDCARD_RESET_FILE") not in other_calls


def test_u1_options_use_agent_local_transform_with_direct_url(tmp_path, monkeypatch):
    from app.services import moonraker, tunnel

    source = tmp_path / "large.gcode"
    source.write_bytes(b"TIMELAPSE_START\nG1 X1\n")
    upload: dict = {}

    async def fake_tunnel_upload(
        _org_id,
        _url,
        _filename,
        _file_bytes,
        **kwargs,
    ):
        upload.update(kwargs)
        return {"result": {"print_started": False}}

    async def fake_action(_org_id, _url, path, body, **_kwargs):
        return {"path": path, "script": body["script"]}

    monkeypatch.setattr(tunnel, "has_tunnel", lambda _org_id: True)
    monkeypatch.setattr(tunnel, "has_capability", lambda _org_id, _capability: True)
    monkeypatch.setattr(tunnel, "send_moonraker_upload", fake_tunnel_upload)
    monkeypatch.setattr(tunnel, "moonraker_action", fake_action)
    monkeypatch.setattr(
        moonraker,
        "apply_print_options",
        lambda *_args, **_kwargs: pytest.fail("cloud must not rewrite the large file"),
    )

    asyncio.run(send_file_to_moonraker(
        org_id=1,
        moonraker_url="http://u1.local",
        src=source,
        file_name="large.gcode",
        filament_meta={"used_g": [1, 1], "types": ["PLA", "PLA"]},
        slot_map={0: 0, 1: 1},
        printer_kind=PrinterKind.snapmaker_u1,
        timelapse=False,
        calibrate_slots=[],
        presigned_url="https://r2.example/large.gcode?sig=x",
    ))

    assert upload["presigned_url"] == "https://r2.example/large.gcode?sig=x"
    assert upload["print_options"] == {
        "auto_bed_leveling": None,
        "timelapse": False,
        "ai_detection": None,
        "used_slots": None,
        "calibrate_slots": [],
    }
