"""Create a per-job Chitu PlateCycler 3MF without modifying the source file."""
from __future__ import annotations

import hashlib
import io
import zipfile


class PlateCycler3MFError(ValueError):
    pass


# Current sequence used by Chitu's official browser converter. Keep this in one
# place: these coordinates are hardware-specific and must never be generalized
# to another printer model.
_CHITU_C1M_SWAP_GCODE = """\
G0 X-10 F5000
G0 Z175
G0 Y-5 F2000
G0 Y186.5 F2000
G0 Y182 F10000
G0 Z186
G0 X180 F5000
G0 Y120 F500
G0 Y-4 Z175 X-15 F3000
G0 Y145
G0 Y115 F1000
G0 Y25 F500
G0 Y85 F1000
G0 Y180 F1000
G0 X-10 F5000
G4 P500
G0 Y186.5 F200
G4 P500
G0 Y3 F3000
G0 Y-5 F200
G4 P500
G0 Y10 F1000
G0 Z100 Y186 F2000
G0 Y150
G4 P1000
"""


def build_platecycler_3mf(
    source: bytes,
    *,
    cooldown_temp_c: int,
    delay_seconds: int = 0,
    eject_after_print: bool = True,
) -> bytes:
    """Return a derived single-plate 3MF with the C1M swap sequence appended."""
    if not 20 <= cooldown_temp_c <= 80:
        raise PlateCycler3MFError("cooldown_temp_c must be between 20 and 80")
    if not 0 <= delay_seconds <= 3600:
        raise PlateCycler3MFError("delay_seconds must be between 0 and 3600")

    try:
        source_archive = zipfile.ZipFile(io.BytesIO(source), "r")
    except zipfile.BadZipFile as exc:
        raise PlateCycler3MFError("source is not a valid 3MF archive") from exc

    with source_archive:
        gcode_names = [
            name
            for name in source_archive.namelist()
            if name.lower().startswith("metadata/plate_")
            and name.lower().endswith(".gcode")
        ]
        if len(gcode_names) != 1:
            raise PlateCycler3MFError("PlateCycler AutoPrint requires exactly one sliced plate")

        gcode_name = gcode_names[0]
        source_gcode = source_archive.read(gcode_name)
        if not eject_after_print:
            return source

        suffix = [
            b"\n; MONOFARM PLATECYCLER START\n",
            f"M190 S{cooldown_temp_c} ; wait for build plate cooling\n".encode(),
            _CHITU_C1M_SWAP_GCODE.encode(),
        ]
        if delay_seconds:
            suffix.append(f"G4 S{delay_seconds} ; configured inter-print delay\n".encode())
        suffix.append(b"; MONOFARM PLATECYCLER END\n")
        converted_gcode = source_gcode.rstrip(b"\r\n") + b"\n" + b"".join(suffix)
        md5_name = f"{gcode_name}.md5"

        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as target:
            for info in source_archive.infolist():
                if info.filename in {gcode_name, md5_name}:
                    continue
                target.writestr(info, source_archive.read(info.filename))
            target.writestr(gcode_name, converted_gcode, compress_type=zipfile.ZIP_DEFLATED)
            target.writestr(
                md5_name,
                hashlib.md5(converted_gcode).hexdigest(),
                compress_type=zipfile.ZIP_DEFLATED,
            )
        return output.getvalue()
