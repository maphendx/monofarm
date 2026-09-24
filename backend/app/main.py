import asyncio
import io
import json
import logging
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, RedirectResponse, Response
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app.api.agent import router as agent_router
from app.api.agent_tg import router as agent_tg_router
from app.api.admin import router as admin_router
from app.api.api_keys import router as api_keys_router
from app.api.billing import router as billing_router
from app.api.analytics import router as analytics_router
from app.api.history import router as history_router
from app.api.horoshop import router as horoshop_router
from app.api.auth import router as auth_router
from app.api.bambu_jobs import router as bambu_jobs_router
from app.api.deps import get_current_admin
from app.api.farm_tasks import router as farm_tasks_router
from app.api.filament_colors import router as filament_colors_router
from app.api.filament_labels import router as filament_labels_router
from app.api.filaments import router as filaments_router
from app.api.files import router as files_router
from app.api.files import folders_router as folders_router
from app.api.octoprint import moonraker_router, orca_router, router as octoprint_router
from app.api.orgs import router as orgs_router
from app.api.plan import router as plan_router
from app.api.printer_groups import router as printer_groups_router
from app.api.printers import router as printers_router
from app.api.slots import router as slots_router
from app.api.tasks import router as tasks_router
from app.api.users import router as users_router, roles_router
from app.api.warehouse import router as warehouse_router
from app.api.keycrm import router as keycrm_router
from app.api.workflows import router as workflows_router
from app.api.search import router as search_router
from app.api.tags import router as tags_router
from app.api.ws import router as ws_router
from app.core.config import settings
from app.core.ratelimit import limiter
from app.core.db import SessionLocal
from app.models.organization import Organization
from app.services import bambu, scheduler
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
    from app.services import tunnel
    await tunnel.start_router()
    try:
        with SessionLocal() as db:
            seed_admin(db)
    except Exception:
        log.exception("seed_admin failed — continuing startup")

    if settings.INLINE_WORKERS:
        import os
        if os.environ.get("WEB_CONCURRENCY", "1") not in ("", "1"):
            log.warning(
                "INLINE_WORKERS=true with WEB_CONCURRENCY>1 — multiple schedulers will run! "
                "Set INLINE_WORKERS=false and use a separate worker process instead."
            )
        try:
            scheduler.start()
        except Exception:
            log.exception("Failed to start scheduler")

        try:
            with SessionLocal() as db:
                orgs = db.query(Organization).all()
            for org in orgs:
                await bambu.init(org)
        except Exception:
            log.exception("Failed to start Bambu MQTT")
    else:
        log.info("INLINE_WORKERS=false — Telegram/Scheduler/Bambu run in separate worker process")

    # AutoPrint kicks from cloud MQTT arrive over Redis pub/sub. Dispatch can
    # now reach an agent owned by any web process through the tunnel router.
    from app.services.autoprint import run_kick_listener
    autoprint_kick_task = asyncio.create_task(run_kick_listener())
    from app.api.ws import run_printer_event_listener
    printer_event_task = asyncio.create_task(run_printer_event_listener())

    log.info("monofarm api started")
    try:
        yield
    finally:
        await tunnel.stop_router()
        autoprint_kick_task.cancel()
        printer_event_task.cancel()
        if settings.INLINE_WORKERS:
            try:
                await bambu.shutdown()
            except Exception:
                log.exception("Bambu MQTT shutdown failed (all orgs)")
            scheduler.shutdown()


app = FastAPI(title="Printfarm API", version="0.1.0", lifespan=lifespan)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=1024)


@app.middleware("http")
async def private_response_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Content-Type-Options"] = "nosniff"
    if request.url.path.startswith("/api/") or request.headers.get("authorization") or request.headers.get("x-api-key"):
        response.headers["Cache-Control"] = "no-store"
    return response


def _frontend_url(path: str = "") -> str:
    base = settings.FARM_PUBLIC_URL.rstrip("/")
    for prefix in ("https://api.", "http://api."):
        if base.startswith(prefix):
            base = base.replace(prefix, prefix[:prefix.index("api.")], 1)
            break
    return f"{base}{path}"


@app.get("/", include_in_schema=False)
def root_redirect(request: Request):
    from urllib.parse import unquote

    next_url = request.cookies.get("monofarm_slicer_next")
    target = unquote(next_url) if next_url else _frontend_url("/files?slicer=latest")
    if not target.startswith(_frontend_url("/")):
        target = _frontend_url("/files?slicer=latest")
    response = RedirectResponse(target)
    if next_url:
        response.delete_cookie("monofarm_slicer_next", path="/")
    return response


@app.get("/api/health")
async def health() -> dict:
    return {"ok": True}


@app.post("/api/internal/send-plan-now")
async def send_plan_now(
    _admin=Depends(get_current_admin),
) -> dict:
    """Force-send today's plan to all linked Telegram users (test-only)."""
    from app.services.daily_report import send_daily_plan_to_all
    await send_daily_plan_to_all()
    return {"ok": True}


_AGENT_DIR = Path(__file__).parent.parent / "agent"
if not _AGENT_DIR.exists():
    _AGENT_DIR = Path(__file__).parent.parent.parent / "agent"
_AGENT_FILES = {"monofarm_agent.py", "monofarm_tray.py", "install.sh", "install.ps1", "Dockerfile", "requirements.txt", "bambu_camera_test.py"}


@app.get("/agent/monofarm-agent.exe")
async def serve_agent_exe() -> RedirectResponse:
    """Redirect to the latest agent .exe in object storage (uploaded by CI).

    The binary lives in R2 — never committed to the repo or baked into the Docker
    image. Frozen agents (self-update) and the Windows installer pull from this
    stable URL, which 302-redirects to a short-lived presigned download.
    Declared before /agent/{filename} so it takes routing priority.
    """
    from app.services import storage
    url = storage.presigned_url_raw("agent/monofarm-agent.exe")
    if not url:
        raise HTTPException(status_code=404)
    return RedirectResponse(url, status_code=302)


@app.get("/agent/source.zip")
async def serve_agent_source() -> Response:
    """Return one complete, version-consistent source-agent bundle."""
    manifest_path = _AGENT_DIR / "source_manifest.json"
    if not manifest_path.exists():
        raise HTTPException(status_code=404)
    source_files = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(source_files, list) or not source_files:
        raise HTTPException(status_code=500, detail="Invalid agent source manifest")

    archive_buffer = io.BytesIO()
    with zipfile.ZipFile(
        archive_buffer,
        mode="w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=9,
    ) as archive:
        for relative_name in source_files:
            if not isinstance(relative_name, str):
                raise HTTPException(status_code=500, detail="Invalid agent source manifest")
            relative_path = Path(relative_name)
            if relative_path.is_absolute() or ".." in relative_path.parts:
                raise HTTPException(status_code=500, detail="Invalid agent source manifest")
            source_path = _AGENT_DIR / relative_path
            if not source_path.is_file():
                raise HTTPException(status_code=500, detail=f"Missing agent source: {relative_name}")
            archive.writestr(relative_name, source_path.read_bytes())

    return Response(
        content=archive_buffer.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="monofarm-agent-source.zip"'},
    )


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
app.include_router(bambu_jobs_router, prefix="/api")
app.include_router(admin_router, prefix="/api")
app.include_router(orgs_router, prefix="/api")
app.include_router(users_router, prefix="/api")
app.include_router(roles_router, prefix="/api")
app.include_router(api_keys_router, prefix="/api")
app.include_router(printer_groups_router, prefix="/api")
app.include_router(printers_router, prefix="/api")
app.include_router(slots_router, prefix="/api")
app.include_router(tasks_router, prefix="/api")
app.include_router(farm_tasks_router, prefix="/api")
app.include_router(filament_labels_router, prefix="/api")
app.include_router(filaments_router, prefix="/api")
app.include_router(filament_colors_router, prefix="/api")
app.include_router(files_router, prefix="/api")
app.include_router(folders_router, prefix="/api")
app.include_router(octoprint_router)  # no prefix — OctoPrint paths are already /api/...
app.include_router(orca_router)       # printer-scoped: /orca/{printer_id}/api/...
app.include_router(moonraker_router)  # Moonraker shim: /server/files/upload
app.include_router(plan_router, prefix="/api")
app.include_router(agent_router)      # WebSocket + status endpoint
app.include_router(agent_tg_router)   # Telegram bot data endpoints for local agent

app.include_router(analytics_router, prefix="/api")
app.include_router(history_router, prefix="/api")
app.include_router(billing_router)
app.include_router(warehouse_router, prefix="/api")
app.include_router(keycrm_router, prefix="/api")
app.include_router(workflows_router, prefix="/api")
app.include_router(horoshop_router, prefix="/api")
app.include_router(search_router, prefix="/api")
app.include_router(tags_router, prefix="/api")
app.include_router(ws_router)
