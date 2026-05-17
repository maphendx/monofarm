"""Detect printer state transitions and write PrintHistory records.

Runs as an APScheduler job every 30 seconds. Compares current printer state
to the previously observed state and opens/closes history entries accordingly.
Works for all printer types (Bambu via MQTT cache, Moonraker via polling cache).
"""
import logging
from datetime import datetime, timezone

from app.core.db import SessionLocal
from app.models.organization import Organization
from app.models.print_history import PrintHistory
from app.models.printer import Printer, PrinterKind

log = logging.getLogger(__name__)

# printer_id → {"state": str, "file": str|None}
_prev: dict[int, dict] = {}


def _current_state(row: Printer) -> dict:
    """Get current state for any printer type without hitting the network."""
    from app.services import bambu, moonraker

    if row.kind == PrinterKind.bambu and row.bambu_dev_id:
        cached = bambu.get_cached_state(row.bambu_dev_id)
        return {"state": cached.get("state", "unknown"), "file": cached.get("filename")}

    if row.moonraker_url:
        live = moonraker.get_live_status(row.moonraker_url)
        return {"state": live.get("state", "unknown"), "file": live.get("filename")}

    # manual / simplyprint — use manual_status
    return {"state": row.manual_status or "unknown", "file": row.manual_job}


PRINTING_STATES = {"printing"}
DONE_STATES = {"operational", "idle", "error", "offline", "unknown"}


def check_transitions() -> None:
    """Called by APScheduler every 30s."""
    try:
        with SessionLocal() as db:
            orgs = db.query(Organization).all()
            for org in orgs:
                _check_org(db, org)
    except Exception:
        log.exception("print_tracker.check_transitions failed")


def _check_org(db, org: Organization) -> None:
    printers = db.query(Printer).filter(
        Printer.organization_id == org.id,
        Printer.is_active.is_(True),
    ).all()

    now = datetime.now(timezone.utc)

    for row in printers:
        try:
            current = _current_state(row)
        except Exception:
            continue

        state = current["state"]
        prev = _prev.get(row.id, {})
        prev_state = prev.get("state", "unknown")

        # idle/unknown/offline → printing: open new history entry
        if state in PRINTING_STATES and prev_state not in PRINTING_STATES:
            # Close any stale in_progress entry first
            _close_stale(db, row.id, now, "cancelled")
            entry = PrintHistory(
                organization_id=org.id,
                printer_id=row.id,
                printer_name=row.name,
                file_name=current.get("file"),
                started_at=now,
                result="in_progress",
            )
            db.add(entry)
            db.commit()
            log.info("PrintHistory: started %s on %s", current.get("file"), row.name)

        # printing → done: close history entry
        elif prev_state in PRINTING_STATES and state not in PRINTING_STATES:
            result = "completed" if state == "operational" else ("failed" if state == "error" else "cancelled")
            _close_stale(db, row.id, now, result)
            log.info("PrintHistory: %s on %s", result, row.name)

        _prev[row.id] = current


def _close_stale(db, printer_id: int, now: datetime, result: str) -> None:
    entry = (
        db.query(PrintHistory)
        .filter(PrintHistory.printer_id == printer_id, PrintHistory.result == "in_progress")
        .order_by(PrintHistory.started_at.desc())
        .first()
    )
    if entry:
        entry.finished_at = now
        entry.result = result
        delta = now - entry.started_at.replace(tzinfo=timezone.utc) if entry.started_at.tzinfo is None else now - entry.started_at
        entry.duration_minutes = max(0, int(delta.total_seconds() / 60))
        db.commit()
