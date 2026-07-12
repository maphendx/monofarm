from app.services.moonraker import apply_bed_cleared_override


def test_bed_cleared_override_turns_completed_job_into_idle():
    status = {
        "state": "operational",
        "filename": "bench.gcode",
        "progress_pct": 100,
        "eta_minutes": 0,
        "error_msg": None,
    }

    result = apply_bed_cleared_override(
        status,
        {"filename": "bench.gcode"},
    )

    assert result == {
        "state": "idle",
        "filename": None,
        "progress_pct": None,
        "eta_minutes": None,
        "error_msg": None,
    }


def test_bed_cleared_override_is_removed_when_a_new_print_starts():
    status = {
        "state": "printing",
        "filename": "new-job.gcode",
        "progress_pct": 2,
    }

    result = apply_bed_cleared_override(
        status,
        {"filename": "old-job.gcode"},
    )

    assert result == status
