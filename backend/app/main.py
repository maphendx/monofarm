import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.auth import router as auth_router
from app.api.farm_tasks import router as farm_tasks_router
from app.api.filaments import router as filaments_router
from app.api.plan import router as plan_router
from app.api.printers import router as printers_router
from app.api.tasks import router as tasks_router
from app.api.users import router as users_router
from app.core.config import settings
from app.core.db import SessionLocal
from app.services import scheduler, telegram_bot
from app.services.bootstrap import seed_admin


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("printfarm")


@asynccontextmanager
async def lifespan(_: FastAPI):
    with SessionLocal() as db:
        seed_admin(db)

    try:
        await telegram_bot.init()
        scheduler.start()
    except Exception:
        log.exception("Failed to start telegram bot / scheduler")

    log.info("printfarm api started")
    yield

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


app.include_router(auth_router, prefix="/api")
app.include_router(users_router, prefix="/api")
app.include_router(printers_router, prefix="/api")
app.include_router(tasks_router, prefix="/api")
app.include_router(farm_tasks_router, prefix="/api")
app.include_router(filaments_router, prefix="/api")
app.include_router(plan_router, prefix="/api")
