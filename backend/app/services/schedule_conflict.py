"""Scheduling utilities: conflict detection, eligibility checks, time helpers."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.models.plan import PlanEntry

BLOCKED_WAITING = "waiting_until_time"
BLOCKED_OUTSIDE_WINDOW = "outside_schedule_window"
BLOCKED_WINDOW_EXPIRED = "window_expired"
BLOCKED_PRINTER_BUSY = "printer_busy"


def entry_end_time(entry: "PlanEntry") -> time | None:
    """Return the estimated end time for an entry based on start_time + task duration."""
    if entry.start_time is None:
        return None
    duration_minutes: int = 0
    if entry.task and entry.task.estimated_minutes:
        duration_minutes = entry.task.estimated_minutes
    if duration_minutes <= 0:
        return None
    start_dt = datetime.combine(date.today(), entry.start_time)
    end_dt = start_dt + timedelta(minutes=duration_minutes)
    # Cap at midnight (don't wrap to next day for conflict purposes within a day)
    if end_dt.date() > start_dt.date():
        return time(23, 59, 59)
    return end_dt.time()


def detect_conflicts(entries: list["PlanEntry"]) -> set[int]:
    """Return the set of entry IDs that have a time overlap with another entry.

    Only entries with a start_time are considered for overlap detection.
    Entries without start_time are never marked conflicting — they are 'asap'.
    """
    timed = [e for e in entries if e.start_time is not None]
    timed.sort(key=lambda e: e.start_time)  # type: ignore[arg-type]

    conflict_ids: set[int] = set()
    for i, entry in enumerate(timed):
        end = entry_end_time(entry)
        if end is None:
            continue
        for j in range(i + 1, len(timed)):
            other = timed[j]
            if other.start_time is None:
                continue
            if other.start_time < end:
                conflict_ids.add(entry.id)
                conflict_ids.add(other.id)
            else:
                # Sorted by start_time, no further overlaps possible
                break
    return conflict_ids


def check_eligibility(entry: "PlanEntry", now: datetime | None = None) -> tuple[bool, str | None]:
    """Return (eligible, blocked_reason) given the current time.

    'eligible' means the entry's schedule constraints allow it to start now.
    This is informational — used by the calendar UI to show blocked state.
    The actual dispatch guard must enforce this before sending to printer.
    """
    if now is None:
        now = datetime.now(timezone.utc)

    mode = entry.schedule_mode or "asap"

    if mode == "asap":
        return True, None

    if mode == "not_before":
        if entry.start_time is None:
            return True, None
        threshold = datetime.combine(entry.plan_date, entry.start_time).replace(tzinfo=timezone.utc)
        if now < threshold:
            return False, BLOCKED_WAITING
        return True, None

    if mode == "exact_time":
        if entry.start_time is None:
            return True, None
        threshold = datetime.combine(entry.plan_date, entry.start_time).replace(tzinfo=timezone.utc)
        if now < threshold:
            return False, BLOCKED_WAITING
        return True, None

    if mode == "window":
        window_start = entry.window_start_at
        window_end = entry.window_end_at
        if window_start and now < window_start:
            return False, BLOCKED_WAITING
        if window_end and now > window_end:
            return False, BLOCKED_WINDOW_EXPIRED
        return True, None

    return True, None
