"""Worker poller selection: crash-recovery semantics.

The web process dispatches jobs instantly via BackgroundTasks; the worker
poller must only sweep jobs that have been untouched for PICKUP_GRACE (so two
processes never dispatch the same job concurrently) and must skip providers
without a worker-safe dispatcher (moonraker runs in the web process only).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.models.bambu_cloud_job import BambuCloudJob, BambuCloudJobStatus
from app.models.printer import Printer, PrinterKind
from app.workers.bambu_jobs import PICKUP_GRACE, _select_candidate_job_ids


def _make_job(db_session, *, org_id: int, printer_id: int, suffix: str, dispatch_mode: str, updated_at: datetime) -> BambuCloudJob:
    job = BambuCloudJob(
        organization_id=org_id,
        printer_id=printer_id,
        file_name=f"{suffix}.3mf",
        status=BambuCloudJobStatus.queued,
        dispatch_mode=dispatch_mode,
        correlation_id=f"pickup-corr-{suffix}",
        idempotency_key=f"pickup-idem-{suffix}",
        updated_at=updated_at,
    )
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)
    return job


def test_select_candidates_only_sweeps_stale_cloud_jobs(db_session, test_org):
    printer = Printer(
        organization_id=test_org.id,
        name="Pickup",
        kind=PrinterKind.bambu,
        bambu_dev_id="PICKUP-1",
        is_active=True,
    )
    db_session.add(printer)
    db_session.commit()

    now = datetime.now(timezone.utc)
    stale_age = PICKUP_GRACE + timedelta(seconds=30)
    fresh = _make_job(db_session, org_id=test_org.id, printer_id=printer.id, suffix="fresh", dispatch_mode="cloud", updated_at=now)
    stale = _make_job(db_session, org_id=test_org.id, printer_id=printer.id, suffix="stale", dispatch_mode="cloud", updated_at=now - stale_age)
    stale_moonraker = _make_job(
        db_session, org_id=test_org.id, printer_id=printer.id, suffix="stale-mr", dispatch_mode="moonraker", updated_at=now - stale_age,
    )

    selected = _select_candidate_job_ids(db_session)

    assert stale.id in selected
    assert fresh.id not in selected
    assert stale_moonraker.id not in selected
