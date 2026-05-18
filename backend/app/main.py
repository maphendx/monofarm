import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from app.api.agent import router as agent_router
from app.api.api_keys import router as api_keys_router
from app.api.billing import router as billing_router
from app.api.analytics import router as analytics_router
from app.api.history import router as history_router
from app.api.auth import router as auth_router
from app.api.deps import require_roles
from app.api.farm_tasks import router as farm_tasks_router
from app.api.filament_colors import router as filament_colors_router
from app.api.filaments import router as filaments_router
from app.api.files import router as files_router
from app.api.octoprint import router as octoprint_router
from app.api.orgs import router as orgs_router
from app.api.plan import router as plan_router
from app.api.printer_groups import router as printer_groups_router
from app.api.printers import router as printers_router
from app.api.tasks import router as tasks_router
from app.api.users import router as users_router
from app.core.config import settings
from app.core.db import SessionLocal
from app.models.organization import Organization
from app.models.user import UserRole
from app.services import bambu, scheduler, telegram_bot
from app.services.bootstrap import seed_admin


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
# Quiet down chatty third-party loggers (httpx logs every Telegram getUpdates poll, with the
# bot token in the URL — both noisy and a security smell).
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logging.getLogger("apscheduler").setLevel(logging.WARNING)
log = logging.getLogger("monofarm")


@asynccontextmanager
async def lifespan(_: FastAPI):
    with SessionLocal() as db:
        seed_admin(db)

    if settings.INLINE_WORKERS:
        try:
            await telegram_bot.init()
            scheduler.start()
        except Exception:
            log.exception("Failed to start telegram bot / scheduler")

        try:
            with SessionLocal() as db:
                orgs = db.query(Organization).all()
            for org in orgs:
                await bambu.init(org)
        except Exception:
            log.exception("Failed to start Bambu MQTT")
    else:
        log.info("INLINE_WORKERS=false — Telegram/Scheduler/Bambu run in separate worker process")

    log.info("monofarm api started")
    yield

    if settings.INLINE_WORKERS:
        try:
            await bambu.shutdown()
        except Exception:
            log.exception("Bambu MQTT shutdown failed (all orgs)")
        scheduler.shutdown()
        try:
            await telegram_bot.shutdown()
        except Exception:
            log.exception("Telegram bot shutdown failed")


app = FastAPI(title="Printfarm API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.post("/api/internal/send-plan-now")
async def send_plan_now(
    _admin=Depends(require_roles(UserRole.admin)),
) -> dict:
    """Force-send today's plan to all linked Telegram users (test-only)."""
    from app.services.daily_report import send_daily_plan_to_all
    await send_daily_plan_to_all()
    return {"ok": True}


_AGENT_DIR = Path(__file__).parent.parent.parent / "agent"
_AGENT_FILES = {"monofarm_agent.py", "monofarm_tray.py", "install.sh", "install.ps1", "Dockerfile", "requirements.txt", "bambu_camera_test.py"}


@app.get("/agent/{filename}")
async def serve_agent_file(filename: str) -> FileResponse:
    if filename not in _AGENT_FILES:
        raise HTTPException(status_code=404)
    path = _AGENT_DIR / filename
    if not path.exists():
        raise HTTPException(status_code=404)
    media_type = "text/x-shellscript" if filename.endswith(".sh") else "text/plain"
    return FileResponse(path, media_type=media_type)


app.include_router(auth_router, prefix="/api")
app.include_router(orgs_router, prefix="/api")
app.include_router(users_router, prefix="/api")
app.include_router(api_keys_router, prefix="/api")
app.include_router(printer_groups_router, prefix="/api")
app.include_router(printers_router, prefix="/api")
app.include_router(tasks_router, prefix="/api")
app.include_router(farm_tasks_router, prefix="/api")
app.include_router(filaments_router, prefix="/api")
app.include_router(filament_colors_router, prefix="/api")
app.include_router(files_router, prefix="/api")
app.include_router(octoprint_router)  # no prefix — OctoPrint paths are already /api/...
app.include_router(plan_router, prefix="/api")
app.include_router(agent_router)   # WebSocket + status endpoint

app.include_router(analytics_router, prefix="/api")
app.include_router(history_router, prefix="/api")
app.include_router(billing_router)
