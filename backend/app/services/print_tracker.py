"""Detect printer state transitions and write PrintHistory records.

Runs as an APScheduler job every 30 seconds. Compares current printer state
to the previously observed state and opens/closes history entries accordingly.
Works for all printer types (Bambu via MQTT cache, Moonraker via polling cache).
"""
import logging
from datetime import datetime, timezone

from sqlalchemy import or_

from app.core.db import SessionLocal
from app.models.organization import Organization
from app.models.plan import PlanEntry
from app.models.print_history import PrintHistory
from app.models.printer import Printer, PrinterKind
from app.services.telegram_notify import send_print_event_notification

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
        return {
            "state": live.get("state", "unknown"),
            "file": live.get("filename"),
            "progress_pct": live.get("progress_pct"),
            "eta_minutes": live.get("eta_minutes"),
            "error_msg": live.get("error_msg"),
        }

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

        job = _active_dispatch_job(db, row)
        if job is not None:
            # The job (not this tracker) owns the history row. Cloud jobs are
            # correlated via MQTT; moonraker jobs are correlated here.
            if job.dispatch_mode == "moonraker":
                _sync_moonraker_job(db, row, job, current, now)
            _prev[row.id] = current
            continue

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

        error_msg = current.get("error_msg") or prev.get("error_msg")

        # printing → paused: record pause start
        if prev_state in PRINTING_STATES and state == "paused" and not error_msg:
            _record_pause_start(db, row.id, now)
            _prev[row.id] = current
            continue

        # paused → printing: record pause end
        if prev_state == "paused" and state in PRINTING_STATES:
            _record_pause_end(db, row.id, now)
            _prev[row.id] = current
            continue

        # printing → done: close history entry
        elif prev_state in PRINTING_STATES and state not in PRINTING_STATES:
            result = "completed" if state in ("operational", "idle") else ("failed" if state == "error" or error_msg else "cancelled")
            _finalize_print(db, row, now, result)
            if result == "failed":
                send_print_event_notification(
                    db,
                    org.id,
                    event=result,
                    printer_name=row.name,
                    printer_id=row.id,
                    file_name=current.get("file"),
                    reason=error_msg,
                    dedupe_key=f"{row.id}:{result}:{current.get('file') or '-'}:{int(now.timestamp() // 300)}",
                )
            log.info("PrintHistory: %s on %s", result, row.name)

        _prev[row.id] = current


def _active_dispatch_job(db, row: Printer):
    from app.models.bambu_cloud_job import BambuCloudJob
    from app.services.bambu_job_state import ACTIVE_STATUSES

    return (
        db.query(BambuCloudJob)
        .filter(
            BambuCloudJob.organization_id == row.organization_id,
            BambuCloudJob.printer_id == row.id,
            BambuCloudJob.status.in_(ACTIVE_STATUSES),
        )
        .order_by(BambuCloudJob.created_at.desc(), BambuCloudJob.id.desc())
        .first()
    )


def _sync_moonraker_job(db, printer: Printer, job, current: dict, now: datetime) -> None:
    """Correlate observed Moonraker state with the printer's active dispatch job.

    The web-process dispatcher leaves the job in `printing`; this stamps
    progress/telemetry each tick and closes the job (running filament
    consumption accounting first — `finalize_print` only works on an
    `in_progress` history row, which the job transition would finalize).
    """
    from app.models.bambu_cloud_job import BambuCloudJobStatus
    from app.services.bambu_job_state import transition_job

    if job.status not in (BambuCloudJobStatus.printing, BambuCloudJobStatus.paused):
        return  # dispatch still in flight — the dispatcher owns it

    state = current["state"]
    updates: dict = {"last_mqtt_at": now}
    if current.get("progress_pct") is not None:
        updates["progress_pct"] = current["progress_pct"]
    if current.get("eta_minutes") is not None:
        updates["eta_minutes"] = current["eta_minutes"]

    target = None
    reason = None
    if state == "paused" and job.status != BambuCloudJobStatus.paused:
        target, reason = BambuCloudJobStatus.paused, "Printer reports print paused"
    elif state in PRINTING_STATES and job.status == BambuCloudJobStatus.paused:
        target, reason = BambuCloudJobStatus.printing, "Printer reports print progress"
    elif state in DONE_STATES:
        result = "completed" if state in ("operational", "idle") else ("failed" if state == "error" else "cancelled")
        target = {
            "completed": BambuCloudJobStatus.completed,
            "failed": BambuCloudJobStatus.failed,
            "cancelled": BambuCloudJobStatus.cancelled,
        }[result]
        reason = f"Printer reports print {result}"
        if state == "error" and current.get("error_msg"):
            updates["error_msg"] = current["error_msg"]

        entry = (
            db.query(PrintHistory)
            .filter(
                PrintHistory.organization_id == job.organization_id,
                PrintHistory.bambu_cloud_job_id == job.id,
                PrintHistory.result == "in_progress",
            )
            .first()
        )
        if entry is not None:
            from app.services.print_costing import finalize_print
            finalize_print(db, entry, printer, result, now=now)
        if result == "failed":
            send_print_event_notification(
                db,
                printer.organization_id,
                event=result,
                printer_name=printer.name,
                printer_id=printer.id,
                file_name=current.get("file"),
                reason=current.get("error_msg"),
                dedupe_key=f"{job.id}:{result}",
            )

    transition_job(job, target or job.status, reason=reason, now=now, **updates)

    if target and target.value in ("completed", "failed", "cancelled"):
        if target.value == "completed":
            _advance_queue(db, printer, now)
        _broadcast_completion(printer.organization_id, printer.id)

    db.commit()


def _find_active_entry(db, printer_id: int):
    entries = (
        db.query(PrintHistory)
        .filter(
            PrintHistory.printer_id == printer_id,
            PrintHistory.result == "in_progress",
            or_(PrintHistory.source.is_(None), PrintHistory.source != "cloud"),
            PrintHistory.bambu_cloud_job_id.is_(None),
        )
        .all()
    )
    if not entries:
        return None
    if len(entries) == 1:
        return entries[0]
    return max(entries, key=lambda e: getattr(e, "started_at", None) or datetime.min)


def _record_pause_start(db, printer_id: int, now: datetime) -> None:
    entry = _find_active_entry(db, printer_id)
    if not entry:
        return
    pauses = list(entry.pauses or [])
    if pauses and pauses[-1].get("resumed_at") is None:
        return
    pauses.append({"at": now.isoformat(), "resumed_at": None, "duration_sec": None})
    entry.pauses = pauses
    db.commit()


def _record_pause_end(db, printer_id: int, now: datetime) -> None:
    entry = _find_active_entry(db, printer_id)
    if not entry or not entry.pauses:
        return
    pauses = list(entry.pauses)
    if not pauses or pauses[-1].get("resumed_at") is not None:
        return
    last = dict(pauses[-1])
    last["resumed_at"] = now.isoformat()
    pause_start = datetime.fromisoformat(last["at"])
    last["duration_sec"] = max(0, int((now - pause_start).total_seconds()))
    pauses[-1] = last
    entry.pauses = pauses
    db.commit()


def _close_stale(db, printer_id: int, now: datetime, result: str) -> None:
    entry = _find_active_entry(db, printer_id)
    if entry:
        entry.finished_at = now
        entry.result = result
        delta = now - entry.started_at.replace(tzinfo=timezone.utc) if entry.started_at.tzinfo is None else now - entry.started_at
        entry.duration_minutes = max(0, int(delta.total_seconds() / 60))
        db.commit()


def _finalize_print(db, printer: Printer, now: datetime, result: str) -> None:
    """Close stale in-progress entry and run consumption accounting for any printer kind."""
    entry = (
        db.query(PrintHistory)
        .filter(
            PrintHistory.printer_id == printer.id,
            PrintHistory.result == "in_progress",
            or_(PrintHistory.source.is_(None), PrintHistory.source != "cloud"),
            PrintHistory.bambu_cloud_job_id.is_(None),
        )
        .order_by(PrintHistory.started_at.desc())
        .first()
    )
    if not entry:
        return

    from app.services.print_costing import finalize_print
    finalize_print(db, entry, printer, result, now=now)

    # Auto-advance queue: mark today's PlanEntry as done on successful print
    if result == "completed":
        _advance_queue(db, printer, now)

    db.commit()

    # Broadcast queue event for real-time UI updates
    if result == "completed":
        _broadcast_completion(printer.organization_id, printer.id)


def _advance_queue(db, printer: Printer, now: datetime) -> None:
    """Mark today's first undone PlanEntry for this printer as done."""
    from datetime import date as date_cls

    entry = (
        db.query(PlanEntry)
        .filter(
            PlanEntry.printer_id == printer.id,
            PlanEntry.organization_id == printer.organization_id,
            PlanEntry.plan_date == date_cls.today(),
            PlanEntry.done.is_(False),
        )
        .order_by(PlanEntry.sequence)
        .first()
    )
    if not entry:
        return

    entry.done = True
    log.info(
        "queue advance: printer=%s entry=%d marked done",
        printer.name, entry.id,
    )


def _broadcast_completion(org_id: int, printer_id: int) -> None:
    """Fire-and-forget WS broadcast for queue completion."""
    import asyncio
    from app.api.ws import broadcast_queue

    try:
        loop = asyncio.get_event_loop()
        loop.create_task(
            broadcast_queue(org_id, "print_completed", printer_id=printer_id)
        )
    except RuntimeError:
        pass
