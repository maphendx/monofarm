"""APScheduler — periodic jobs inside FastAPI's event loop."""
import logging
from zoneinfo import ZoneInfo

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from app.core.config import settings
from app.services.daily_report import send_daily_plan_to_all


log = logging.getLogger(__name__)

_scheduler: AsyncIOScheduler | None = None


def get_scheduler() -> AsyncIOScheduler | None:
    """The process-local scheduler, or None in API-only processes."""
    return _scheduler


def start() -> None:
    global _scheduler
    if _scheduler is not None:
        return
    tz = ZoneInfo(settings.TIMEZONE)
    _scheduler = AsyncIOScheduler(timezone=tz)
    _scheduler.add_job(
        send_daily_plan_to_all,
        CronTrigger(hour=9, minute=0, timezone=tz),
        id="daily_plan_09",
        replace_existing=True,
    )

    # Bambu Cloud token refresh every 6 hours
    from app.services.bambu import do_token_refresh
    _scheduler.add_job(
        do_token_refresh,
        IntervalTrigger(hours=6),
        id="bambu_token_refresh",
        replace_existing=True,
    )

    # Print state transition tracker — opens/closes PrintHistory entries
    from app.services.print_tracker import check_transitions
    _scheduler.add_job(
        check_transitions,
        IntervalTrigger(seconds=30),
        id="print_tracker",
        replace_existing=True,
    )

    # Bambu Cloud job worker — dispatches queued cloud jobs off the API thread.
    from app.workers.bambu_jobs import process_pending_bambu_cloud_jobs
    _scheduler.add_job(
        process_pending_bambu_cloud_jobs,
        IntervalTrigger(seconds=5),
        id="bambu_cloud_jobs",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
    )
    from app.workers.bambu_jobs import process_lost_bambu_cloud_jobs
    _scheduler.add_job(
        process_lost_bambu_cloud_jobs,
        IntervalTrigger(minutes=1),
        id="bambu_cloud_lost_jobs",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
    )

    from app.services import horoshop
    from app.workers.horoshop_sync import process_auto_horoshop_sync
    _scheduler.add_job(
        process_auto_horoshop_sync,
        IntervalTrigger(minutes=horoshop.AUTO_SYNC_INTERVAL_MINUTES),
        id="horoshop_auto_sync",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
    )

    # Ready-made Telegram delivery is independent of workflow execution.
    from app.services.telegram_notify import process_pending_notifications
    _scheduler.add_job(
        process_pending_notifications, IntervalTrigger(seconds=5),
        id="telegram_notifications", replace_existing=True, max_instances=1, coalesce=True,
    )

    # Workflow engine — execute queued runs, resume waits, sync cron triggers
    from app.workers.workflow_runs import process_pending_workflow_runs, resume_waiting_workflow_runs
    from app.services import workflow_scheduler as wf_sched
    _scheduler.add_job(
        process_pending_workflow_runs,
        IntervalTrigger(seconds=5),
        id="workflow_runs",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
    )
    _scheduler.add_job(
        resume_waiting_workflow_runs,
        IntervalTrigger(seconds=15),
        id="workflow_waiting",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
    )
    try:
        wf_sched.sync_all_jobs()
    except Exception:
        log.exception("workflow cron trigger sync failed")

    _scheduler.start()
    log.info("Scheduler started (timezone=%s)", settings.TIMEZONE)


def shutdown() -> None:
    global _scheduler
    if _scheduler is None:
        return
    _scheduler.shutdown(wait=False)
    _scheduler = None
