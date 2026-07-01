from app.services.autoprint import _file_safety_error, is_a1_mini


def test_a1_mini_model_detection_is_normalized() -> None:
    assert is_a1_mini("Bambu Lab A1 mini")
    assert is_a1_mini("A1-MINI")
    assert not is_a1_mini("Bambu Lab A1")
    assert not is_a1_mini("P1S")


def test_platecycler_file_safety_rejects_wrong_printer_and_oversize() -> None:
    assert _file_safety_error({"printer_model": "P1S"}) == "3MF підготовлений не для Bambu A1 Mini"
    assert "print_size_y=171" in (
        _file_safety_error(
            {
                "printer_model": "A1 mini",
                "print_size_x": 180,
                "print_size_y": 171,
                "print_size_z": 160,
            }
        )
        or ""
    )
    assert _file_safety_error(
        {
            "printer_model": "A1 mini",
            "print_size_x": 180,
            "print_size_y": 170,
            "print_size_z": 160,
        }
    ) is None
