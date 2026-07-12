"""Persisted orchestration helpers for Bambu A1 Mini + Chitu C1M AutoPrint."""
from __future__ import annotations

import asyncio
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.models.bambu_cloud_job import BambuCloudJob, BambuCloudJobStatus
from app.models.plan import PlanEntry
from app.models.printer import Printer
from app.services.bambu_job_state import ACTIVE_STATUSES, TERMINAL_STATUSES

_printer_locks: dict[int, asyncio.Lock] = {}


def is_a1_mini(model: str | None, dev_id: str | None = None) -> bool:
    normalized = (model or "").lower().replace("-", "").replace("_", "").replace(" ", "")
    return (
        normalized == "n1"
        or ("a1" in normalized and "mini" in normalized)
        or (dev_id or "").upper().startswith("030")
    )


def record_completed_run(db: Session, job: BambuCloudJob) -> bool:
    """Account for one successful AutoPrint run exactly once."""
    if (
        job.status != BambuCloudJobStatus.completed
        or job.plan_entry_id is None
        or job.autoprint_run_index is None
    ):
        return False

    entry = db.get(PlanEntry, job.plan_entry_id)
    printer = db.get(Printer, job.printer_id)
    if entry is None or printer is None:
        return False
    if entry.organization_id != job.organization_id or entry.printer_id != printer.id:
        return False
    if job.autoprint_run_index <= entry.runs_completed:
        return False
    if job.autoprint_run_index != entry.runs_completed + 1:
        return False

    entry.runs_completed = job.autoprint_run_index
    entry.done = entry.runs_completed >= entry.runs_total
    printer.autoprint_plates_remaining = max(
        0,
        printer.autoprint_plates_remaining - 1,
    )
    printer.autoprint_error = None
    db.flush()
    return True


def _file_safety_error(meta: dict[str, Any] | None) -> str | None:
    meta = meta or {}
    source_model = meta.get("printer_model")
    if source_model and not is_a1_mini(str(source_model)):
        return "3MF підготовлений не для Bambu A1 Mini"

    limits = {"print_size_x": 180, "print_size_y": 170, "print_size_z": 160}
    for field, limit in limits.items():
        value = meta.get(field)
        if value is None:
            continue
        try:
            if float(value) > limit:
                return f"Модель завелика для PlateCycler: {field}={value} мм, максимум {limit} мм"
        except (TypeError, ValueError):
            return f"Некоректний розмір моделі у 3MF: {field}={value}"
    return None


def _set_error(db: Session, printer: Printer, message: str) -> None:
    printer.autoprint_error = message[:2000]
    db.commit()


def _has_more_runs(db: Session, entry: PlanEntry) -> bool:
    if entry.runs_completed + 1 < entry.runs_total:
        return True
    return (
        db.query(PlanEntry.id)
        .filter(
            PlanEntry.organization_id == entry.organization_id,
            PlanEntry.printer_id == entry.printer_id,
            PlanEntry.plan_date == entry.plan_date,
            PlanEntry.done.is_(False),
            PlanEntry.id != entry.id,
            PlanEntry.runs_completed < PlanEntry.runs_total,
        )
        .first()
        is not None
    )


async def start_next_for_printer(
    printer_id: int,
    *,
    allow_finished_state: bool = False,
) -> BambuCloudJob | None:
    """Dispatch the next eligible PlateCycler run when the printer is idle."""
    lock = _printer_locks.setdefault(printer_id, asyncio.Lock())
    async with lock:
        from app.core.db import SessionLocal
        from app.models.gcode_file import GcodeFile
        from app.models.task import PrintTask
        from app.services import bambu
        from app.services.bambu_dispatch import create_cloud_job
        from app.services.bambu_lan_dispatch import dispatch_lan_job, has_agent_tunnel
        from app.services.bambu_mapping import build_ams_mapping
        from app.services.schedule_conflict import check_eligibility

        with SessionLocal() as db:
            printer = db.get(Printer, printer_id)
            if (
                printer is None
                or printer.autoprint_mode != "platecycler"
                or printer.autoprint_plates_remaining <= 0
                or printer.autoprint_error
                or not printer.bambu_dev_id
            ):
                return None
            if not has_agent_tunnel(printer.organization_id):
                return None

            active_job = (
                db.query(BambuCloudJob.id)
                .filter(
                    BambuCloudJob.printer_id == printer.id,
                    BambuCloudJob.status.in_(ACTIVE_STATUSES),
                )
                .first()
            )
            if active_job is not None:
                return None

            state = bambu.get_cached_state(printer.bambu_dev_id).get("state")
            allowed_states = {"idle", "operational"} if allow_finished_state else {"idle"}
            if state not in allowed_states:
                return None

            entries = (
                db.query(PlanEntry)
                .filter(
                    PlanEntry.organization_id == printer.organization_id,
                    PlanEntry.printer_id == printer.id,
                    PlanEntry.plan_date == date.today(),
                    PlanEntry.done.is_(False),
                    PlanEntry.runs_completed < PlanEntry.runs_total,
                )
                .order_by(PlanEntry.priority.desc(), PlanEntry.sequence, PlanEntry.created_at)
                .all()
            )
            entry = next(
                (candidate for candidate in entries if check_eligibility(candidate, datetime.now(timezone.utc))[0]),
                None,
            )
            if entry is None:
                return None

            task = db.get(PrintTask, entry.task_id)
            gcode = db.get(GcodeFile, task.gcode_file_id) if task and task.gcode_file_id else None
            if task is None or gcode is None:
                _set_error(db, printer, "У запланованого завдання немає 3MF-файлу")
                return None
            if not "".join(Path(gcode.original_name).suffixes).lower().endswith(".3mf"):
                _set_error(db, printer, "AutoPrint PlateCycler підтримує лише 3MF-файли")
                return None

            safety_error = _file_safety_error(gcode.filament_meta)
            if safety_error:
                _set_error(db, printer, safety_error)
                return None

            ams_mapping, detected_use_ams, _details = build_ams_mapping(gcode.filament_meta, printer)
            use_ams = printer.bambu_has_ams if printer.bambu_has_ams is not None else detected_use_ams
            if not use_ams:
                ams_mapping = None
            run_index = entry.runs_completed + 1
            eject_after_print = printer.autoprint_eject_last_plate or _has_more_runs(db, entry)
            # Cloud-mode printers reject LAN MQTT (needs Developer Mode) — the agent
            # still FTPS-uploads to the SD, but the start command goes via cloud MQTT.
            start_via = "lan" if printer.bambu_lan_mode else "cloud"
            job = create_cloud_job(
                db,
                org_id=printer.organization_id,
                printer_id=printer.id,
                printer_bambu_dev_id=printer.bambu_dev_id,
                gcode_file_id=gcode.id,
                file_name=gcode.original_name,
                dispatch_mode="lan",
                idempotency_key=f"autoprint:{printer.organization_id}:{entry.id}:{run_index}",
                request_payload={
                    "source": "platecycler_autoprint",
                    "start_via": start_via,
                    "ams_mapping": ams_mapping,
                    "use_ams": use_ams,
                    "platecycler": {
                        "cooldown_temp_c": printer.autoprint_cooldown_temp_c,
                        "delay_seconds": printer.autoprint_delay_seconds,
                        "eject_after_print": eject_after_print,
                    },
                },
            )
            job.plan_entry_id = entry.id
            job.autoprint_run_index = run_index
            printer.autoprint_error = None
            db.commit()
            job_id = job.id

        result = await dispatch_lan_job(job_id)
        if result and result.status == BambuCloudJobStatus.failed:
            with SessionLocal() as db:
                printer = db.get(Printer, printer_id)
                if printer is not None:
                    _set_error(db, printer, result.status_reason or "Не вдалося запустити AutoPrint")
        return result


async def handle_terminal_job(job_id: int) -> None:
    """Advance or stop a PlateCycler series after a correlated terminal report."""
    from app.core.db import SessionLocal

    printer_id: int | None = None
    should_continue = False
    with SessionLocal() as db:
        job = db.get(BambuCloudJob, job_id)
        if job is None or job.plan_entry_id is None or job.status not in TERMINAL_STATUSES:
            return
        printer = db.get(Printer, job.printer_id)
        if printer is None:
            return
        printer_id = printer.id
        if job.status == BambuCloudJobStatus.completed:
            changed = record_completed_run(db, job)
            db.commit()
            should_continue = changed and printer.autoprint_plates_remaining > 0
        else:
            _set_error(
                db,
                printer,
                job.status_reason or f"AutoPrint зупинено: {job.status.value}",
            )

    if should_continue and printer_id is not None:
        await start_next_for_printer(printer_id, allow_finished_state=True)


async def start_next_for_device(
    org_id: int,
    dev_id: str,
    *,
    allow_finished_state: bool = False,
) -> BambuCloudJob | None:
    """Resolve a LAN status push to its persisted printer and try AutoPrint."""
    from app.core.db import SessionLocal

    with SessionLocal() as db:
        printer = (
            db.query(Printer)
            .filter(
                Printer.organization_id == org_id,
                Printer.bambu_dev_id == dev_id,
                Printer.autoprint_mode == "platecycler",
            )
            .first()
        )
        if printer is None:
            return None
        printer_id = printer.id
        if allow_finished_state:
            latest_job = (
                db.query(BambuCloudJob)
                .filter(BambuCloudJob.printer_id == printer.id)
                .order_by(BambuCloudJob.id.desc())
                .first()
            )
            allow_finished_state = bool(
                latest_job
                and latest_job.plan_entry_id is not None
                and latest_job.status == BambuCloudJobStatus.completed
            )
    return await start_next_for_printer(
        printer_id,
        allow_finished_state=allow_finished_state,
    )


async def run_kick_listener() -> None:
    """Consume worker-published AutoPrint kicks (Redis `autoprint:kick`).

    Cloud MQTT reports land in the worker process, but PlateCycler dispatch
    needs the agent tunnel that terminates in the web process — this listener
    runs in the web lifespan and acts only when this process holds the tunnel
    (terminal-job accounting runs regardless: it is pure DB work).
    """
    import json
    import logging

    import redis.asyncio as aioredis

    from app.core.config import settings
    from app.services.bambu_lan_dispatch import has_agent_tunnel

    log = logging.getLogger(__name__)
    if not settings.REDIS_URL:
        return
    while True:
        try:
            client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
            pubsub = client.pubsub()
            await pubsub.subscribe("autoprint:kick")
            log.info("autoprint kick listener: subscribed")
            async for message in pubsub.listen():
                if message.get("type") != "message":
                    continue
                try:
                    event = json.loads(message["data"])
                    org_id = int(event["org_id"])
                    if "job_id" in event:
                        await handle_terminal_job(int(event["job_id"]))
                    elif has_agent_tunnel(org_id):
                        await start_next_for_device(
                            org_id,
                            str(event.get("dev_id") or ""),
                            allow_finished_state=bool(event.get("finished")),
                        )
                except asyncio.CancelledError:
                    raise
                except Exception:
                    log.exception("autoprint kick failed: %s", message.get("data"))
        except asyncio.CancelledError:
            return
        except Exception:
            log.exception("autoprint kick listener lost connection — retrying in 5s")
            await asyncio.sleep(5)
