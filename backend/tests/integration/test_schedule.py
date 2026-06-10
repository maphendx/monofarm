"""Calendar scheduling integration tests.

Covers:
- create plan entry with scheduling fields
- calendar endpoint returns lanes with conflict flags
- PATCH updates scheduling fields
- unschedule (reset to asap)
- not_before / exact_time / window eligibility (unit-level via service)
- conflict detection between overlapping timed entries
- date-range validation
"""
from __future__ import annotations

from datetime import date, time, timedelta

import pytest

from app.models.plan import PlanEntry
from app.models.printer import Printer, PrinterKind
from app.models.task import PrintTask, PrintTaskStatus
from app.services.schedule_conflict import (
    BLOCKED_WAITING,
    BLOCKED_WINDOW_EXPIRED,
    check_eligibility,
    detect_conflicts,
    entry_end_time,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_printer(db_session, org_id: int, name: str = "P1") -> Printer:
    p = Printer(
        organization_id=org_id,
        name=name,
        kind=PrinterKind.snapmaker_u1,
        moonraker_url="http://moonraker.local",
        is_active=True,
    )
    db_session.add(p)
    db_session.commit()
    db_session.refresh(p)
    return p


def _make_task(db_session, org_id: int, title: str = "task", minutes: int = 120) -> PrintTask:
    t = PrintTask(
        organization_id=org_id,
        title=title,
        status=PrintTaskStatus.queued,
        estimated_minutes=minutes,
    )
    db_session.add(t)
    db_session.commit()
    db_session.refresh(t)
    return t


def _make_entry(
    db_session,
    org_id: int,
    printer_id: int,
    task_id: int,
    plan_date: date | None = None,
    start_time: time | None = None,
    schedule_mode: str = "asap",
) -> PlanEntry:
    e = PlanEntry(
        organization_id=org_id,
        plan_date=plan_date or date.today(),
        printer_id=printer_id,
        task_id=task_id,
        start_time=start_time,
        schedule_mode=schedule_mode,
    )
    db_session.add(e)
    db_session.commit()
    db_session.refresh(e)
    return e


# ---------------------------------------------------------------------------
# API tests
# ---------------------------------------------------------------------------

class TestCreateWithScheduling:
    def test_create_asap_default(self, client, auth_headers, db_session, test_org):
        printer = _make_printer(db_session, test_org.id)
        task = _make_task(db_session, test_org.id)
        resp = client.post(
            "/api/plan",
            headers=auth_headers,
            json={
                "plan_date": str(date.today()),
                "printer_id": printer.id,
                "task_id": task.id,
            },
        )
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["schedule_mode"] == "asap"
        assert body["start_time"] is None
        assert body["conflict"] is False

    def test_create_with_start_time(self, client, auth_headers, db_session, test_org):
        printer = _make_printer(db_session, test_org.id)
        task = _make_task(db_session, test_org.id)
        resp = client.post(
            "/api/plan",
            headers=auth_headers,
            json={
                "plan_date": str(date.today()),
                "printer_id": printer.id,
                "task_id": task.id,
                "start_time": "08:00:00",
                "schedule_mode": "exact_time",
                "priority": 5,
            },
        )
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["schedule_mode"] == "exact_time"
        assert body["start_time"] == "08:00:00"
        assert body["priority"] == 5

    def test_create_window_mode(self, client, auth_headers, db_session, test_org):
        printer = _make_printer(db_session, test_org.id)
        task = _make_task(db_session, test_org.id)
        resp = client.post(
            "/api/plan",
            headers=auth_headers,
            json={
                "plan_date": str(date.today()),
                "printer_id": printer.id,
                "task_id": task.id,
                "schedule_mode": "window",
                "window_start_at": "2026-06-10T06:00:00Z",
                "window_end_at": "2026-06-10T18:00:00Z",
            },
        )
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["schedule_mode"] == "window"
        assert body["window_start_at"] is not None


class TestPatchScheduling:
    def test_patch_set_start_time(self, client, auth_headers, db_session, test_org):
        printer = _make_printer(db_session, test_org.id)
        task = _make_task(db_session, test_org.id)
        create = client.post(
            "/api/plan",
            headers=auth_headers,
            json={"plan_date": str(date.today()), "printer_id": printer.id, "task_id": task.id},
        )
        entry_id = create.json()["id"]

        resp = client.patch(
            f"/api/plan/{entry_id}",
            headers=auth_headers,
            json={"start_time": "14:30:00", "schedule_mode": "not_before"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["start_time"] == "14:30:00"
        assert body["schedule_mode"] == "not_before"

    def test_patch_unschedule_to_asap(self, client, auth_headers, db_session, test_org):
        printer = _make_printer(db_session, test_org.id)
        task = _make_task(db_session, test_org.id)
        create = client.post(
            "/api/plan",
            headers=auth_headers,
            json={
                "plan_date": str(date.today()),
                "printer_id": printer.id,
                "task_id": task.id,
                "start_time": "09:00:00",
                "schedule_mode": "exact_time",
            },
        )
        entry_id = create.json()["id"]

        resp = client.patch(
            f"/api/plan/{entry_id}",
            headers=auth_headers,
            json={"schedule_mode": "asap"},
        )
        assert resp.status_code == 200
        assert resp.json()["schedule_mode"] == "asap"


class TestCalendarEndpoint:
    def test_calendar_default_week(self, client, auth_headers, db_session, test_org):
        resp = client.get("/api/plan/calendar", headers=auth_headers)
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)

    def test_calendar_returns_lanes(self, client, auth_headers, db_session, test_org):
        printer = _make_printer(db_session, test_org.id)
        task = _make_task(db_session, test_org.id)
        today = date.today()
        _make_entry(db_session, test_org.id, printer.id, task.id, plan_date=today, start_time=time(8, 0))

        resp = client.get(
            "/api/plan/calendar",
            headers=auth_headers,
            params={"start": str(today), "end": str(today)},
        )
        assert resp.status_code == 200
        lanes = resp.json()
        assert len(lanes) == 1
        assert lanes[0]["printer_id"] == printer.id
        assert len(lanes[0]["days"]) == 1
        day = lanes[0]["days"][0]
        assert len(day["entries"]) == 1
        assert day["entries"][0]["start_time"] == "08:00:00"

    def test_calendar_conflict_flag(self, client, auth_headers, db_session, test_org):
        printer = _make_printer(db_session, test_org.id)
        task1 = _make_task(db_session, test_org.id, "t1", minutes=180)
        task2 = _make_task(db_session, test_org.id, "t2", minutes=60)
        today = date.today()
        # t1: 08:00 → 11:00, t2: 09:00 → 10:00 — overlap
        _make_entry(db_session, test_org.id, printer.id, task1.id, plan_date=today, start_time=time(8, 0))
        _make_entry(db_session, test_org.id, printer.id, task2.id, plan_date=today, start_time=time(9, 0))

        resp = client.get(
            "/api/plan/calendar",
            headers=auth_headers,
            params={"start": str(today), "end": str(today)},
        )
        assert resp.status_code == 200
        entries = resp.json()[0]["days"][0]["entries"]
        assert all(e["conflict"] is True for e in entries)

    def test_calendar_range_too_large(self, client, auth_headers):
        resp = client.get(
            "/api/plan/calendar",
            headers=auth_headers,
            params={"start": "2026-01-01", "end": "2026-06-01"},
        )
        assert resp.status_code == 400

    def test_calendar_end_time_computed(self, client, auth_headers, db_session, test_org):
        printer = _make_printer(db_session, test_org.id)
        task = _make_task(db_session, test_org.id, minutes=90)
        today = date.today()
        _make_entry(db_session, test_org.id, printer.id, task.id, plan_date=today, start_time=time(10, 0))

        resp = client.get(
            "/api/plan/calendar",
            headers=auth_headers,
            params={"start": str(today), "end": str(today)},
        )
        entry = resp.json()[0]["days"][0]["entries"][0]
        assert entry["end_time"] == "11:30:00"


# ---------------------------------------------------------------------------
# Unit tests for schedule_conflict service
# ---------------------------------------------------------------------------

class _FakeTask:
    def __init__(self, minutes: int):
        self.estimated_minutes = minutes


class _FakeEntry:
    _id_counter = 1

    def __init__(self, start: time | None, minutes: int = 60, mode: str = "asap", plan_date: date | None = None):
        self.id = _FakeEntry._id_counter
        _FakeEntry._id_counter += 1
        self.start_time = start
        self.schedule_mode = mode
        self.task = _FakeTask(minutes)
        self.plan_date = plan_date or date.today()
        self.window_start_at = None
        self.window_end_at = None


class TestConflictDetection:
    def test_no_conflict_sequential(self):
        e1 = _FakeEntry(time(8, 0), minutes=60)
        e2 = _FakeEntry(time(9, 0), minutes=60)
        assert detect_conflicts([e1, e2]) == set()

    def test_conflict_overlap(self):
        e1 = _FakeEntry(time(8, 0), minutes=120)
        e2 = _FakeEntry(time(9, 0), minutes=60)
        conflicts = detect_conflicts([e1, e2])
        assert e1.id in conflicts
        assert e2.id in conflicts

    def test_no_conflict_exact_boundary(self):
        e1 = _FakeEntry(time(8, 0), minutes=60)
        e2 = _FakeEntry(time(9, 0), minutes=60)
        assert detect_conflicts([e1, e2]) == set()

    def test_asap_entries_ignored(self):
        e1 = _FakeEntry(None, minutes=120)
        e2 = _FakeEntry(None, minutes=60)
        assert detect_conflicts([e1, e2]) == set()

    def test_end_time_none_without_duration(self):
        e = _FakeEntry(time(8, 0), minutes=0)
        assert entry_end_time(e) is None  # type: ignore[arg-type]


class TestEligibility:
    def test_asap_always_eligible(self):
        from datetime import datetime, timezone
        e = _FakeEntry(None, mode="asap")
        ok, reason = check_eligibility(e, datetime.now(timezone.utc))  # type: ignore[arg-type]
        assert ok is True
        assert reason is None

    def test_not_before_blocks_before_time(self):
        from datetime import datetime, timezone
        today = date.today()
        e = _FakeEntry(time(23, 59), mode="not_before", plan_date=today)
        # Check at midnight — should be blocked
        now = datetime.combine(today, time(0, 0)).replace(tzinfo=timezone.utc)
        ok, reason = check_eligibility(e, now)  # type: ignore[arg-type]
        assert ok is False
        assert reason == BLOCKED_WAITING

    def test_not_before_eligible_after_time(self):
        from datetime import datetime, timezone
        today = date.today()
        e = _FakeEntry(time(0, 1), mode="not_before", plan_date=today)
        now = datetime.combine(today, time(1, 0)).replace(tzinfo=timezone.utc)
        ok, reason = check_eligibility(e, now)  # type: ignore[arg-type]
        assert ok is True

    def test_window_expired(self):
        from datetime import datetime, timezone
        today = date.today()
        e = _FakeEntry(None, mode="window", plan_date=today)
        e.window_start_at = datetime(2026, 1, 1, 6, tzinfo=timezone.utc)
        e.window_end_at = datetime(2026, 1, 1, 18, tzinfo=timezone.utc)
        now = datetime(2026, 1, 1, 20, tzinfo=timezone.utc)
        ok, reason = check_eligibility(e, now)  # type: ignore[arg-type]
        assert ok is False
        assert reason == BLOCKED_WINDOW_EXPIRED

    def test_window_not_yet_open(self):
        from datetime import datetime, timezone
        today = date.today()
        e = _FakeEntry(None, mode="window", plan_date=today)
        e.window_start_at = datetime(2026, 12, 31, 6, tzinfo=timezone.utc)
        e.window_end_at = datetime(2026, 12, 31, 18, tzinfo=timezone.utc)
        now = datetime(2026, 1, 1, 0, tzinfo=timezone.utc)
        ok, reason = check_eligibility(e, now)  # type: ignore[arg-type]
        assert ok is False
        assert reason == BLOCKED_WAITING

    def test_window_active(self):
        from datetime import datetime, timezone
        today = date.today()
        e = _FakeEntry(None, mode="window", plan_date=today)
        e.window_start_at = datetime(2026, 6, 10, 6, tzinfo=timezone.utc)
        e.window_end_at = datetime(2026, 6, 10, 18, tzinfo=timezone.utc)
        now = datetime(2026, 6, 10, 12, tzinfo=timezone.utc)
        ok, reason = check_eligibility(e, now)  # type: ignore[arg-type]
        assert ok is True
