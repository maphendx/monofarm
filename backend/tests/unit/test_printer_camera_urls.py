from app.api.printers import _resolve_webcam_url


def test_u1_localhost_webcam_url_uses_printer_base() -> None:
    assert (
        _resolve_webcam_url(
            "http://192.168.1.50:7125",
            "http://localhost:7125/server/files/camera/monitor.jpg",
        )
        == "http://192.168.1.50:7125/server/files/camera/monitor.jpg"
    )


def test_relative_webcam_url_is_resolved_against_printer_base() -> None:
    assert _resolve_webcam_url("http://u1.local:7125", "webcam/?action=snapshot") == (
        "http://u1.local:7125/webcam/?action=snapshot"
    )
