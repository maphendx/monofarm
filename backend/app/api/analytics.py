from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.api.deps import get_current_org
from app.core.db import get_db
from app.models.organization import Organization
from app.models.plan import PlanEntry
from app.models.printer import Printer
from app.models.task import PrintTask, PrintTaskStatus

router = APIRouter(prefix="/analytics", tags=["analytics"])


# ── summary ──────────────────────────────────────────────────────────────────

@router.get("/summary")
def summary(
    org: Organization = Depends(get_current_org),
    db: Session = Depends(get_db),
) -> dict:
    task_counts: dict[str, int] = {}
    for status in PrintTaskStatus:
        task_counts[status.value] = (
            db.query(func.count(PrintTask.id))
            .filter(PrintTask.organization_id == org.id, PrintTask.status == status)
            .scalar() or 0
        )

    done_entries = (
        db.query(PlanEntry)
        .join(PrintTask, PlanEntry.task_id == PrintTask.id)
        .filter(PlanEntry.organization_id == org.id, PlanEntry.done.is_(True))
        .all()
    )

    total_minutes = 0
    total_filament_g = 0.0
    for entry in done_entries:
        task = db.get(PrintTask, entry.task_id)
        if task:
            if task.estimated_minutes:
                total_minutes += task.estimated_minutes * (task.quantity or 1)
            if task.filament_meta and task.filament_meta.get("used_g"):
                total_filament_g += sum(task.filament_meta["used_g"]) * (task.quantity or 1)

    active_printers = (
        db.query(func.count(Printer.id))
        .filter(Printer.organization_id == org.id, Printer.is_active.is_(True))
        .scalar() or 0
    )

    completed_tasks = (
        db.query(PrintTask)
        .filter(PrintTask.organization_id == org.id, PrintTask.status == PrintTaskStatus.done)
        .all()
    )
    total_material_cost_uah = sum(t.material_cost_uah or 0 for t in completed_tasks)
    total_pieces_ok = sum(t.pieces_ok or 0 for t in completed_tasks)
    total_pieces_defective = sum(t.pieces_defective or 0 for t in completed_tasks)
    total_pieces = total_pieces_ok + total_pieces_defective
    defect_rate_pct = round(total_pieces_defective / total_pieces * 100, 1) if total_pieces else 0.0

    return {
        "tasks": task_counts,
        "plan_entries_done": len(done_entries),
        "total_print_minutes": total_minutes,
        "total_filament_g": round(total_filament_g, 1),
        "active_printers": active_printers,
        "total_material_cost_uah": round(total_material_cost_uah, 2),
        "total_pieces_ok": total_pieces_ok,
        "total_pieces_defective": total_pieces_defective,
        "defect_rate_pct": defect_rate_pct,
    }


# ── daily (last N days) ───────────────────────────────────────────────────────

@router.get("/daily")
def daily(
    days: int = 30,
    org: Organization = Depends(get_current_org),
    db: Session = Depends(get_db),
) -> list[dict]:
    days = min(max(days, 7), 90)
    since = date.today() - timedelta(days=days - 1)

    rows = (
        db.query(PlanEntry.plan_date, func.count(PlanEntry.id))
        .filter(
            PlanEntry.organization_id == org.id,
            PlanEntry.done.is_(True),
            PlanEntry.plan_date >= since,
        )
        .group_by(PlanEntry.plan_date)
        .all()
    )
    by_date = {r[0]: r[1] for r in rows}

    result = []
    for i in range(days):
        d = since + timedelta(days=i)
        result.append({"date": d.isoformat(), "done": by_date.get(d, 0)})
    return result


# ── per-printer stats ─────────────────────────────────────────────────────────

@router.get("/printers")
def printer_stats(
    org: Organization = Depends(get_current_org),
    db: Session = Depends(get_db),
) -> list[dict]:
    printers = (
        db.query(Printer)
        .filter(Printer.organization_id == org.id, Printer.is_active.is_(True))
        .all()
    )

    result = []
    for p in printers:
        total = (
            db.query(func.count(PlanEntry.id))
            .filter(PlanEntry.organization_id == org.id, PlanEntry.printer_id == p.id)
            .scalar() or 0
        )
        done = (
            db.query(func.count(PlanEntry.id))
            .filter(
                PlanEntry.organization_id == org.id,
                PlanEntry.printer_id == p.id,
                PlanEntry.done.is_(True),
            )
            .scalar() or 0
        )
        # sum estimated minutes for done entries
        done_entries = (
            db.query(PlanEntry)
            .filter(
                PlanEntry.organization_id == org.id,
                PlanEntry.printer_id == p.id,
                PlanEntry.done.is_(True),
            )
            .all()
        )
        minutes = 0
        for entry in done_entries:
            task = db.get(PrintTask, entry.task_id)
            if task and task.estimated_minutes:
                minutes += task.estimated_minutes * (task.quantity or 1)

        result.append({
            "id": p.id,
            "name": p.name,
            "kind": p.kind.value,
            "total_entries": total,
            "done_entries": done,
            "estimated_minutes_done": minutes,
        })

    result.sort(key=lambda x: x["done_entries"], reverse=True)
    return result


# ── filament usage ────────────────────────────────────────────────────────────

@router.get("/filament-usage")
def filament_usage(
    org: Organization = Depends(get_current_org),
    db: Session = Depends(get_db),
) -> dict:
    done_entries = (
        db.query(PlanEntry)
        .filter(PlanEntry.organization_id == org.id, PlanEntry.done.is_(True))
        .all()
    )

    by_material: dict[str, float] = defaultdict(float)
    for entry in done_entries:
        task = db.get(PrintTask, entry.task_id)
        if not task or not task.filament_meta:
            continue
        meta = task.filament_meta
        types = meta.get("types") or []
        used = meta.get("used_g") or []
        qty = task.quantity or 1
        for i, g in enumerate(used):
            material = types[i] if i < len(types) else "Unknown"
            by_material[material] += g * qty

    return {
        "by_material": [
            {"material": k, "grams": round(v, 1)}
            for k, v in sorted(by_material.items(), key=lambda x: -x[1])
        ]
    }
