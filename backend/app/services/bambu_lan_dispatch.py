"""Bambu LAN dispatch — job-tracked FTPS upload + LAN MQTT print start.

The SimplyPrint flow: the farm agent (or the backend itself when it shares the
LAN) uploads the .3mf to the printer over FTPS (:990, implicit TLS) and starts
the print with an MQTT `project_file` command on :8883. Works on old firmware
out of the box and on post-Jan-2025 firmware with Developer Mode (LAN Only
Mode) enabled — no X.509 signing needed.

Status flow: queued → validating → uploading → task_creating → task_created;
MQTT report correlation (`bambu._sync_cloud_job_from_report`) takes over from
there. The `project_file` command carries `task_id = job.correlation_id`, and
the printer echoes it in `push_status`, so correlation is deterministic.

Web-process only: the agent tunnel terminates here, not in the worker —
`files.py` and the retry endpoint schedule this as a FastAPI BackgroundTask.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import threading
from pathlib import Path

from app.models.bambu_cloud_job import BambuCloudJob, BambuCloudJobStatus
from app.services import bambu
from app.services import tunnel as _tunnel
from app.services.bambu_mapping import is_a1_series

log = logging.getLogger(__name__)

# In-process re-entry guard: an idempotency replay can schedule a second
# BackgroundTask for a job whose first task has not started yet.
_inflight: set[int] = set()
_inflight_guard = threading.Lock()

# Tunnel wait budget for BAMBU_UPLOAD: the agent downloads from R2 and then
# FTPS-uploads over the printer's (often 2.4GHz-only) Wi-Fi, so scale with
# file size instead of a flat wait. Capped at the presigned-URL lifetime.
_UPLOAD_BASE_TIMEOUT_S = 180.0
_UPLOAD_MIN_RATE_BYTES_S = 128 * 1024
_UPLOAD_MAX_TIMEOUT_S = 900.0


def _upload_timeout(size_bytes: int) -> float:
    return min(_UPLOAD_MAX_TIMEOUT_S, _UPLOAD_BASE_TIMEOUT_S + size_bytes / _UPLOAD_MIN_RATE_BYTES_S)


def _bambu_upload_target_dir(model: str | None, dev_id: str | None = None) -> str:
    """A1 firmware reads project_file from SD root; P/X printers use cache."""
    is_a1 = is_a1_series(model) or (dev_id or "").upper().startswith(("030", "039"))
    return "sdcard" if is_a1 else "cache"


def has_agent_tunnel(org_id: int) -> bool:
    return _tunnel.has_tunnel(org_id)


async def dispatch_lan_job(job_id: int) -> BambuCloudJob | None:
    """Run the LAN dispatch flow for a queued Bambu job."""
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
                log.warning("bambu_lan_dispatch: job %s not found", job_id)
                return None
            if job.status != BambuCloudJobStatus.queued:
                log.info("bambu_lan_dispatch: job %s skipped (status=%s)", job_id, job.status.value)
                db.expunge(job)
                return job
            printer = db.get(Printer, job.printer_id)
            gcode = db.get(GcodeFile, job.gcode_file_id) if job.gcode_file_id else None
            org_id = job.organization_id
            payload = job.request_payload_json or {}
            file_name = job.file_name or (gcode.original_name if gcode else "print.3mf")
            correlation_id = job.correlation_id
            dev_id = (printer.bambu_dev_id or "").strip() if printer else ""
            dev_ip = (printer.bambu_dev_ip or "").strip() if printer else ""
            access_code = (printer.bambu_access_code or "").strip() if printer else ""
            upload_target_dir = _bambu_upload_target_dir(
                printer.bambu_model if printer else None,
                dev_id,
            )
            start_via = (payload.get("start_via") or "lan").strip().lower()
            stored_name = gcode.stored_name if gcode else None

        if not dev_id or not dev_ip or not access_code:
            return fail_job(
                job_id, BambuErrorCode.PRINTER_NOT_CONFIGURED,
                "Для Bambu LAN потрібні dev_id, IP адреса та LAN Access Code",
                retryable=False,
            )
        if not stored_name:
            return fail_job(job_id, BambuErrorCode.FILE_INVALID, "Завдання не пов'язане з файлом", retryable=False)
        if not "".join(Path(file_name).suffixes).lower().endswith(".3mf"):
            return fail_job(
                job_id, BambuErrorCode.INVALID_3MF,
                f"Bambu Lab приймає лише .3mf файли (отримано «{file_name}»)",
                retryable=False,
            )

        # ASCII-safe SD name: the project_file URL is sent unescaped, so
        # spaces/Cyrillic in the original name break parsing on some firmware.
        lan_filename = bambu.sanitize_sd_filename(Path(file_name).name, fallback=f"job-{job_id}")
        has_tunnel = _tunnel.has_tunnel(org_id)
        platecycler = payload.get("platecycler")

        # ── validating ───────────────────────────────────────────────────────
        try:
            file_bytes = await asyncio.to_thread(storage_svc.get_bytes, stored_name, org_id)
        except FileNotFoundError:
            return fail_job(job_id, BambuErrorCode.FILE_INVALID, "Файл відсутній у сховищі", retryable=False)
        if not file_bytes:
            return fail_job(job_id, BambuErrorCode.FILE_INVALID, "Файл порожній", retryable=False)
        if isinstance(platecycler, dict):
            from app.services.platecycler_3mf import PlateCycler3MFError, build_platecycler_3mf

            try:
                file_bytes = build_platecycler_3mf(
                    file_bytes,
                    cooldown_temp_c=int(platecycler.get("cooldown_temp_c", 40)),
                    delay_seconds=int(platecycler.get("delay_seconds", 0)),
                    eject_after_print=bool(platecycler.get("eject_after_print", True)),
                )
            except (PlateCycler3MFError, TypeError, ValueError) as exc:
                return fail_job(
                    job_id,
                    BambuErrorCode.INVALID_3MF,
                    f"Не вдалося підготувати 3MF для PlateCycler: {exc}",
                    retryable=False,
                )
            lan_filename = f"autoprint-{job_id}.3mf"
        # The project_file `param` must point at the real gcode entry: an
        # exported plate keeps its project number (plate 2 → plate_2.gcode),
        # and a hardcoded plate_1 makes the printer "fail to parse the file".
        plate_gcode = bambu.plate_gcode_entry(file_bytes)
        if plate_gcode is None:
            return fail_job(
                job_id, BambuErrorCode.INVALID_3MF,
                f"У «{file_name}» немає слайснутого G-коду (Metadata/plate_N.gcode) — "
                "експортуй з слайсера «sliced file», а не файл проєкту",
                retryable=False,
            )
        advance_job_status(
            job_id,
            BambuCloudJobStatus.validating,
            file_sha256=hashlib.sha256(file_bytes).hexdigest(),
            file_size=len(file_bytes),
        )

        # ── uploading (FTPS via agent, direct LAN fallback) ──────────────────
        advance_job_status(job_id, BambuCloudJobStatus.uploading)
        try:
            if has_tunnel:
                presigned = None
                if not isinstance(platecycler, dict):
                    presigned = storage_svc.presigned_url(stored_name, org_id, expires=900)
                remote_path = await _tunnel.send_bambu_upload(
                    org_id,
                    dev_ip,
                    access_code,
                    lan_filename,
                    file_bytes=None if presigned else file_bytes,
                    presigned_url=presigned,
                    target_dir=upload_target_dir,
                    timeout=_upload_timeout(len(file_bytes)),
                )
            elif isinstance(platecycler, dict):
                raise RuntimeError("PlateCycler AutoPrint потребує підключений monofarm-agent")
            else:
                with storage_svc.local_path_for(stored_name, org_id) as src:
                    remote_path = await asyncio.to_thread(
                        bambu.upload_3mf, dev_ip, access_code, src, lan_filename,
                        upload_target_dir,
                    )
        except (RuntimeError, bambu.BambuError, OSError) as e:
            if not has_tunnel:
                return fail_job(
                    job_id, BambuErrorCode.AGENT_NOT_CONNECTED,
                    f"FTPS upload не вдався і agent не підключений: {e}. "
                    "Запусти monofarm-agent у мережі ферми.",
                    retryable=True,
                )
            return fail_job(
                job_id, BambuErrorCode.LAN_UPLOAD_FAILED,
                f"FTPS upload на {dev_ip} не вдався: {e}",
                retryable=True,
            )

        # ── task_creating → project_file via LAN MQTT ────────────────────────
        stored_slots = payload or {}
        bed_leveling = stored_slots.get("auto_bed_leveling")
        start_payload = bambu.build_start_print_payload(
            dev_id,
            file_name,
            ams_mapping=stored_slots.get("ams_mapping"),
            use_ams=stored_slots.get("use_ams", True),
            ftp_filename=remote_path,
            task_id=correlation_id,
            plate_gcode=plate_gcode,
            bed_leveling=True if bed_leveling is None else bool(bed_leveling),
            flow_cali=bool(stored_slots.get("flow_calibration")),
        )
        advance_job_status(job_id, BambuCloudJobStatus.task_creating, bambu_task_id=correlation_id)
        try:
            if start_via == "lan" and has_tunnel:
                await _tunnel.send_bambu_mqtt(org_id, dev_id, dev_ip, access_code, start_payload)
            else:
                await asyncio.to_thread(bambu._publish, dev_id, start_payload, 1)
        except (RuntimeError, bambu.BambuError) as e:
            return fail_job(
                job_id, BambuErrorCode.LAN_MQTT_FAILED,
                f"Принтер не прийняв команду друку: {e}",
                retryable=True,
                details={"developer_mode_hint": "На прошивці X1/P1 ≥01.07 або A1 ≥01.03 увімкни LAN Only Mode + Developer Mode на принтері"},
            )

        return advance_job_status(
            job_id,
            BambuCloudJobStatus.task_created,
            reason=(
                "project_file надіслано через Bambu Cloud — очікуємо підтвердження від принтера"
                if start_via == "cloud"
                else "project_file надіслано через LAN — очікуємо підтвердження від принтера"
            ),
        )
    except Exception as e:
        # BackgroundTasks swallow exceptions — convert anything unexpected into a failed job.
        from app.services.bambu_dispatch import fail_job
        from app.services.bambu_errors import BambuErrorCode
        return fail_job(job_id, BambuErrorCode.DISPATCH_FAILED, f"{type(e).__name__}: {e}", retryable=True)
    finally:
        with _inflight_guard:
            _inflight.discard(job_id)
