"""Snapmaker U1 print_task_config → FilamentSlot decoding.

Field semantics hardware-verified by the u1hub project: colors come from
print_task_config (touchscreen-assigned, persists with the spool), NOT from
filament_detect (RFID-only — third-party spools read blank there).
"""

from app.services.moonraker import u1_slots_from_task_config


def test_decodes_loaded_slots_with_colors_and_material():
    ptc = {
        "filament_exist": [True, True, False, True],
        "filament_color_rgba": ["FF0000FF", "#00ff00ff", "", "0000FFFF"],
        "filament_type": ["PLA", "PETG", "", "TPU"],
        "filament_official": [True, False, False, False],
    }
    slots = u1_slots_from_task_config(ptc)
    assert len(slots) == 4
    assert slots[0] == {
        "slot": 0, "color": "#FF0000", "color_name": None, "type": "PLA",
        "brand": "Snapmaker", "filament_id": None, "empty": False, "unit_id": None,
        "verified": True,
    }
    assert slots[1]["color"] == "#00FF00"
    assert slots[1]["brand"] is None
    assert slots[2]["empty"] is True
    assert slots[3]["type"] == "TPU"


def test_returns_none_without_filament_exist():
    assert u1_slots_from_task_config({}) is None
    assert u1_slots_from_task_config({"filament_type": ["PLA"]}) is None


def test_status_parser_exposes_u1_filaments():
    from app.services.moonraker import _parse_moonraker_status

    status = _parse_moonraker_status({
        "print_stats": {"state": "standby"},
        "print_task_config": {
            "filament_exist": [True, False, False, False],
            "filament_color_rgba": ["ABCDEFFF"],
            "filament_type": ["PLA"],
        },
    })
    assert status["u1_filaments"][0]["color"] == "#ABCDEF"
    assert status["u1_filaments"][1]["empty"] is True

    plain = _parse_moonraker_status({"print_stats": {"state": "standby"}})
    assert plain.get("u1_filaments") is None
