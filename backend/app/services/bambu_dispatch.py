"""Bambu Cloud dispatch engine — job-tracked print dispatch.

Owns the lifecycle of a single `BambuCloudJob`: idempotent creation, file
integrity validation, and the cloud dispatch flow (create project → upload to
OSS → create print task), with retries and auth-refresh wired through
`bambu_auth`. `BambuCloudJob` is the single source of truth for status — every
transition goes through `advance_job_status`/`fail_job`/`attach_task_response`.

`dispatch_cloud_job` is synchronous by design and is called by the Bambu job
worker off the request thread.

Secrets hygiene: never log full Bambu Cloud responses (they may carry signed
URLs/identifiers) — log extracted ids/status codes only; raw payloads are
persisted to JSONB columns for admin diagnostics, not to logs.
"""
from __future__ import annotations

import hashlib
import logging
import re
import time
import uuid
from pathlib import Path
from typing import Any

import requests
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core import metrics
from app.models.bambu_cloud_job import BambuCloudJob, BambuCloudJobStatus
from app.services.bambu_errors import BambuErrorCode, error_details, is_retryable, normalize_error_code
from app.services.bambu_job_state import transition_job
from app.services.bambu_observability import event_tags, log_event

log = logging.getLogger(__name__)

_TERMINAL_STATUSES = frozenset({
    BambuCloudJobStatus.completed,
    BambuCloudJobStatus.failed,
    BambuCloudJobStatus.cancelled,
    BambuCloudJobStatus.lost,
})

# Maps the last-successfully-reached status to a Phase-9-style error code for
# the stage that failed. Falls back to a generic code for anything earlier.
_STAGE_ERROR_CODES: dict[BambuCloudJobStatus, BambuErrorCode] = {
    BambuCloudJobStatus.creating_project: BambuErrorCode.PROJECT_CREATE_FAILED,
    BambuCloudJobStatus.uploading: BambuErrorCode.OSS_UPLOAD_FAILED,
    BambuCloudJobStatus.task_creating: BambuErrorCode.TASK_CREATE_FAILED,
}

# Idempotency-key bucket: collapses duplicate-click dispatches within this
# window onto one job, while a legitimate later re-print gets a fresh key
# (required because `idempotency_key` is globally unique even for terminal jobs).
_IDEMPOTENCY_WINDOW_SECONDS = 300

_MAX_RETRY_ATTEMPTS = 4
_BACKOFF_BASE_SECONDS = 1.5
_BACKOFF_CAP_SECONDS = 10.0


class BambuDispatchError(Exception):
    """Retryable dispatch failure — network/timeout/5xx, retries exhausted."""


class BambuValidationError(Exception):
    """Non-retryable dispatch failure — bad file, bad request, rejected by Bambu Cloud."""


# ── Internal loaders/mutators (BambuCloudJob is the single source of truth) ──


def _load_job(job_id: int) -> BambuCloudJob:
    from app.core.db import SessionLocal

    with SessionLocal() as db:
        job = db.get(BambuCloudJob, job_id)
        if job is None:
            raise BambuDispatchError(f"BambuCloudJob {job_id} not found")
        db.expunge(job)
        return job


def _mutate_job(job_id: int, mutate) -> BambuCloudJob:
    from app.core.db import SessionLocal

    with SessionLocal() as db:
        job = db.get(BambuCloudJob, job_id)
        if job is None:
            raise BambuDispatchError(f"BambuCloudJob {job_id} not found")
        mutate(job)
        db.commit()
        db.refresh(job)
        db.expunge(job)
        return job


def advance_job_status(job_id: int, status: BambuCloudJobStatus, *, reason: str | None = None, **field_updates: Any) -> BambuCloudJob:
    """Move a job to `status`, optionally updating other columns in the same commit.

    Stamps the matching lifecycle timestamp (e.g. `task_created_at`) the first
    time a job enters that status. This is the *only* place job.status changes —
    Phase 6's MQTT correlation and Phase 5's worker must route through here too.
    """
    def _mutate(job: BambuCloudJob) -> None:
        transition_job(job, status, reason=reason, **field_updates)

    job = _mutate_job(job_id, _mutate)
    log_event(
        log,
        logging.INFO,
        "bambu.cloud.job.status_changed",
        org_id=job.organization_id,
        printer_id=job.printer_id,
        job_id=job_id,
        correlation_id=job.correlation_id,
        status=status.value,
    )
    return job


def attach_task_response(job_id: int, response_json: dict[str, Any] | None, *, bambu_task_id: str | None = None) -> BambuCloudJob:
    """Persist the raw `/task` response (for diagnostics/MQTT correlation) and bambu_task_id."""
    def _mutate(job: BambuCloudJob) -> None:
        job.task_response_json = response_json
        if bambu_task_id:
            job.bambu_task_id = bambu_task_id

    job = _mutate_job(job_id, _mutate)
    log_event(
        log,
        logging.INFO,
        "bambu.cloud.task.created",
        org_id=job.organization_id,
        printer_id=job.printer_id,
        job_id=job_id,
        correlation_id=job.correlation_id,
        bambu_task_id=job.bambu_task_id or "<none>",
    )
    return job


def fail_job(
    job_id: int,
    error_code: BambuErrorCode | str,
    message: str,
    *,
    retryable: bool | None = None,
    details: dict[str, Any] | None = None,
) -> BambuCloudJob:
    """Mark a job as terminally failed.

    `retryable` is informational — recorded for Phase 5's retry scheduler to
    decide whether `POST /bambu-jobs/{id}/retry` should be offered. This phase
    does not retry jobs itself (only individual HTTP calls, via `_execute_with_retry`).
    """
    normalized_code = normalize_error_code(error_code) or str(error_code)

    def _mutate(job: BambuCloudJob) -> None:
        transition_job(job, BambuCloudJobStatus.failed, reason=message)
        job.error_code = normalized_code
        job.error_details_json = error_details(
            normalized_code,
            retryable=retryable,
            **(details or {}),
        )

    job = _mutate_job(job_id, _mutate)
    log_event(
        log,
        logging.WARNING,
        "bambu.cloud.job.failed",
        org_id=job.organization_id,
        printer_id=job.printer_id,
        job_id=job_id,
        correlation_id=job.correlation_id,
        error_code=normalized_code,
        retryable=job.error_details_json.get("retryable") if job.error_details_json else None,
    )
    metrics.increment(
        "bambu.cloud.job.failed.count",
        tags=event_tags(org_id=job.organization_id, region=job.region, error_code=normalized_code),
    )
    return job


def _stage_error_code(status: BambuCloudJobStatus) -> BambuErrorCode:
    return _STAGE_ERROR_CODES.get(status, BambuErrorCode.DISPATCH_FAILED)


# ── Idempotency ──────────────────────────────────────────────────────────────


def build_idempotency_key(org_id: int, printer_id: int, gcode_file_id: int | None, file_sha256: str | None = None) -> str:
    """Stable replay key for "this print, on this printer, right now".

    Combines org/printer/file identity (+ content hash, when known) with a
    coarse time bucket: rapid duplicate-click dispatches land in the same
    bucket and collapse onto one job (see `create_cloud_job`'s lookup), while a
    legitimate re-print later gets a fresh key — needed because the DB enforces
    a *global* unique constraint on `idempotency_key`, including terminal jobs.
    """
    bucket = int(time.time() // _IDEMPOTENCY_WINDOW_SECONDS)
    parts = [str(org_id), str(printer_id), str(gcode_file_id or ""), file_sha256 or "", str(bucket)]
    digest = hashlib.sha256(":".join(parts).encode("utf-8")).hexdigest()
    return f"bcj:{digest}"


def create_cloud_job(
    db: Session,
    *,
    org_id: int,
    printer_id: int,
    printer_bambu_dev_id: str | None,
    gcode_file_id: int | None,
    file_name: str | None = None,
    file_sha256: str | None = None,
    region: str | None = None,
    created_by_user_id: int | None = None,
    request_payload: dict[str, Any] | None = None,
    dispatch_mode: str = "cloud",
    idempotency_key: str | None = None,
) -> BambuCloudJob:
    """Create (or replay) a `BambuCloudJob` for this dispatch request.

    Idempotent: a non-terminal job with the same `idempotency_key` is returned
    instead of creating a duplicate, so a double-click / retried HTTP request
    can't trigger a double print (`bambu.cloud.job.replay`).
    """
    idempotency_key = idempotency_key or build_idempotency_key(
        org_id,
        printer_id,
        gcode_file_id,
        file_sha256,
    )

    existing = (
        db.query(BambuCloudJob)
        .filter(
            BambuCloudJob.organization_id == org_id,
            BambuCloudJob.idempotency_key == idempotency_key,
            BambuCloudJob.status.notin_(_TERMINAL_STATUSES),
        )
        .order_by(BambuCloudJob.id.desc())
        .first()
    )
    if existing:
        log_event(
            log,
            logging.INFO,
            "bambu.cloud.job.replay",
            org_id=org_id,
            printer_id=printer_id,
            job_id=existing.id,
            correlation_id=existing.correlation_id,
        )
        return existing

    job = BambuCloudJob(
        organization_id=org_id,
        printer_id=printer_id,
        gcode_file_id=gcode_file_id,
        created_by_user_id=created_by_user_id,
        printer_bambu_dev_id=printer_bambu_dev_id,
        file_name=file_name,
        file_sha256=file_sha256,
        region=region,
        dispatch_mode=dispatch_mode,
        status=BambuCloudJobStatus.queued,
        correlation_id=uuid.uuid4().hex,
        idempotency_key=idempotency_key,
        request_payload_json=request_payload,
    )
    db.add(job)
    try:
        db.commit()
    except IntegrityError:
        # Concurrent duplicate request raced us to the unique idempotency_key index.
        db.rollback()
        existing = (
            db.query(BambuCloudJob)
            .filter(BambuCloudJob.organization_id == org_id, BambuCloudJob.idempotency_key == idempotency_key)
            .order_by(BambuCloudJob.id.desc())
            .first()
        )
        if existing:
            log_event(
                log,
                logging.INFO,
                "bambu.cloud.job.replay",
                org_id=org_id,
                printer_id=printer_id,
                job_id=existing.id,
                correlation_id=existing.correlation_id,
                reason="race",
            )
            return existing
        raise
    db.refresh(job)

    log_event(
        log,
        logging.INFO,
        "bambu.cloud.job.created",
        org_id=org_id,
        printer_id=printer_id,
        job_id=job.id,
        correlation_id=job.correlation_id,
        region=region,
    )
    metrics.increment("bambu.cloud.job.created.count", tags=event_tags(org_id=org_id, region=region))
    return job


# ── File integrity (prepare) ─────────────────────────────────────────────────


def _normalize_filename(original_name: str) -> str:
    """Bare, presentable filename — Bambu Cloud uses this as the project/task title."""
    base = Path(original_name).name
    return re.sub(r"\s+", " ", base).strip() or "print.3mf"


def _read_gcode_bytes(job: BambuCloudJob) -> bytes:
    from app.core.db import SessionLocal
    from app.models.gcode_file import GcodeFile
    from app.services import storage as storage_svc

    if job.gcode_file_id is None:
        raise FileNotFoundError(f"BambuCloudJob {job.id} has no gcode_file_id")

    with SessionLocal() as db:
        gcode = db.get(GcodeFile, job.gcode_file_id)
        if gcode is None:
            raise FileNotFoundError(f"GcodeFile {job.gcode_file_id} not found")
        stored_name = gcode.stored_name

    with storage_svc.local_path_for(stored_name, job.organization_id) as path:
        return path.read_bytes()


def prepare_cloud_job(job_id: int) -> BambuCloudJob:
    """Validate the source file and stamp integrity metadata before dispatch.

    Fails fast — no retries — on anything indicating a bad upload rather than a
    transient cloud issue: wrong extension, empty file, missing source, or a
    sha256 mismatch against a value already recorded on the job.
    """
    job = _load_job(job_id)

    if job.gcode_file_id is None:
        return fail_job(job_id, BambuErrorCode.INVALID_3MF, "Завдання не пов'язане з файлом", retryable=False)

    original_name = job.file_name or ""
    suffixes = "".join(Path(original_name).suffixes).lower()
    if not suffixes.endswith(".3mf"):
        return fail_job(
            job_id, BambuErrorCode.INVALID_3MF,
            f"Bambu Cloud приймає лише .3mf файли (отримано «{original_name}»)",
            retryable=False,
        )

    try:
        file_bytes = _read_gcode_bytes(job)
    except FileNotFoundError as e:
        return fail_job(job_id, BambuErrorCode.INVALID_3MF, f"Файл відсутній у сховищі: {e}", retryable=False)

    if not file_bytes:
        return fail_job(job_id, BambuErrorCode.INVALID_3MF, "Файл порожній", retryable=False)

    sha256 = hashlib.sha256(file_bytes).hexdigest()
    size = len(file_bytes)
    if job.file_sha256 and job.file_sha256 != sha256:
        return fail_job(
            job_id, BambuErrorCode.INVALID_3MF,
            "Контрольна сума файлу змінилась з моменту створення завдання",
            retryable=False,
            details={"expected_sha256": job.file_sha256, "actual_sha256": sha256},
        )

    prepared = advance_job_status(
        job_id,
        BambuCloudJobStatus.validating,
        file_name=_normalize_filename(original_name),
        file_sha256=sha256,
        file_size=size,
    )
    log_event(
        log,
        logging.INFO,
        "bambu.cloud.job.prepared",
        org_id=prepared.organization_id,
        printer_id=prepared.printer_id,
        job_id=prepared.id,
        correlation_id=prepared.correlation_id,
        file_size=size,
    )
    return prepared


# ── Cloud HTTP retry policy ──────────────────────────────────────────────────


def _sleep_backoff(attempt: int) -> None:
    time.sleep(min(_BACKOFF_BASE_SECONDS * (2 ** (attempt - 1)), _BACKOFF_CAP_SECONDS))


def _bearer_headers(token: str | None) -> dict[str, str]:
    return {"Authorization": f"Bearer {token or ''}", "Content-Type": "application/json"}


def _region_api_base(region: str | None) -> str:
    from app.services.bambu import _REGION_HOSTS
    return _REGION_HOSTS.get(region or "us", _REGION_HOSTS["us"])["api"]


def _execute_with_retry(org_id: int, op_name: str, request_fn, *, auth_aware: bool = True, max_attempts: int = _MAX_RETRY_ATTEMPTS) -> requests.Response:
    """Run one HTTP call against Bambu Cloud under the project's retry policy:

      - 401/403 (when `auth_aware`): refresh the access token once and retry.
      - 5xx / timeouts / network errors: exponential backoff, up to `max_attempts`.
      - any other 4xx: non-retryable -> `BambuValidationError`.

    `request_fn(token)` performs exactly one attempt and returns a `requests.Response`;
    `token` is `None` when `auth_aware=False` (e.g. presigned OSS upload URLs).
    """
    from app.services import bambu_auth

    token = bambu_auth.get_valid_access_token(org_id) if auth_aware else None
    refreshed_once = False
    attempt = 0
    while True:
        attempt += 1
        try:
            resp = request_fn(token)
        except requests.RequestException as e:
            if attempt >= max_attempts:
                raise BambuDispatchError(f"{op_name}: {type(e).__name__} after {attempt} attempts") from e
            log.warning("bambu.cloud.%s.retry org_id=%s attempt=%s reason=%s", op_name, org_id, attempt, type(e).__name__)
            _sleep_backoff(attempt)
            continue

        if auth_aware and resp.status_code in (401, 403):
            if refreshed_once:
                raise BambuValidationError(f"{op_name}: Bambu Cloud rejected refreshed credentials (HTTP {resp.status_code})")
            refreshed_once = True
            log.warning("bambu.cloud.%s.auth_retry org_id=%s status=%s", op_name, org_id, resp.status_code)
            token = bambu_auth.refresh_access_token(org_id)
            continue

        if resp.status_code >= 500:
            if attempt >= max_attempts:
                raise BambuDispatchError(f"{op_name}: Bambu Cloud returned HTTP {resp.status_code} after {attempt} attempts")
            log.warning("bambu.cloud.%s.retry org_id=%s attempt=%s status=%s", op_name, org_id, attempt, resp.status_code)
            _sleep_backoff(attempt)
            continue

        if resp.status_code >= 400:
            body_hint = (resp.text or "")[:400]
            log.warning("bambu.cloud.%s.rejected org_id=%s status=%s body=%s", op_name, org_id, resp.status_code, body_hint)
            raise BambuValidationError(f"{op_name}: Bambu Cloud rejected the request (HTTP {resp.status_code}) — {body_hint}")

        return resp


def create_project_with_retry(org_id: int, filename: str) -> dict[str, Any]:
    """`POST /project` — returns the parsed response (project_id/upload_url/...)."""
    from app.services import bambu
    from app.services.bambu_auth import _load_org

    org = _load_org(org_id)
    base = _region_api_base(org.bambu_region)

    start = time.monotonic()
    resp = _execute_with_retry(org_id, "project.create", lambda token: bambu._cloud_create_project(base, _bearer_headers(token), filename))
    metrics.timing("bambu.cloud.project_create.latency.ms", (time.monotonic() - start) * 1000, tags=event_tags(org_id=org_id, region=org.bambu_region))
    try:
        data = resp.json()
    except ValueError as e:
        raise BambuValidationError("project.create: Bambu Cloud returned a non-JSON response") from e

    project = data.get("project") or data
    if not (project.get("project_id") or project.get("id")):
        raise BambuValidationError("project.create: response missing project_id")
    if not (project.get("upload_url") or data.get("upload_url")):
        raise BambuValidationError("project.create: response missing upload_url")
    return data


def upload_project_with_retry(org_id: int, upload_url: str, file_bytes: bytes) -> None:
    """`PUT <oss_upload_url>` — presigned, no bearer token required."""
    from app.services import bambu

    start = time.monotonic()
    _execute_with_retry(
        org_id, "project.upload",
        lambda _token: bambu._cloud_upload_to_oss(upload_url, file_bytes),
        auth_aware=False,
    )
    metrics.timing("bambu.cloud.upload.latency.ms", (time.monotonic() - start) * 1000, tags=event_tags(org_id=org_id))


_PROFILE_POLL_ATTEMPTS = 10
_PROFILE_POLL_DELAY_SECONDS = 2.0


def _numeric_profile_id(value: Any) -> int | None:
    """Normalize Bambu's numeric profile id to the type task.create expects."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, str) and value.strip().isdigit():
        parsed = int(value.strip())
        return parsed if parsed > 0 else None
    return None


def fetch_project_profile(org_id: int, project_id: str) -> dict[str, Any]:
    """Poll `GET /project/{id}` until Bambu finishes parsing the uploaded .3mf.

    Bambu attaches a profile (slice metadata + plate thumbnails) to the project
    asynchronously after the OSS upload; `/my/task` rejects requests without
    `profileId` (and `cover`). Returns
    `{"profile_id": int|None, "cover": str, "plate_index": int}` — callers fall
    back to safe defaults when parsing is still pending after the poll window.
    """
    from app.services import bambu_provider
    from app.services.bambu_auth import _load_org

    org = _load_org(org_id)
    base = _region_api_base(org.bambu_region)

    for attempt in range(_PROFILE_POLL_ATTEMPTS):
        if attempt:
            time.sleep(_PROFILE_POLL_DELAY_SECONDS)
        try:
            resp = _execute_with_retry(
                org_id, "project.detail",
                lambda token: bambu_provider.get_project_detail(base, _bearer_headers(token), project_id),
                max_attempts=2,
            )
            data = resp.json()
        except (BambuDispatchError, BambuValidationError, ValueError):
            continue
        profiles = [p for p in (data.get("profiles") or []) if isinstance(p, dict)]
        if not profiles:
            continue
        prof = profiles[0]
        profile_id = _numeric_profile_id(prof.get("profile_id") or prof.get("id"))
        cover = ""
        plate_index = 1
        context = prof.get("context") or {}
        for plate in context.get("plates") or []:
            if not isinstance(plate, dict):
                continue
            thumb_url = (plate.get("thumbnail") or {}).get("url") or ""
            if thumb_url:
                cover = thumb_url
                plate_index = int(plate.get("index") or 1)
                break
        return {"profile_id": profile_id, "cover": cover, "plate_index": plate_index}

    log.warning("bambu.cloud.project.profile_pending org_id=%s project_id=%s — dispatching with defaults", org_id, project_id)
    return {"profile_id": None, "cover": "", "plate_index": 1}


def create_task_with_retry(org_id: int, task_body: dict[str, Any]) -> dict[str, Any]:
    """`POST /task` — returns the parsed response (or a status-only stub if non-JSON)."""
    from app.services import bambu
    from app.services.bambu_auth import _load_org

    org = _load_org(org_id)
    base = _region_api_base(org.bambu_region)

    start = time.monotonic()
    resp = _execute_with_retry(org_id, "task.create", lambda token: bambu._cloud_create_task(base, _bearer_headers(token), task_body))
    metrics.timing("bambu.cloud.task_create.latency.ms", (time.monotonic() - start) * 1000, tags=event_tags(org_id=org_id))
    try:
        return resp.json()
    except ValueError:
        return {"http_status": resp.status_code}


# ── Dispatch orchestration ───────────────────────────────────────────────────


def dispatch_cloud_job(job_id: int) -> BambuCloudJob:
    """Run the cloud dispatch flow for a queued job.

    validate -> create project -> upload to OSS -> create print task.

    Synchronous by design — Phase 5's worker calls this off the request thread;
    this phase only provides the engine (no queue/scheduling here). Safe to call
    repeatedly: terminal jobs are returned as-is, and an unprepared job is
    prepared first.
    """
    from app.services import bambu_auth

    dispatch_start = time.monotonic()
    job = _load_job(job_id)
    if job.status in _TERMINAL_STATUSES:
        log_event(
            log,
            logging.INFO,
            "bambu.cloud.job.dispatch_skipped",
            org_id=job.organization_id,
            printer_id=job.printer_id,
            job_id=job_id,
            status=job.status.value,
            reason="terminal",
        )
        return job

    if not job.file_sha256:
        job = prepare_cloud_job(job_id)
        if job.status == BambuCloudJobStatus.failed:
            return job

    try:
        file_bytes = _read_gcode_bytes(job)
    except FileNotFoundError as e:
        return fail_job(job_id, BambuErrorCode.INVALID_3MF, f"Файл відсутній у сховищі: {e}", retryable=False)

    org_id = job.organization_id
    filename = job.file_name or "print.3mf"

    try:
        job = advance_job_status(job_id, BambuCloudJobStatus.creating_project)
        project_data = create_project_with_retry(org_id, filename)
        project = project_data.get("project") or project_data
        project_id = str(project.get("project_id") or project.get("id") or "")
        model_id = str(project.get("model_id") or project_id)
        upload_url = project.get("upload_url") or project_data.get("upload_url")
        cover_url = project.get("cover_url") or project.get("cover") or ""

        job = advance_job_status(
            job_id, BambuCloudJobStatus.uploading,
            bambu_project_id=project_id, bambu_model_id=model_id, project_response_json=project_data,
        )
        log_event(
            log,
            logging.INFO,
            "bambu.cloud.project.created",
            org_id=org_id,
            printer_id=job.printer_id,
            job_id=job_id,
            correlation_id=job.correlation_id,
            bambu_project_id=project_id,
        )

        upload_project_with_retry(org_id, upload_url, file_bytes)
        log_event(
            log,
            logging.INFO,
            "bambu.cloud.upload.completed",
            org_id=org_id,
            printer_id=job.printer_id,
            job_id=job_id,
            correlation_id=job.correlation_id,
        )

        stored = job.request_payload_json or {}
        ams_mapping: list[int] | None = stored.get("ams_mapping")
        use_ams: bool = stored.get("use_ams", True)

        # Bambu parses the uploaded .3mf server-side into a profile — /my/task
        # validates `profileId` and `cover` are set, so fetch the real values.
        # A zero/placeholder profileId is treated as unset by Bambu, so when the
        # profile is still pending after the poll window, fail retryable instead
        # of sending a doomed request.
        profile_info = fetch_project_profile(org_id, project_id)
        if not profile_info["profile_id"]:
            return fail_job(
                job_id, BambuErrorCode.TASK_CREATE_FAILED,
                "Bambu Cloud ще не обробив завантажений файл (profile відсутній). Натисни Retry за хвилину.",
                retryable=True,
            )

        task_body: dict[str, Any] = {
            "modelId": model_id,
            "projectId": project_id,
            "profileId": profile_info["profile_id"],
            "title": filename,
            "deviceId": job.printer_bambu_dev_id,
            "plateIndex": profile_info["plate_index"],
            "useAms": use_ams,
            "bedLeveling": True,
            "flowCali": False,
            "vibrationCali": True,
            "layerInspect": False,
            "timelapse": False,
            "designId": 0,
            "mode": "cloud_file",
            "cover": profile_info["cover"] or cover_url or "",
        }
        if ams_mapping is not None:
            task_body["amsMapping"] = ams_mapping

        log.info(
            "bambu.cloud.task_create org_id=%s printer=%s model_id=%s project_id=%s "
            "ams_mapping=%s use_ams=%s plate=%s body=%s",
            org_id, job.printer_bambu_dev_id, model_id, project_id,
            ams_mapping, use_ams, task_body.get("plateIndex"),
            task_body,
        )
        job = advance_job_status(job_id, BambuCloudJobStatus.task_creating, request_payload_json=task_body)

        task_data = create_task_with_retry(org_id, task_body)
        bambu_task_id = str(task_data.get("id") or task_data.get("task_id") or task_data.get("taskId") or "") or None
        attach_task_response(job_id, task_data, bambu_task_id=bambu_task_id)
        return advance_job_status(job_id, BambuCloudJobStatus.task_created)

    except bambu_auth.BambuAuthError as e:
        return fail_job(job_id, getattr(e, "error_code", BambuErrorCode.AUTH_EXPIRED), str(e), retryable=False)
    except BambuValidationError as e:
        return fail_job(job_id, _stage_error_code(job.status), str(e), retryable=False)
    except BambuDispatchError as e:
        code = _stage_error_code(job.status)
        return fail_job(job_id, code, str(e), retryable=is_retryable(code))
    finally:
        metrics.timing(
            "bambu.cloud.dispatch.latency.ms",
            (time.monotonic() - dispatch_start) * 1000,
            tags=event_tags(org_id=job.organization_id, region=job.region),
        )
