"""Pure parsers for Anycubic Kobra LAN reports — the backend-side twin of
agent/anycubic_local/models.py. Duplicated deliberately: agent/ and backend/
are separate deployables with separate dependency sets, and this parsing logic
is small, stable, and fully defined by the printer's wire protocol (see
chrisfore/anycubic_ha_local, MIT License, research/PROTOCOL-VALIDATED.md).

The agent relays raw MQTT report `.data` payloads unparsed (mirrors how Bambu
LAN reports are parsed server-side in services/bambu.py) — parsing happens here.
"""
from __future__ import annotations

STATE_FREE = "free"
PAUSE_PAUSED = 1


def parse_info(data: dict) -> dict:
    """Parse a raw `info` report `.data` object into a flat state dict."""
    temp = data.get("temp") or {}
    proj = data.get("project") or data.get("last_project") or {}
    raw_state = data.get("state")
    proj_state = proj.get("state")
    pause_code = proj.get("pause")
    status = proj_state if raw_state != STATE_FREE and proj_state else (
        "idle" if raw_state == STATE_FREE else raw_state)
    return {
        "status": status,
        "paused": pause_code == PAUSE_PAUSED,
        "filename": proj.get("filename"),
        "progress": proj.get("progress"),
        "current_layer": proj.get("curr_layer"),
        "total_layers": proj.get("total_layers"),
        "remain_time": proj.get("remain_time"),
        "nozzle_temp": temp.get("curr_nozzle_temp"),
        "nozzle_target": temp.get("target_nozzle_temp"),
        "bed_temp": temp.get("curr_hotbed_temp"),
        "bed_target": temp.get("target_hotbed_temp"),
        "camera_url": (data.get("urls") or {}).get("rtspUrl"),
    }


def _rgb_hex(color) -> str | None:
    if not color or len(color) < 3:
        return None
    return "#{:02X}{:02X}{:02X}".format(color[0], color[1], color[2])


def _opt(s):
    return s if s not in ("", None) else None


def parse_multicolorbox(data: dict) -> list[dict]:
    """Parse a raw `multiColorBox` report `.data` object into a list of box dicts."""
    out = []
    for b in data.get("multi_color_box", []):
        dry = b.get("drying_status") or {}
        humidity = b.get("humidity")
        if humidity is None:
            humidity = dry.get("humidity")
        out.append({
            "id": b["id"],
            "box_status": b.get("status"),
            "loaded_slot": b.get("loaded_slot"),
            "temp": b.get("temp"),
            "humidity": humidity,
            "slots": {
                s["index"]: {
                    "index": s["index"],
                    "material": _opt(s.get("type")),
                    "color_hex": _rgb_hex(s.get("color")),
                    "remaining": s.get("consumables_percent"),
                    "loaded": s.get("status") == 5,
                }
                for s in b.get("slots", [])
            },
        })
    return out


def merge_boxes(prev: list[dict], new: list[dict]) -> list[dict]:
    """Merge new box readings into prev by box id and slot index; never overwrite a known value with None."""
    by_id = {b["id"]: dict(b, slots=dict(b.get("slots") or {})) for b in prev}
    for nb in new:
        ob = by_id.get(nb["id"])
        if ob is None:
            by_id[nb["id"]] = dict(nb, slots=dict(nb.get("slots") or {}))
            continue
        for key in ("box_status", "loaded_slot", "temp", "humidity"):
            if nb.get(key) is not None:
                ob[key] = nb[key]
        ob["slots"].update(nb.get("slots") or {})
    return list(by_id.values())
