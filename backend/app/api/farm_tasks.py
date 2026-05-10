from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_roles
from app.core.db import get_db
from app.models.task import FarmTask, FarmTaskStatus
from app.models.user import User, UserRole
from app.schemas.task import FarmTaskCreate, FarmTaskOut, FarmTaskUpdate


router = APIRouter(prefix="/tasks/farm", tags=["farm-tasks"])


@router.get("", response_model=list[FarmTaskOut])
def list_farm_tasks(
    status: FarmTaskStatus | None = None,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[FarmTask]:
    q = db.query(FarmTask)
    if status:
        q = q.filter(FarmTask.status == status)
    else:
        q = q.filter(FarmTask.status != FarmTaskStatus.done)
    return q.order_by(FarmTask.deadline.asc().nullslast(), FarmTask.created_at).all()


@router.post("", response_model=FarmTaskOut, status_code=status.HTTP_201_CREATED)
def create_farm_task(
    payload: FarmTaskCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_roles(UserRole.admin, UserRole.operator, UserRole.manager)),
) -> FarmTask:
    task = FarmTask(**payload.model_dump(), created_by_id=user.id)
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


@router.patch("/{task_id}", response_model=FarmTaskOut)
def update_farm_task(
    task_id: int,
    payload: FarmTaskUpdate,
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator, UserRole.manager)),
) -> FarmTask:
    task = db.get(FarmTask, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    for field, val in payload.model_dump(exclude_none=True).items():
        setattr(task, field, val)
    db.commit()
    db.refresh(task)
    return task


@router.delete("/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_farm_task(
    task_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> None:
    task = db.get(FarmTask, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    db.delete(task)
    db.commit()
