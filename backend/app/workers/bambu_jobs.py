"""Bambu Cloud job worker.

Keeps dispatch out of the API request thread by polling queued `BambuCloudJob`
rows from APScheduler and running `bambu_dispatch.dispatch_cloud_job`. Phase 6
also uses this module for the lightweight lost-job watchdog. MQTT correlation
and PrintHistory writes stay in their owning services.
"""
from __future__ import annotations

import logging
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from typing import Callable

from sqlalchemy.orm import Session

from app.core import metrics
from app.core.db import SessionLocal
from app.models.bambu_cloud_job import BambuCloudJob, BambuCloudJobStatus
from app.services import bambu_dispatch
from app.services.bambu_errors import BambuErrorCode, error_details, is_retryable
from app.services.bambu_job_state import mark_lost_jobs, transition_job
from app.services.bambu_observability import event_tags, log_event

log = logging.getLogger(__name__)

DEFAULT_BATCH_SIZE = 10
DEFAULT_MAX_WORKERS = 4
DEFAULT_ORG_CONCURRENCY = 2
MAX_RETRY_COUNT = 5
# The web process dispatches jobs instantly via BackgroundTasks; this poller is
# the crash-recovery sweeper. The grace window keeps it from racing a dispatch
# already in flight in another process (in-process locks don't cross processes).
PICKUP_GRACE = timedelta(seconds=45)

PICKUP_STATUSES = (
    BambuCloudJobStatus.queued,
    BambuCloudJobStatus.validating,
    BambuCloudJobStatus.creating_project,
    BambuCloudJobStatus.uploading,
    BambuCloudJobStatus.task_creating,
)

_poll_lock = threading.Lock()
_running_guard = threading.Lock()
_running_job_ids: set[int] = set()

_printer_locks: dict[int, threading.Lock] = {}
_printer_locks_guard = threading.Lock()

_org_semaphores: dict[int, threading.BoundedSemaphore] = {}
_org_semaphores_guard = threading.Lock()

DispatchFn = Callable[[int], BambuCloudJob]

# Provider dispatchers keyed by BambuCloudJob.dispatch_mode. The poller only
# picks "cloud" jobs — other providers (Pass 2: "moonraker") dispatch in the
# web process, where the agent tunnel lives, and are listed here only once
# they have a worker-safe dispatch path.
DISPATCHERS: dict[str, DispatchFn] = {
    "cloud": bambu_dispatch.dispatch_cloud_job,
}


def _printer_lock(printer_id: int) -> threading.Lock:
    # TODO: replace/augment with Redis locks when multiple independent Bambu
    # workers process the same queue outside scheduler leader election.
    with _printer_locks_guard:
        lock = _printer_locks.get(printer_id)
        if lock is None:
            lock = threading.Lock()
            _printer_locks[printer_id] = lock
        return lock


def _org_semaphore(org_id: int, max_concurrent: int = DEFAULT_ORG_CONCURRENCY) -> threading.BoundedSemaphore:
    with _org_semaphores_guard:
        sem = _org_semaphores.get(org_id)
        if sem is None:
            sem = threading.BoundedSemaphore(max_concurrent)
            _org_semaphores[org_id] = sem
        return sem


def _retryable_failure(job: BambuCloudJob) -> bool:
    details = job.error_details_json or {}
    return is_retryable(getattr(job, "error_code", None)) or bool(details.get("retryable"))


def _select_candidate_job_ids(db: Session, limit: int = DEFAULT_BATCH_SIZE) -> list[int]:
    """Pick runnable jobs deterministically with a small tenant round-robin.

    Fetching a wider window and then round-robining by org avoids a single noisy
    org monopolizing every poll while keeping the query simple for Phase 5.
    """
    fetch_limit = max(limit * 5, limit)
    stale_cutoff = datetime.now(timezone.utc) - PICKUP_GRACE
    rows = (
        db.query(BambuCloudJob)
        .filter(
            BambuCloudJob.status.in_(PICKUP_STATUSES),
            BambuCloudJob.retry_count < MAX_RETRY_COUNT,
            BambuCloudJob.dispatch_mode.in_(tuple(DISPATCHERS)),
            BambuCloudJob.updated_at < stale_cutoff,
        )
        .order_by(BambuCloudJob.created_at.asc(), BambuCloudJob.id.asc())
        .limit(fetch_limit)
        .all()
    )

    by_org: dict[int, list[int]] = defaultdict(list)
    org_order: list[int] = []
    for job in rows:
        if job.id in _running_job_ids:
            continue
        if job.organization_id not in by_org:
            org_order.append(job.organization_id)
        by_org[job.organization_id].append(job.id)

    selected: list[int] = []
    while len(selected) < limit and any(by_org.values()):
        for org_id in org_order:
            if by_org[org_id]:
                selected.append(by_org[org_id].pop(0))
                if len(selected) >= limit:
                    break
    return selected


def _load_job_identity(job_id: int, session_factory=SessionLocal) -> tuple[int, int, BambuCloudJobStatus, str] | None:
    with session_factory() as db:
        job = db.get(BambuCloudJob, job_id)
        if job is None:
            return None
        # getattr default mirrors the column's server_default ("cloud").
        return job.printer_id, job.organization_id, job.status, getattr(job, "dispatch_mode", "cloud")


def _mark_worker_failure(job_id: int, exc: Exception, session_factory=SessionLocal) -> BambuCloudJob | None:
    """Record an uncaught worker failure without logging or storing secrets."""
    with session_factory() as db:
        job = db.get(BambuCloudJob, job_id)
        if job is None:
            return None
        transition_job(
            job,
            BambuCloudJobStatus.failed,
            reason="Bambu job worker failed before dispatch completed",
            error_code=BambuErrorCode.WORKER_DISPATCH_FAILED.value,
            error_details_json=error_details(
                BambuErrorCode.WORKER_DISPATCH_FAILED,
                exception_type=type(exc).__name__,
                source="bambu_jobs_worker",
            ),
        )
        job.retry_count = (job.retry_count or 0) + 1
        db.commit()
        db.refresh(job)
        db.expunge(job)
        return job


def _bump_retry_count_if_retryable(job_id: int, session_factory=SessionLocal) -> BambuCloudJob | None:
    with session_factory() as db:
        job = db.get(BambuCloudJob, job_id)
        if job is None:
            return None
        if job.status == BambuCloudJobStatus.failed and _retryable_failure(job):
            job.retry_count = (job.retry_count or 0) + 1
            job.updated_at = datetime.now(timezone.utc)
            db.commit()
            db.refresh(job)
        db.expunge(job)
        return job


def run_bambu_cloud_job(
    job_id: int,
    *,
    session_factory=SessionLocal,
    dispatch_fn: DispatchFn | None = None,
    org_concurrency: int = DEFAULT_ORG_CONCURRENCY,
) -> BambuCloudJob | None:
    """Run one job if it is still runnable and local locks are available.

    Returns `None` when another in-process worker already owns this job/printer
    or the job no longer needs dispatch.
    """
    identity = _load_job_identity(job_id, session_factory=session_factory)
    if identity is None:
        log_event(log, logging.WARNING, "bambu.cloud.worker.job_missing", job_id=job_id)
        return None

    printer_id, org_id, current_status, dispatch_mode = identity
    if current_status not in PICKUP_STATUSES:
        log_event(log, logging.INFO, "bambu.cloud.worker.skip", org_id=org_id, printer_id=printer_id, job_id=job_id, status=current_status.value)
        return None

    dispatch = dispatch_fn or DISPATCHERS.get(dispatch_mode)
    if dispatch is None:
        log_event(log, logging.INFO, "bambu.cloud.worker.skip", org_id=org_id, printer_id=printer_id, job_id=job_id, reason="no_dispatcher", dispatch_mode=dispatch_mode)
        return None

    with _running_guard:
        if job_id in _running_job_ids:
            return None
        _running_job_ids.add(job_id)

    printer_lock = _printer_lock(printer_id)
    printer_acquired = printer_lock.acquire(blocking=False)
    if not printer_acquired:
        with _running_guard:
            _running_job_ids.discard(job_id)
        log_event(log, logging.INFO, "bambu.cloud.worker.skip", org_id=org_id, printer_id=printer_id, job_id=job_id, reason="printer_locked")
        return None

    org_sem = _org_semaphore(org_id, org_concurrency)
    org_acquired = org_sem.acquire(blocking=False)
    if not org_acquired:
        printer_lock.release()
        with _running_guard:
            _running_job_ids.discard(job_id)
        log_event(log, logging.INFO, "bambu.cloud.worker.skip", org_id=org_id, printer_id=printer_id, job_id=job_id, reason="org_limited")
        return None

    dispatch_start = time.monotonic()
    try:
        log_event(log, logging.INFO, "bambu.cloud.worker.dispatch_start", org_id=org_id, printer_id=printer_id, job_id=job_id)
        dispatch(job_id)
        job = _bump_retry_count_if_retryable(job_id, session_factory=session_factory)
        if job is not None:
            log_event(
                log,
                logging.INFO,
                "bambu.cloud.worker.dispatch_done",
                org_id=org_id,
                printer_id=printer_id,
                job_id=job_id,
                status=job.status.value,
            )
        return job
    except Exception as exc:
        log_event(
            log,
            logging.ERROR,
            "bambu.cloud.worker.dispatch_error",
            org_id=org_id,
            printer_id=printer_id,
            job_id=job_id,
            error_type=type(exc).__name__,
        )
        return _mark_worker_failure(job_id, exc, session_factory=session_factory)
    finally:
        metrics.timing(
            "bambu.cloud.worker.dispatch.latency.ms",
            (time.monotonic() - dispatch_start) * 1000,
            tags=event_tags(org_id=org_id),
        )
        org_sem.release()
        printer_lock.release()
        with _running_guard:
            _running_job_ids.discard(job_id)


def process_pending_bambu_cloud_jobs(
    *,
    batch_size: int = DEFAULT_BATCH_SIZE,
    max_workers: int = DEFAULT_MAX_WORKERS,
    session_factory=SessionLocal,
    dispatch_fn: DispatchFn | None = None,
) -> dict[str, int]:
    """Poll and dispatch a bounded batch of Bambu Cloud jobs."""
    if not _poll_lock.acquire(blocking=False):
        return {"picked": 0, "completed": 0, "skipped": 0, "failed": 0}

    try:
        with session_factory() as db:
            job_ids = _select_candidate_job_ids(db, limit=batch_size)

        if not job_ids:
            return {"picked": 0, "completed": 0, "skipped": 0, "failed": 0}

        completed = 0
        skipped = 0
        failed = 0
        workers = max(1, min(max_workers, len(job_ids)))
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="bambu-cloud-job") as pool:
            futures = [
                pool.submit(
                    run_bambu_cloud_job,
                    job_id,
                    session_factory=session_factory,
                    dispatch_fn=dispatch_fn,
                )
                for job_id in job_ids
            ]
            for fut in as_completed(futures):
                job = fut.result()
                if job is None:
                    skipped += 1
                elif job.status == BambuCloudJobStatus.failed:
                    failed += 1
                else:
                    completed += 1

        return {"picked": len(job_ids), "completed": completed, "skipped": skipped, "failed": failed}
    finally:
        _poll_lock.release()


def process_lost_bambu_cloud_jobs(*, session_factory=SessionLocal) -> dict[str, int]:
    with session_factory() as db:
        lost = mark_lost_jobs(db)
    if lost:
        log_event(log, logging.WARNING, "bambu.cloud.worker.lost_jobs_marked", count=lost)
    return {"lost": lost}
