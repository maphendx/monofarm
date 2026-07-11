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
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from pathlib import Path

from app.models.bambu_cloud_job import BambuCloudJob, BambuCloudJobStatus
from app.models.printer import PrinterKind
from app.services import moonraker as mr
from app.services import tunnel as _tunnel

log = logging.getLogger(__name__)

# In-process re-entry guard: an idempotency replay can schedule a second
# BackgroundTask for a job whose first task has not started yet.
_inflight: set[int] = set()
_inflight_guard = threading.Lock()

UploadProgressCallback = Callable[[int], Awaitable[None]]


def validate_moonraker_filename(printer_kind: PrinterKind | None, file_name: str) -> str:
    """Return a safe printer-local filename and enforce kind capabilities."""
    safe_name = Path(file_name).name
    if not safe_name or safe_name in {".", ".."}:
        raise mr.MoonrakerError("Файл не має валідного імені")
    if printer_kind == PrinterKind.snapmaker_u1 and Path(safe_name).suffix.lower() not in {".gcode", ".gco", ".g"}:
        raise mr.MoonrakerError("Snapmaker U1 приймає лише .gcode, .gco або .g файли")
    return safe_name


def build_u1_mapping_script(slot_map: dict[int, int]) -> str:
    """Build the U1 logical-palette to physical-head mapping command."""
    if not slot_map:
        return ""
    tools = sorted(slot_map)
    heads = [slot_map[tool] for tool in tools]
    if len(set(heads)) != len(heads):
        raise mr.MoonrakerError("Два кольори не можуть бути призначені на одну голову")
    if any(tool < 0 or head < 0 or head > 3 for tool, head in slot_map.items()):
        raise mr.MoonrakerError("Snapmaker U1 має голови T1–T4")
    lines = [
        f"SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER={tool} MAP_EXTRUDER={slot_map[tool]}"
        for tool in tools
    ]
    lines.append("SET_PRINT_USED_EXTRUDERS EXTRUDERS=" + ",".join(str(head) for head in heads))
    return "\n".join(lines)


def interpret_upload_result(response: dict) -> str:
    """Normalize Moonraker's upload response into a dispatch-level outcome."""
    result = response.get("result", response) if isinstance(response, dict) else {}
    if not isinstance(result, dict):
        return "not_started"
    if result.get("print_started") is True:
        return "started"
    if result.get("print_queued") is True:
        return "queued"
    return "not_started"


async def dispatch_moonraker_job(job_id: int) -> BambuCloudJob | None:
    """Run the dispatch flow for a queued Moonraker job.

    Web-process only: the agent tunnel used for LAN uploads terminates in the
    web process, not the worker — `files.py` and the retry endpoint schedule
    this as a FastAPI BackgroundTask. Status flow: queued → validating →
    uploading → acknowledged → printing; `print_tracker` confirms and finalizes the job from observed
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
            printer_kind = printer.kind if printer else None
            stored_name = gcode.stored_name if gcode else None
            filament_meta = (gcode.filament_meta if gcode else None) or {}

        if not moonraker_url:
            return fail_job(job_id, BambuErrorCode.PRINTER_NOT_CONFIGURED, "Принтер не має Moonraker URL", retryable=False)
        if not stored_name:
            return fail_job(job_id, BambuErrorCode.FILE_INVALID, "Завдання не пов'язане з файлом", retryable=False)

        slot_map = {int(k): int(v) for k, v in (payload.get("slot_map") or {}).items()}
        try:
            file_name = validate_moonraker_filename(printer_kind, file_name)
        except mr.MoonrakerError as e:
            return fail_job(job_id, BambuErrorCode.FILE_INVALID, str(e), retryable=False)

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
                advance_job_status(job_id, BambuCloudJobStatus.uploading, progress_pct=0)

                last_progress = -1

                async def on_upload_progress(progress_pct: int) -> None:
                    nonlocal last_progress
                    bounded = max(0, min(100, int(progress_pct)))
                    if bounded == 100 or bounded - last_progress >= 5:
                        last_progress = bounded
                        advance_job_status(job_id, BambuCloudJobStatus.uploading, progress_pct=bounded)

                result = await send_file_to_moonraker(
                    org_id=org_id,
                    moonraker_url=moonraker_url,
                    src=src,
                    file_name=file_name,
                    filament_meta=filament_meta,
                    slot_map=slot_map,
                    printer_kind=printer_kind,
                    auto_bed_leveling=payload.get("auto_bed_leveling"),
                    timelapse=payload.get("timelapse"),
                    ai_detection=payload.get("ai_detection"),
                    calibrate_slots=payload.get("calibrate_slots"),
                    on_upload_progress=on_upload_progress,
                    presigned_url=storage_svc.presigned_url(stored_name, org_id),
                )
        except FileNotFoundError:
            return fail_job(job_id, BambuErrorCode.FILE_INVALID, "Файл відсутній у сховищі", retryable=False)
        except mr.MoonrakerError as e:
            return fail_job(job_id, BambuErrorCode.MOONRAKER_UPLOAD_FAILED, str(e), retryable=True)
        except Exception as e:
            # BackgroundTasks swallow exceptions — convert anything unexpected into a failed job.
            return fail_job(job_id, BambuErrorCode.MOONRAKER_UPLOAD_FAILED, f"{type(e).__name__}: {e}", retryable=True)

        # A legacy mock/adapter may not return a result; production transports
        # always do, but keep the dispatcher backward-compatible for retries.
        result = result or {"start_requested": True, "upload_state": "started"}
        if not result.get("start_requested"):
            return fail_job(
                job_id,
                BambuErrorCode.MOONRAKER_START_FAILED,
                "Moonraker прийняв файл, але не підтвердив запуск друку",
                retryable=True,
                details={"upload_state": result.get("upload_state")},
            )

        upload_state = result.get("upload_state")
        reason = (
            "Snapmaker U1 прийняв команду старту — очікуємо підтвердження printing"
            if printer_kind == PrinterKind.snapmaker_u1
            else "Moonraker прийняв запуск — очікуємо підтвердження printing"
        )
        if upload_state == "queued":
            reason = "Принтер поставив файл у свою чергу — очікуємо старту"

        return advance_job_status(
            job_id,
            BambuCloudJobStatus.acknowledged,
            reason=reason,
            last_mqtt_at=datetime.now(timezone.utc),
            error_details_json={"moonraker_upload_state": upload_state},
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
    printer_kind: PrinterKind | None = None,
    auto_bed_leveling: bool | None = None,
    timelapse: bool | None = None,
    ai_detection: bool | None = None,
    calibrate_slots: list[int] | None = None,
    on_upload_progress: UploadProgressCallback | None = None,
    presigned_url: str | None = None,
) -> dict:
    """Prepare, upload, and explicitly start a Moonraker print.

    Snapmaker U1 keeps logical palette indices in the gcode. Its physical head
    mapping is therefore sent as firmware macros after upload and before the
    explicit ``SDCARD_PRINT_FILE`` start command.
    """
    file_name = validate_moonraker_filename(printer_kind, file_name)
    is_u1 = printer_kind == PrinterKind.snapmaker_u1
    has_remap = any(k != v for k, v in slot_map.items()) and not is_u1
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

    upload_result: dict
    if _tunnel.has_tunnel(org_id):
        async def tunnel_progress(data: dict) -> None:
            if on_upload_progress is None:
                return
            sent = int(data.get("sent") or 0)
            total = int(data.get("total") or 0)
            await on_upload_progress(round(sent * 100 / max(total, 1)))

        upload_result = await _tunnel.send_moonraker_upload(
            org_id,
            moonraker_url,
            file_name,
            upload_bytes,  # type: ignore[arg-type]
            start_print=not is_u1,
            progress_callback=tunnel_progress if on_upload_progress is not None else None,
            # Rewritten gcode differs from the stored object — R2 direct
            # download is only valid when the file goes out unmodified.
            presigned_url=presigned_url if working is None else None,
        )
    elif working is not None:
        with tempfile.NamedTemporaryFile(suffix=src.suffix, delete=False) as tmp:
            tmp.write(working)
            tmp_path = Path(tmp.name)
        try:
            upload_result = await mr.async_upload_gcode(
                moonraker_url,
                tmp_path,
                file_name,
                start_print=not is_u1,
                timeout=mr.upload_timeout_for_size(tmp_path.stat().st_size),
            )
        finally:
            tmp_path.unlink(missing_ok=True)
    else:
        upload_result = await mr.async_upload_gcode(
            moonraker_url,
            src,
            file_name,
            start_print=not is_u1,
            timeout=mr.upload_timeout_for_size(src.stat().st_size),
        )

    if on_upload_progress is not None:
        await on_upload_progress(100)

    upload_state = interpret_upload_result(upload_result)
    if is_u1:
        mapping_script = build_u1_mapping_script(slot_map)
        if mapping_script:
            await _send_moonraker_gcode(org_id, moonraker_url, mapping_script)
        await _send_moonraker_gcode(org_id, moonraker_url, f'SDCARD_PRINT_FILE FILENAME="{file_name}"')
        return {
            "upload": upload_result,
            "upload_state": "not_started",
            "start_requested": True,
            "mapping_applied": bool(mapping_script),
        }

    return {
        "upload": upload_result,
        "upload_state": upload_state,
        "start_requested": upload_state in {"started", "queued"},
        "mapping_applied": False,
    }


async def _send_moonraker_gcode(org_id: int, moonraker_url: str, script: str) -> dict:
    """Send a G-code script through the active agent or directly to Moonraker."""
    if _tunnel.has_tunnel(org_id):
        return await _tunnel.moonraker_action(
            org_id,
            moonraker_url,
            "/printer/gcode/script",
            {"script": script},
            timeout=30.0,
        )
    return await asyncio.to_thread(mr.send_gcode, moonraker_url, script)
