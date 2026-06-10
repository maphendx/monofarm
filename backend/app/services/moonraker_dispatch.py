"""Moonraker send/dispatch mechanics — gcode rewrite + upload + auto-start.

Extracted from `api/files.py:send_to_printer` so the unified print-job pipeline
can reuse it as the Moonraker provider dispatcher (Pass 2): the entry point is
transport-only and knows nothing about job rows or HTTP responses.

Raises `moonraker.MoonrakerError` on upload/start failure — callers map it to
their own result shape. Runs in the web process: agent tunnels terminate here,
not in the worker process.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path

from app.models.bambu_cloud_job import BambuCloudJob, BambuCloudJobStatus
from app.services import moonraker as mr
from app.services import tunnel as _tunnel

log = logging.getLogger(__name__)

# In-process re-entry guard: an idempotency replay can schedule a second
# BackgroundTask for a job whose first task has not started yet.
_inflight: set[int] = set()
_inflight_guard = threading.Lock()


async def dispatch_moonraker_job(job_id: int) -> BambuCloudJob | None:
    """Run the dispatch flow for a queued Moonraker job.

    Web-process only: the agent tunnel used for LAN uploads terminates in the
    web process, not the worker — `files.py` and the retry endpoint schedule
    this as a FastAPI BackgroundTask. Status flow: queued → validating →
    uploading → printing; `print_tracker` finalizes the job from observed
    printer state afterwards.
    """
    from app.core.db import SessionLocal
    from app.models.gcode_file import GcodeFile
    from app.models.printer import Printer
    from app.services import storage as storage_svc
    from app.services.bambu_dispatch import advance_job_status, fail_job
    from app.services.bambu_errors import BambuErrorCode

    with _inflight_guard:
        if job_id in _inflight:
            return None
        _inflight.add(job_id)

    try:
        with SessionLocal() as db:
            job = db.get(BambuCloudJob, job_id)
            if job is None:
                log.warning("moonraker_dispatch: job %s not found", job_id)
                return None
            if job.status != BambuCloudJobStatus.queued:
                log.info("moonraker_dispatch: job %s skipped (status=%s)", job_id, job.status.value)
                db.expunge(job)
                return job
            printer = db.get(Printer, job.printer_id)
            gcode = db.get(GcodeFile, job.gcode_file_id) if job.gcode_file_id else None
            org_id = job.organization_id
            payload = job.request_payload_json or {}
            file_name = job.file_name or (gcode.original_name if gcode else "print.gcode")
            moonraker_url = printer.moonraker_url if printer else None
            stored_name = gcode.stored_name if gcode else None
            filament_meta = (gcode.filament_meta if gcode else None) or {}

        if not moonraker_url:
            return fail_job(job_id, BambuErrorCode.PRINTER_NOT_CONFIGURED, "Принтер не має Moonraker URL", retryable=False)
        if not stored_name:
            return fail_job(job_id, BambuErrorCode.FILE_INVALID, "Завдання не пов'язане з файлом", retryable=False)

        slot_map = {int(k): int(v) for k, v in (payload.get("slot_map") or {}).items()}

        try:
            with storage_svc.local_path_for(stored_name, org_id) as src:
                file_bytes = src.read_bytes()
                if not file_bytes:
                    return fail_job(job_id, BambuErrorCode.FILE_INVALID, "Файл порожній", retryable=False)
                advance_job_status(
                    job_id,
                    BambuCloudJobStatus.validating,
                    file_sha256=hashlib.sha256(file_bytes).hexdigest(),
                    file_size=len(file_bytes),
                )
                advance_job_status(job_id, BambuCloudJobStatus.uploading)
                await send_file_to_moonraker(
                    org_id=org_id,
                    moonraker_url=moonraker_url,
                    src=src,
                    file_name=file_name,
                    filament_meta=filament_meta,
                    slot_map=slot_map,
                    auto_bed_leveling=payload.get("auto_bed_leveling"),
                    timelapse=payload.get("timelapse"),
                    ai_detection=payload.get("ai_detection"),
                    calibrate_slots=payload.get("calibrate_slots"),
                )
        except FileNotFoundError:
            return fail_job(job_id, BambuErrorCode.FILE_INVALID, "Файл відсутній у сховищі", retryable=False)
        except mr.MoonrakerError as e:
            return fail_job(job_id, BambuErrorCode.MOONRAKER_UPLOAD_FAILED, str(e), retryable=True)
        except Exception as e:
            # BackgroundTasks swallow exceptions — convert anything unexpected into a failed job.
            return fail_job(job_id, BambuErrorCode.MOONRAKER_UPLOAD_FAILED, f"{type(e).__name__}: {e}", retryable=True)

        return advance_job_status(
            job_id,
            BambuCloudJobStatus.printing,
            reason="Upload accepted — print started",
            last_mqtt_at=datetime.now(timezone.utc),
        )
    finally:
        with _inflight_guard:
            _inflight.discard(job_id)


async def send_file_to_moonraker(
    *,
    org_id: int,
    moonraker_url: str,
    src: Path,
    file_name: str,
    filament_meta: dict,
    slot_map: dict[int, int],
    auto_bed_leveling: bool | None = None,
    timelapse: bool | None = None,
    ai_detection: bool | None = None,
    calibrate_slots: list[int] | None = None,
) -> None:
    """Apply slot remap / print options, then upload to Moonraker and start the print."""
    has_remap = any(k != v for k, v in slot_map.items())
    calibrate_set = set(calibrate_slots) if calibrate_slots is not None else None

    used_g = filament_meta.get("used_g") or []
    slot_count = max(len(filament_meta.get("colors") or []), len(filament_meta.get("types") or []), 0)
    used_set: set[int] | None = None
    if used_g and slot_count:
        candidate = {i for i in range(slot_count) if i >= len(used_g) or used_g[i] > 0}
        if 0 < len(candidate) < slot_count:
            used_set = candidate

    has_options = (
        auto_bed_leveling is not None
        or timelapse is not None
        or ai_detection is not None
        or used_set is not None
        or calibrate_set is not None
    )

    working: bytes | None = None
    if has_options:
        working = await asyncio.to_thread(
            mr.apply_print_options,
            src,
            auto_bed_leveling,
            timelapse,
            ai_detection,
            used_set,
            calibrate_set,
        )
    if has_remap:
        base = working if working is not None else src
        working = await asyncio.to_thread(mr.remap_slots, base, slot_map)

    upload_bytes: bytes | None = working
    if upload_bytes is None and _tunnel.has_tunnel(org_id):
        upload_bytes = src.read_bytes()

    if _tunnel.has_tunnel(org_id):
        await _tunnel.send_moonraker_upload(
            org_id,
            moonraker_url,
            file_name,
            upload_bytes,  # type: ignore[arg-type]
            start_print=True,
        )
    elif working is not None:
        with tempfile.NamedTemporaryFile(suffix=src.suffix, delete=False) as tmp:
            tmp.write(working)
            tmp_path = Path(tmp.name)
        try:
            await mr.async_upload_gcode(moonraker_url, tmp_path, file_name, start_print=True)
        finally:
            tmp_path.unlink(missing_ok=True)
    else:
        await mr.async_upload_gcode(moonraker_url, src, file_name, start_print=True)
