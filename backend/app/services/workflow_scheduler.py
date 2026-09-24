"""Cron triggers for workflows — synced into the shared APScheduler.

API processes may have no scheduler (production splits web / worker); sync
calls there are no-ops and the leader re-syncs everything on scheduler start.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from apscheduler.triggers.cron import CronTrigger

from app.core.config import settings
from app.core.db import SessionLocal
from app.models.workflow import Workflow

log = logging.getLogger(__name__)

JOB_PREFIX = "workflow_cron_"


def _scheduler():
    from app.services import scheduler as scheduler_module

    return scheduler_module.get_scheduler()


def sync_workflow_jobs(workflow: Workflow) -> None:
    """Add/remove cron jobs for one workflow in the current process."""
    sched = _scheduler()
    if sched is None:
        return
    cron_nodes = [
        node
        for node in (workflow.graph or {}).get("nodes", [])
        if node.get("type") == "trigger.cron"
    ]
    for node in cron_nodes:
        job_id = f"{JOB_PREFIX}{workflow.id}_{node.get('key')}"
        existing = sched.get_job(job_id)
        if not workflow.enabled:
            if existing is not None:
                sched.remove_job(job_id)
            continue
        expr = str((node.get("config") or {}).get("cron") or "").strip()
        try:
            trigger = CronTrigger.from_crontab(expr, timezone=ZoneInfo(settings.TIMEZONE))
        except (ValueError, TypeError):
            log.warning("workflow %s: bad cron expression %r — trigger skipped", workflow.id, expr)
            continue
        sched.add_job(
            fire_cron,
            trigger,
            id=job_id,
            replace_existing=True,
            kwargs={"workflow_id": workflow.id, "node_key": node.get("key")},
        )
    # remove stale jobs of deleted cron nodes
    valid_ids = {f"{JOB_PREFIX}{workflow.id}_{n.get('key')}" for n in cron_nodes}
    for job in sched.get_jobs():
        if job.id.startswith(f"{JOB_PREFIX}{workflow.id}_") and job.id not in valid_ids:
            sched.remove_job(job.id)


def remove_workflow_jobs(workflow_id: int) -> None:
    sched = _scheduler()
    if sched is None:
        return
    prefix = f"{JOB_PREFIX}{workflow_id}_"
    for job in list(sched.get_jobs()):
        if job.id.startswith(prefix):
            sched.remove_job(job.id)


def sync_all_jobs() -> None:
    """Re-sync cron jobs for every enabled workflow (called on scheduler start)."""
    with SessionLocal() as db:
        workflows = db.query(Workflow).filter(Workflow.enabled.is_(True)).all()
        for workflow in workflows:
            sync_workflow_jobs(workflow)


def fire_cron(workflow_id: int, node_key: str) -> None:
    """Create a pending run for a cron firing (runs inside the scheduler process)."""
    from app.services.workflow_engine import create_run

    try:
        with SessionLocal() as db:
            workflow = db.get(Workflow, workflow_id)
            if workflow is None or not workflow.enabled:
                return
            create_run(
                db,
                workflow,
                "schedule.cron",
                {"fired_at": datetime.now(timezone.utc).isoformat()},
                fired_node_key=node_key,
            )
            db.commit()
            log.info("workflow cron fired: workflow=%s node=%s", workflow_id, node_key)
    except Exception:
        log.exception("workflow cron fire failed: workflow=%s", workflow_id)
