from __future__ import annotations

import hashlib
import io
import zipfile

import pytest

from app.services.platecycler_3mf import PlateCycler3MFError, build_platecycler_3mf


def _source_3mf(*, extra_plate: bool = False) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", "<Types />")
        archive.writestr("3D/3dmodel.model", "<model />")
        archive.writestr("Metadata/plate_1.gcode", "G28\nM104 S0\n")
        archive.writestr("Metadata/plate_1.gcode.md5", "stale")
        archive.writestr("Metadata/plate_1.png", b"preview")
        if extra_plate:
            archive.writestr("Metadata/plate_2.gcode", "G28\n")
    return buf.getvalue()


def test_build_platecycler_3mf_appends_cooling_swap_and_updates_md5() -> None:
    converted = build_platecycler_3mf(
        _source_3mf(),
        cooldown_temp_c=40,
        delay_seconds=90,
    )

    with zipfile.ZipFile(io.BytesIO(converted)) as archive:
        gcode = archive.read("Metadata/plate_1.gcode")
        stored_md5 = archive.read("Metadata/plate_1.gcode.md5").decode()

        assert gcode.startswith(b"G28\nM104 S0\n")
        assert b"; MONOFARM PLATECYCLER START" in gcode
        assert b"M190 S40" in gcode
        assert b"G4 S90" in gcode
        assert b"G0 X-10 F5000" in gcode
        assert gcode.rstrip().endswith(b"; MONOFARM PLATECYCLER END")
        assert stored_md5 == hashlib.md5(gcode).hexdigest()
        assert archive.read("3D/3dmodel.model") == b"<model />"
        assert archive.read("Metadata/plate_1.png") == b"preview"


@pytest.mark.parametrize(
    ("cooldown_temp_c", "delay_seconds"),
    [(19, 0), (81, 0), (40, -1), (40, 3601)],
)
def test_build_platecycler_3mf_rejects_unsafe_settings(
    cooldown_temp_c: int,
    delay_seconds: int,
) -> None:
    with pytest.raises(PlateCycler3MFError):
        build_platecycler_3mf(
            _source_3mf(),
            cooldown_temp_c=cooldown_temp_c,
            delay_seconds=delay_seconds,
        )


def test_build_platecycler_3mf_rejects_multi_plate_source() -> None:
    with pytest.raises(PlateCycler3MFError, match="exactly one"):
        build_platecycler_3mf(_source_3mf(extra_plate=True), cooldown_temp_c=40)


def test_build_platecycler_3mf_rejects_corrupt_archive() -> None:
    with pytest.raises(PlateCycler3MFError, match="valid 3MF"):
        build_platecycler_3mf(b"not a zip", cooldown_temp_c=40)
