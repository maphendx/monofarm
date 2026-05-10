from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_roles
from app.core.db import get_db
from app.models.task import PrintTask, PrintTaskStatus
from app.models.user import User, UserRole
from app.schemas.task import PrintTaskCreate, PrintTaskOut, PrintTaskUpdate


router = APIRouter(prefix="/tasks/print", tags=["tasks"])


@router.get("", response_model=list[PrintTaskOut])
def list_tasks(
    status: PrintTaskStatus | None = None,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[PrintTask]:
    q = db.query(PrintTask)
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
) -> PrintTask:
    task = PrintTask(**payload.model_dump(), created_by_id=user.id)
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


@router.patch("/{task_id}", response_model=PrintTaskOut)
def update_task(
    task_id: int,
    payload: PrintTaskUpdate,
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator, UserRole.manager)),
) -> PrintTask:
    task = db.get(PrintTask, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    for field, val in payload.model_dump(exclude_none=True).items():
        setattr(task, field, val)
    db.commit()
    db.refresh(task)
    return task


@router.delete("/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_task(
    task_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> None:
    task = db.get(PrintTask, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    db.delete(task)
    db.commit()
