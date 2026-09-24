"""Workflow run processing — claims pending runs and executes them.

Runs in the scheduler-enabled process (worker leader in production, web
process when INLINE_WORKERS=true). Pending runs are durable: a crashed
execution leaves the row in ``running``/``pending`` and the poll retries it —
node handlers must tolerate re-invocation (dispatch nodes use idempotency keys).
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from app.core.db import SessionLocal
from app.models.workflow import WorkflowRun, WorkflowRunStatus
from app.services import workflow_engine

log = logging.getLogger(__name__)

BATCH_SIZE = 10


async def process_pending_workflow_runs(limit: int = BATCH_SIZE) -> int:
    """Claim and execute up to ``limit`` pending runs. Returns executed count."""
    with SessionLocal() as db:
        rows = (
            db.query(WorkflowRun.id)
            .filter(WorkflowRun.status == WorkflowRunStatus.pending)
            .order_by(WorkflowRun.id)
            .limit(limit)
            .all()
        )
        run_ids = [row[0] for row in rows]

    executed = 0
    for run_id in run_ids:
        try:
            with SessionLocal() as db:
                run = db.get(WorkflowRun, run_id)
                if run is None or run.status != WorkflowRunStatus.pending:
                    continue
                await workflow_engine.execute_run(db, run)
                executed += 1
        except Exception:
            log.exception("workflow run %s crashed", run_id)
            with SessionLocal() as db:
                run = db.get(WorkflowRun, run_id)
                if run is not None and run.status not in (
                    WorkflowRunStatus.success,
                    WorkflowRunStatus.failed,
                    WorkflowRunStatus.stopped,
                ):
                    run.status = WorkflowRunStatus.failed
                    run.error = "Внутрішня помилка виконання — дивіться логи сервера"
                    run.finished_at = datetime.now(timezone.utc)
                    db.commit()
    return executed


async def resume_waiting_workflow_runs() -> int:
    """Continue waiting runs whose wake time has arrived."""
    with SessionLocal() as db:
        try:
            return await workflow_engine.resume_due_waiting_runs(db)
        except Exception:
            log.exception("workflow waiting resume failed")
            return 0
