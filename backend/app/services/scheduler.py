"""APScheduler — runs the 09:00 daily plan job inside FastAPI's event loop."""
import logging
from zoneinfo import ZoneInfo

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

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
    _scheduler.start()
    log.info("Scheduler started (timezone=%s)", settings.TIMEZONE)


def shutdown() -> None:
    global _scheduler
    if _scheduler is None:
        return
    _scheduler.shutdown(wait=False)
    _scheduler = None
