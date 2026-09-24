"""Central filament-consumption accounting for finalized print runs.

One physical print is accounted exactly once, through one pipeline:

    printer telemetry → resolve consumption (source hierarchy)
        → spool deduction (FilamentLog, idempotent)
        → warehouse WRITE_OFF (ledger, idempotent)
        → print material cost

Printer drivers only *report* data (planned grams, actual grams, active
slot); every inventory mutation happens here, in the caller's transaction.
The same run may be finalized through the tracker, cloud sync, retries or
history backfill — the deterministic reason keys make repeats no-ops.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from decimal import Decimal
from typing import TYPE_CHECKING

from app.models.gcode_file import GcodeFile
from app.models.bambu_cloud_job import BambuCloudJob
from app.services.filament_accounting import write_off_warehouse_material  # noqa: F401 — re-exported

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

    from app.models.print_history import PrintHistory
    from app.models.printer import Printer

log = logging.getLogger(__name__)

# Consumption source labels — observable in logs and slots_used metadata.
SOURCE_ACTUAL_PER_SLOT = "actual_per_slot"
SOURCE_ACTUAL_TOTAL_SCALED = "actual_total_scaled"
SOURCE_PLANNED_PROGRESS = "planned_progress_estimate"
SOURCE_PLANNED_COMPLETED = "planned_completed_fallback"
SOURCE_ACTIVE_SLOT = "active_slot_fallback"
SOURCE_EQUAL_SPLIT = "equal_split_fallback"
SOURCE_NONE = "none"

_TASK_REASON_PREFIX = "task:"
_RUN_REASON_PATTERN = re.compile(r"^print_history:(\d+):slot(\d+)$")

# Physical defaults for length→mass conversion when slicer metadata is absent
# (1.75 mm filament, PLA density). Used only as a last-resort estimate.
DEFAULT_DIAMETER_MM = 1.75
DEFAULT_DENSITY_G_CM3 = 1.24

DISCREPANCY_LOG_PREFIX = "print_accounting.discrepancy"


@dataclass
class Consumption:
    """Resolved consumption of one finalized run, with its provenance."""

    grams_by_slot: dict[int, float] = field(default_factory=dict)
    source: str = SOURCE_NONE
    actual_total_g: float | None = None
    planned_total_g: float | None = None
    progress_ratio: float | None = None


@dataclass
class AppliedConsumption:
    """Inventory result of applying one consumption."""

    total_grams: float = 0.0
    cost: Decimal | None = None
    low_filaments: list = field(default_factory=list)  # (Filament, grams_before)


def filament_grams(length_mm: float, diameter_mm: float, density_g_cm3: float) -> float:
    """Canonical filament length→mass conversion. Units: mm × mm → g."""
    if length_mm <= 0 or diameter_mm <= 0 or density_g_cm3 <= 0:
        return 0.0
    volume_mm3 = 3.141592653589793 * (diameter_mm / 2.0) ** 2 * length_mm
    return volume_mm3 / 1000.0 * density_g_cm3


def run_already_deducted(db: "Session", history_id: int) -> bool:
    """True when any spool deduction for this run already exists.

    The LIKE suffix cannot match a different history id (':slot' separator).
    """
    from app.models.filament import FilamentLog

    return db.query(FilamentLog.id).filter(
        FilamentLog.reason.like(f"print_history:{history_id}:slot%"),
    ).first() is not None


def _run_reason(history_id: int, slot_index: int) -> str:
    return f"print_history:{history_id}:slot{slot_index}"


def task_reason(task_id: int, filament_id: int) -> str:
    return f"{_TASK_REASON_PREFIX}{task_id}:filament{filament_id}"


def _job_of(db: "Session", history: "PrintHistory") -> BambuCloudJob | None:
    if history.bambu_cloud_job_id is None:
        return None
    return db.query(BambuCloudJob).filter_by(
        id=history.bambu_cloud_job_id, organization_id=history.organization_id,
    ).first()


def _local_file_of(
    db: "Session", history: "PrintHistory", printer: "Printer", job: BambuCloudJob | None,
) -> GcodeFile | None:
    """The Monofarm library copy of the printed file, when it exists."""
    file_id = job.gcode_file_id if job is not None else printer.last_gcode_file_id
    if file_id is None:
        return None
    return db.query(GcodeFile).filter_by(
        id=file_id, organization_id=history.organization_id,
    ).first()


def _planned_grams(
    db: "Session", history: "PrintHistory", printer: "Printer", job: BambuCloudJob | None,
) -> dict[int, float]:
    """Planned per-slot grams: printer-side metadata first, library meta second."""
    from app.services import moonraker

    snapshot = (job.request_payload_json or {}).get("material_plan") if job else history.material_plan
    if snapshot and any("grams" in row for row in snapshot.values()):
        return {int(i): float(row.get("grams") or 0) for i, row in snapshot.items() if row.get("grams")}
    planned: dict[int, float] = {}
    if history.file_name and printer.moonraker_url:
        try:
            meta = moonraker.get_remote_file_meta(
                printer.moonraker_url, history.file_name,
                org_id=history.organization_id,
            )
            planned = {i: float(g) for i, g in enumerate(meta.get("used_g") or []) if g and g > 0}
        except Exception:  # noqa: BLE001 — metadata is advisory
            planned = {}
    if not planned:
        file = _local_file_of(db, history, printer, job)
        meta_used = (file.filament_meta or {}).get("used_g") if file else None
        if meta_used:
            planned = {i: float(g) for i, g in enumerate(meta_used) if g and g > 0}
    return planned


def _planned_geometry(
    db: "Session", history: "PrintHistory", printer: "Printer", job: BambuCloudJob | None,
) -> tuple[list[float], list[float]]:
    """Per-slot filament diameter (mm) and density (g/cm³) from slicer metadata."""
    from app.services import moonraker

    diameters: list[float] = []
    densities: list[float] = []
    if history.file_name and printer.moonraker_url:
        try:
            meta = moonraker.get_remote_file_meta(
                printer.moonraker_url, history.file_name,
                org_id=history.organization_id,
            )
            diameters = [float(d) for d in meta.get("filament_diameter") or [] if d]
            densities = [float(d) for d in meta.get("filament_density") or [] if d]
        except Exception:  # noqa: BLE001 — metadata is advisory
            diameters, densities = [], []
    if not diameters or not densities:
        file = _local_file_of(db, history, printer, job)
        meta = (file.filament_meta or {}) if file else {}
        if not diameters and meta.get("filament_diameter"):
            diameters = [float(d) for d in meta["filament_diameter"] if d]
        if not densities and meta.get("filament_density"):
            densities = [float(d) for d in meta["filament_density"] if d]
    return diameters, densities


def _loaded_slot_indexes(db: "Session", printer: "Printer") -> list[int]:
    from app.models.printer_slot import PrinterSlot

    return [
        row[0] for row in db.query(PrinterSlot.slot_index).filter(
            PrinterSlot.printer_id == printer.id,
            PrinterSlot.filament_id.isnot(None),
        ).order_by(PrinterSlot.slot_index).all()
    ]


def resolve_consumption(
    db: "Session",
    history: "PrintHistory",
    printer: "Printer",
    result: str,
) -> Consumption:
    """Answer 'how much was consumed, from which slots' for a finalized run.

    Source hierarchy (first match wins):
      1. actual per-slot grams from the printer
      2. actual total scaled by planned per-slot ratios
      3. planned grams × final progress (Bambu without actual telemetry)
      4. planned grams for completed runs (no progress known)
      5. active slot / equal split fallbacks
    """
    job = _job_of(db, history)
    planned = _planned_grams(db, history, printer, job)
    planned_total = sum(planned.values()) if planned else None

    if printer.kind.value == "bambu":
        return _resolve_bambu(db, history, printer, result, planned, planned_total)
    return _resolve_moonraker(db, history, printer, result, planned, planned_total)


def _resolve_moonraker(
    db: "Session",
    history: "PrintHistory",
    printer: "Printer",
    result: str,
    planned: dict[int, float],
    planned_total: float | None,
) -> Consumption:
    from app.services import moonraker

    job = _job_of(db, history)
    actual_total: float | None = None
    if printer.moonraker_url:
        try:
            live = moonraker.get_live_status(printer.moonraker_url, org_id=printer.organization_id)
            used_mm = live.get("filament_used_mm")
            # Telemetry is only trustworthy while it still describes this run:
            # a printer that already started the next job resets print_stats.
            live_file = (live.get("filename") or "").rsplit("/", 1)[-1]
            own_file = (history.file_name or "").rsplit("/", 1)[-1]
            if live_file and own_file and live_file != own_file:
                used_mm = None
            if used_mm and used_mm > 0:
                diameters, densities = _planned_geometry(db, history, printer, job)
                diameter = diameters[0] if diameters else DEFAULT_DIAMETER_MM
                density = densities[0] if densities else DEFAULT_DENSITY_G_CM3
                actual_total = filament_grams(float(used_mm), diameter, density)
        except Exception:  # noqa: BLE001 — telemetry is best-effort
            actual_total = None

    if actual_total and planned:
        if len(planned) == 1:
            return Consumption(
                grams_by_slot={next(iter(planned)): actual_total},
                source=SOURCE_ACTUAL_PER_SLOT,
                actual_total_g=actual_total, planned_total_g=planned_total,
            )
        # Level 2: distribute the measured total across slots by planned ratio.
        scaled = {s: actual_total * g / planned_total for s, g in planned.items()}
        return Consumption(
            grams_by_slot=scaled,
            source=SOURCE_ACTUAL_TOTAL_SCALED,
            actual_total_g=actual_total, planned_total_g=planned_total,
        )
    if actual_total:
        # Level 5: usage is known but slot attribution is not — split evenly
        # across loaded spools and log the ambiguity (better than losing the
        # deduction entirely; the total on history stays exact).
        loaded = _loaded_slot_indexes(db, printer)
        if loaded:
            log.warning(
                "%s actual %.1fg on printer=%s split evenly across slots %s "
                "(no planned per-slot metadata)",
                DISCREPANCY_LOG_PREFIX, actual_total, printer.id, loaded,
            )
            per = actual_total / len(loaded)
            return Consumption(
                grams_by_slot={index: per for index in loaded},
                source=SOURCE_EQUAL_SPLIT,
                actual_total_g=actual_total, planned_total_g=planned_total,
            )
        return Consumption(
            grams_by_slot={},
            source=SOURCE_ACTUAL_TOTAL_SCALED,
            actual_total_g=actual_total, planned_total_g=planned_total,
        )
    # Level 4: completed runs consume the planned amount when no telemetry exists.
    if planned and planned_total and planned_total > 0 and result == "completed":
        return Consumption(
            grams_by_slot=dict(planned),
            source=SOURCE_PLANNED_COMPLETED,
            planned_total_g=planned_total,
        )
    return Consumption(planned_total_g=planned_total)


def _resolve_bambu(
    db: "Session",
    history: "PrintHistory",
    printer: "Printer",
    result: str,
    planned: dict[int, float],
    planned_total: float | None,
) -> Consumption:
    """Bambu exposes no reliable per-slot grams — use plan × final progress.

    ``BambuCloudJob.progress_pct`` (0..100, MQTT ``mc_percent``) is the last
    reliable progress observed before the run ended; completed runs use 100%.
    """
    job = _job_of(db, history)
    progress: float | None = None
    if result == "completed":
        progress = 1.0
    elif job is not None and job.progress_pct is not None:
        raw = float(job.progress_pct) / 100.0
        progress = min(max(raw, 0.0), 1.0)

    if planned and planned_total and planned_total > 0 and progress is not None:
        if progress >= 0.999:
            source = SOURCE_PLANNED_COMPLETED
            grams = dict(planned)
        else:
            source = SOURCE_PLANNED_PROGRESS
            grams = {s: g * progress for s, g in planned.items()}
        return Consumption(
            grams_by_slot=grams, source=source,
            planned_total_g=planned_total, progress_ratio=progress,
        )

    # No plan: no defensible gram estimate exists — nothing to deduct.
    return Consumption(progress_ratio=progress)


def apply_consumption(
    db: "Session",
    history: "PrintHistory",
    printer: "Printer",
    consumption: Consumption,
) -> AppliedConsumption:
    """Mutate inventory exactly once for this run. Caller owns the transaction.

    Idempotency keys: spool deduction and warehouse WRITE_OFF share the
    deterministic reason ``print_history:{id}:slot{n}``, so a re-finalization
    (tracker retry, cloud sync, replay) changes nothing.
    """
    from app.models.filament import Filament, FilamentLog
    from app.models.printer_slot import PrinterSlot

    applied = AppliedConsumption()
    plan_task_id = None
    job = _job_of(db, history)
    if job is not None:
        plan_task_id = (job.output_plan or {}).get("print_task_id")

    if not consumption.grams_by_slot:
        log.info(
            "print_accounting: no consumption resolved history=%s printer=%s kind=%s source=%s",
            history.id, printer.id, printer.kind.value, consumption.source,
        )
        return applied

    snapshot = (job.request_payload_json or {}).get("material_plan") if job else history.material_plan
    if snapshot is not None:
        spool_ids = {int(i): row.get("filament_id") for i, row in snapshot.items()}
    else:
        spool_ids = {slot.slot_index: slot.filament_id for slot in db.query(PrinterSlot).filter(
            PrinterSlot.printer_id == printer.id,
        ).all()}
    filament_ids = {fid for index, fid in spool_ids.items() if index in consumption.grams_by_slot and fid}
    filaments = {f.id: f for f in db.query(Filament).filter(
        Filament.id.in_(filament_ids), Filament.organization_id == history.organization_id,
    ).order_by(Filament.id).with_for_update().populate_existing().all()} if filament_ids else {}

    slots_used: list[dict] = []
    total_cost = Decimal("0")
    if history.slots_used:
        # Previous (partial) application of the same run — keep provenance.
        slots_used = [dict(s) for s in history.slots_used]

    for slot_index, grams in sorted(consumption.grams_by_slot.items()):
        filament = filaments.get(spool_ids.get(slot_index))
        grams = max(0.0, float(grams))
        if filament is None:
            slots_used.append({"slot_index": slot_index, "grams": round(grams, 1)})
            continue

        reason = _run_reason(history.id, slot_index)
        existing = db.query(FilamentLog).filter(
            FilamentLog.filament_id == filament.id, FilamentLog.reason == reason,
        ).first()
        if existing:
            log.info(
                "print_accounting: skip duplicate deduction history=%s slot=%s filament=%s",
                history.id, slot_index, filament.id,
            )
            continue

        deduct = max(0, int(round(grams)))
        prev_remaining = filament.grams_remaining
        new_remaining = max(0, prev_remaining - deduct)
        if deduct > prev_remaining:
            log.warning(
                "%s spool=%s used %sg but only %sg remained — recorded actual usage, book stock clamped to 0",
                DISCREPANCY_LOG_PREFIX, filament.id, deduct, prev_remaining,
            )
        if prev_remaining > filament.min_grams >= new_remaining:
            applied.low_filaments.append((filament, prev_remaining))
        filament.grams_remaining = new_remaining
        if new_remaining == 0:
            filament.status = "empty"
        db.add(FilamentLog(
            organization_id=filament.organization_id,
            filament_id=filament.id,
            delta_grams=-deduct,
            grams_after=new_remaining,
            reason=reason,
            task_id=plan_task_id,
        ))
        applied.total_grams += deduct

        write_off_warehouse_material(
            db, history.organization_id, filament, deduct, reason,
            user_id=history.created_by_user_id, print_history_id=history.id,
        )

        cost_per_kg = ((snapshot or {}).get(str(slot_index), {}).get("cost_per_kg") if snapshot is not None else filament.cost_per_kg) or 0
        total_cost += Decimal(str(round(grams, 3))) / Decimal("1000") * Decimal(str(cost_per_kg))
        slots_used.append({
            "slot_index": slot_index,
            "source": consumption.source,
            "filament_id": filament.id,
            "grams": round(grams, 1),
            "material": filament.material,
            "color": filament.color,
            "hex_color": filament.hex_color,
        })

    applied.cost = total_cost if total_cost > 0 else None
    history.slots_used = slots_used or None
    if applied.cost is not None:
        history.material_cost = applied.cost
    if applied.total_grams > 0:
        history.filament_g = applied.total_grams
    elif applied.total_grams == 0 and consumption.actual_total_g:
        # Usage measured but spool unknown — analytics keep the fact.
        history.filament_g = round(consumption.actual_total_g, 1)

    log.info(
        "print_accounting: finalized history=%s printer=%s kind=%s source=%s actual=%s planned=%s progress=%s "
        "grams=%.1f per_slot=%s filaments=%s",
        history.id, printer.id, printer.kind.value, consumption.source,
        round(consumption.actual_total_g, 1) if consumption.actual_total_g else None,
        round(consumption.planned_total_g, 1) if consumption.planned_total_g else None,
        consumption.progress_ratio,
        applied.total_grams,
        {s: round(g, 1) for s, g in consumption.grams_by_slot.items()},
        sorted(filament_ids),
    )
    return applied


def tracked_run_history_ids(db: "Session", org_id: int, task) -> list[int]:
    """Print-history ids of tracked runs associated with a task (by file and window)."""
    from app.models.print_history import PrintHistory

    if not task.file_name and task.gcode_file_id is None:
        return []
    q = db.query(PrintHistory.id).filter(
        PrintHistory.organization_id == org_id,
        PrintHistory.result != "in_progress",
    )
    if task.file_name:
        q = q.filter(PrintHistory.file_name == task.file_name)
    # Time window applies only when the task was actually started in the
    # system — tasks created after the fact must still find their runs.
    if task.started_at is not None:
        q = q.filter(PrintHistory.started_at >= task.started_at)
    return [row[0] for row in q.order_by(PrintHistory.id.desc()).limit(500).all()]


def task_tracked_consumption(db: "Session", org_id: int, task) -> dict[int, int]:
    """Actual grams already deducted per filament by tracked runs of a task.

    Primary: run-level deductions carry ``FilamentLog.task_id`` from the
    dispatch plan. Fallback for older runs: run-reason logs matched to the
    task's file and time window.
    """
    from app.models.filament import FilamentLog

    sums: dict[int, int] = {}
    linked = db.query(FilamentLog).filter(
        FilamentLog.organization_id == org_id,
        FilamentLog.task_id == task.id,
        FilamentLog.delta_grams < 0,
    )
    for entry in linked:
        if _RUN_REASON_PATTERN.match(entry.reason or ""):
            sums[entry.filament_id] = sums.get(entry.filament_id, 0) + (-entry.delta_grams)
    if sums:
        return sums

    history_ids = set(tracked_run_history_ids(db, org_id, task))
    if not history_ids:
        return {}
    logs = db.query(FilamentLog).filter(
        FilamentLog.organization_id == org_id,
        FilamentLog.delta_grams < 0,
        FilamentLog.task_id.is_(None),
    ).all()
    for entry in logs:
        match = _RUN_REASON_PATTERN.match(entry.reason or "")
        if not match or int(match.group(1)) not in history_ids:
            continue
        sums[entry.filament_id] = sums.get(entry.filament_id, 0) + (-entry.delta_grams)
    return sums
