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

    _scheduler.start()
    log.info("Scheduler started (timezone=%s)", settings.TIMEZONE)


def shutdown() -> None:
    global _scheduler
    if _scheduler is None:
        return
    _scheduler.shutdown(wait=False)
    _scheduler = None
