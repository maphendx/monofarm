"""Printer/group targeting for print-queue items.

Layered on top of the existing file-type + loaded-filament compatibility
checks in `app.api.tasks` and the tag matching in `app.api.tags` — this is
the single source of truth for "does this task's explicit targeting allow
this printer", reused by bulk-distribute, the compat endpoint, and the
tag-matching endpoint so the three never drift apart.
"""
from __future__ import annotations

from app.models.printer import Printer
from app.models.task import PrintTask


def target_reasons(task: PrintTask, printer: Printer) -> list[str]:
    """Reasons `printer` is excluded by the task's explicit group/printer targeting.

    Empty list = printer is within the task's target scope (or the task has
    no targeting set, in which case any printer qualifies).
    """
    reasons: list[str] = []
    if task.assigned_group_id is not None and printer.group_id != task.assigned_group_id:
        reasons.append("не в цільовій групі")
    if task.target_printer_ids and printer.id not in task.target_printer_ids:
        reasons.append("не в списку цільових принтерів")
    return reasons


def is_eligible(task: PrintTask, printer: Printer) -> bool:
    return not target_reasons(task, printer)
