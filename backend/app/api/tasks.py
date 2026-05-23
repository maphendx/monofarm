from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, get_current_user, require_roles
from app.core.db import get_db
from app.models.organization import Organization
from app.models.task import PrintTask, PrintTaskStatus
from app.models.user import User, UserRole
from app.schemas.task import PrintTaskCreate, PrintTaskOut, PrintTaskUpdate
from app.services.gcode_meta import parse_gcode


# Files live under data/uploads/<task_id>/<original_filename>
UPLOADS_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "uploads"
ALLOWED_EXTS = {".gcode", ".gco", ".g", ".3mf", ".bgcode"}
MAX_FILE_BYTES = 200 * 1024 * 1024  # 200 MB


router = APIRouter(prefix="/tasks/print", tags=["tasks"])


@router.get("", response_model=list[PrintTaskOut])
def list_tasks(
    status: PrintTaskStatus | None = None,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[PrintTask]:
    q = db.query(PrintTask).filter(PrintTask.organization_id == org.id)
    if status:
        q = q.filter(PrintTask.status == status)
    else:
        q = q.filter(PrintTask.status.notin_([PrintTaskStatus.cancelled]))
    return q.order_by(PrintTask.deadline.asc().nullslast(), PrintTask.created_at).all()


@router.post("", response_model=PrintTaskOut, status_code=status.HTTP_201_CREATED)
def create_task(
    payload: PrintTaskCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(UserRole.admin, UserRole.operator, UserRole.manager)),
    org: Organization = Depends(get_current_org),
) -> PrintTask:
    task = PrintTask(**payload.model_dump(), created_by_id=user.id, organization_id=org.id)
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


@router.patch("/{task_id}", response_model=PrintTaskOut)
def update_task(
    task_id: int,
    payload: PrintTaskUpdate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator, UserRole.manager)),
) -> PrintTask:
    task = db.query(PrintTask).filter(PrintTask.id == task_id, PrintTask.organization_id == org.id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    for field, val in payload.model_dump(exclude_none=True).items():
        setattr(task, field, val)
    db.commit()
    db.refresh(task)
    return task


@router.delete("/{task_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_task(
    task_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> None:
    task = db.query(PrintTask).filter(PrintTask.id == task_id, PrintTask.organization_id == org.id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    _delete_task_file(task)
    db.delete(task)
    db.commit()


# ── file attachment ─────────────────────────────────────────────────────────

def _task_dir(task_id: int) -> Path:
    return UPLOADS_DIR / str(task_id)


def _safe_filename(name: str) -> str:
    name = Path(name).name  # strip any path
    return name.replace("/", "_").replace("\\", "_").replace("\x00", "")


def _delete_task_file(task: PrintTask) -> None:
    if not task.file_ref:
        return
    p = _task_dir(task.id) / task.file_ref
    if p.exists():
        p.unlink(missing_ok=True)
    d = _task_dir(task.id)
    if d.exists() and not any(d.iterdir()):
        d.rmdir()


@router.post("/{task_id}/file", response_model=PrintTaskOut)
async def upload_task_file(
    task_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator, UserRole.manager)),
) -> PrintTask:
    task = db.query(PrintTask).filter(PrintTask.id == task_id, PrintTask.organization_id == org.id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    fname = _safe_filename(file.filename or "upload.bin")
    ext = Path(fname).suffix.lower()
    if ext not in ALLOWED_EXTS:
        raise HTTPException(
            status_code=400,
            detail=f"Дозволені формати: {', '.join(sorted(ALLOWED_EXTS))}",
        )

    _delete_task_file(task)

    target_dir = _task_dir(task_id)
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / fname

    written = 0
    with target_path.open("wb") as out:
        while chunk := await file.read(1024 * 1024):
            written += len(chunk)
            if written > MAX_FILE_BYTES:
                out.close()
                target_path.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail="Файл занадто великий (макс. 200 МБ)")
            out.write(chunk)

    task.file_ref = fname
    task.file_name = fname
    task.file_size = written

    try:
        meta = parse_gcode(target_path)
        if meta:
            task.filament_meta = meta
            if not task.estimated_minutes and meta.get("estimated_minutes"):
                task.estimated_minutes = meta["estimated_minutes"]
    except Exception:  # noqa: BLE001
        pass

    db.commit()
    db.refresh(task)
    return task


@router.get("/{task_id}/file")
def download_task_file(
    task_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> FileResponse:
    task = db.query(PrintTask).filter(PrintTask.id == task_id, PrintTask.organization_id == org.id).first()
    if not task or not task.file_ref:
        raise HTTPException(status_code=404, detail="Файл не знайдено")
    path = _task_dir(task_id) / task.file_ref
    if not path.exists():
        raise HTTPException(status_code=404, detail="Файл не знайдено на диску")
    return FileResponse(path, filename=task.file_name or task.file_ref)


@router.delete("/{task_id}/file", response_model=PrintTaskOut)
def delete_task_file(
    task_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> PrintTask:
    task = db.query(PrintTask).filter(PrintTask.id == task_id, PrintTask.organization_id == org.id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    _delete_task_file(task)
    task.file_ref = None
    task.file_name = None
    task.file_size = None
    task.filament_meta = None
    db.commit()
    db.refresh(task)
    return task
