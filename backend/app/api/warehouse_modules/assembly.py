"""Assembly-session workflow and worker performance endpoints."""
from datetime import date, datetime


from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from app.api.ws import broadcast_warehouse
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles, require_warehouse_full
from app.core.db import get_db
from app.models.organization import Organization
from app.models.user import User, UserRole
from app.models.warehouse import (
    AssemblySession,
    BatchStatus, ProductionBatch, Product,
)
from app.schemas.warehouse import (
    AssemblySessionOut, AssemblySessionUpdate, BatchAssignRequest,
    WorkerStatsOut, WorkerProductStats,
    BatchOut,
)

public_router = APIRouter(tags=["warehouse"])

# All routes that require Starter plan or above (full warehouse access).
# Free plan can only access /products and /categories.
full_router = APIRouter(dependencies=[Depends(require_warehouse_full)])

from app.api.warehouse_modules.pagination import DEFAULT_PAGE_SIZE, PageLimit, PageOffset
from app.api.warehouse_modules.batch_serialization import _batch_to_out

# ── Assembly sessions ─────────────────────────────────────────────────────────

def _session_to_out(
    s: AssemblySession,
    db: Session,
    *,
    worker_map: dict[int, User] | None = None,
    batch_map: dict[int, ProductionBatch] | None = None,
    product_map: dict[int, Product] | None = None,
) -> AssemblySessionOut:
    worker = worker_map.get(s.worker_id) if worker_map is not None else db.get(User, s.worker_id)
    batch = batch_map.get(s.batch_id) if batch_map is not None else db.get(ProductionBatch, s.batch_id)
    product_name = ""
    if batch:
        p = product_map.get(batch.product_id) if product_map is not None else db.get(Product, batch.product_id)
        product_name = p.name if p else ""
    duration: int | None = None
    if s.closed_at:
        delta = s.closed_at - s.started_at
        duration = int(delta.total_seconds() / 60)
    elif s.started_at:
        delta = datetime.utcnow().replace(tzinfo=s.started_at.tzinfo) - s.started_at
        duration = int(delta.total_seconds() / 60)
    return AssemblySessionOut(
        id=s.id, batch_id=s.batch_id, product_name=product_name,
        worker_id=s.worker_id,
        worker_name=(worker.name or worker.email) if worker else "",
        started_at=s.started_at, closed_at=s.closed_at,
        units_good=s.units_good, units_defective=s.units_defective,
        notes=s.notes, duration_minutes=duration,
    )


@full_router.post("/batches/{batch_id}/assign", response_model=BatchOut)
def assign_batch(
    batch_id: int,
    payload:  BatchAssignRequest,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> BatchOut:
    """Assign (or unassign) a batch to a worker."""
    b = db.query(ProductionBatch).filter_by(id=batch_id, organization_id=org.id).first()
    if not b:
        raise HTTPException(status_code=404, detail="Партія не знайдена")
    if payload.assigned_to_id is not None:
        worker = db.query(User).filter_by(id=payload.assigned_to_id, organization_id=org.id).first()
        if not worker:
            raise HTTPException(status_code=404, detail="Робітника не знайдено")
    b.assigned_to_id = payload.assigned_to_id
    db.commit()
    db.refresh(b)
    return _batch_to_out(b, db)


@full_router.post("/batches/{batch_id}/sessions", response_model=AssemblySessionOut, status_code=201)
def start_session(
    batch_id: int,
    bg:   BackgroundTasks,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> AssemblySessionOut:
    """Open a new assembly session for the current user on this batch."""
    b = db.query(ProductionBatch).filter_by(id=batch_id, organization_id=org.id).first()
    if not b:
        raise HTTPException(status_code=404, detail="Партія не знайдена")
    if b.status == BatchStatus.done:
        raise HTTPException(status_code=400, detail="Партія вже закрита")
    # open the batch if it's still draft
    if b.status == BatchStatus.draft:
        b.status = BatchStatus.active
    # ensure there's no already-open session for this worker on this batch
    existing = db.query(AssemblySession).filter_by(
        batch_id=batch_id, worker_id=user.id, organization_id=org.id
    ).filter(AssemblySession.closed_at.is_(None)).first()
    if existing:
        raise HTTPException(status_code=400, detail="У вас вже є відкрита сесія для цієї партії")
    s = AssemblySession(
        organization_id=org.id,
        batch_id=batch_id,
        worker_id=user.id,
        units_good=0,
        units_defective=0,
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    bg.add_task(broadcast_warehouse, org.id, "production")
    return _session_to_out(s, db)


@full_router.patch("/batches/{batch_id}/sessions/{session_id}", response_model=AssemblySessionOut)
def update_session(
    batch_id:   int,
    session_id: int,
    payload:    AssemblySessionUpdate,
    bg:   BackgroundTasks,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> AssemblySessionOut:
    """Update units_good / units_defective during an active session."""
    s = db.query(AssemblySession).filter_by(
        id=session_id, batch_id=batch_id, organization_id=org.id
    ).first()
    if not s:
        raise HTTPException(status_code=404, detail="Сесію не знайдено")
    if s.closed_at:
        raise HTTPException(status_code=400, detail="Сесія вже закрита")
    # workers can only update their own session; admins/managers can update any
    if user.role == UserRole.operator and s.worker_id != user.id:
        raise HTTPException(status_code=403, detail="Це не ваша сесія")
    if payload.units_good is not None:
        s.units_good = payload.units_good
    if payload.units_defective is not None:
        s.units_defective = payload.units_defective
    if payload.notes is not None:
        s.notes = payload.notes
    db.commit()
    db.refresh(s)
    bg.add_task(broadcast_warehouse, org.id, "production")
    return _session_to_out(s, db)


@full_router.post("/batches/{batch_id}/sessions/{session_id}/close", response_model=AssemblySessionOut)
def close_session(
    batch_id:   int,
    session_id: int,
    payload:    AssemblySessionUpdate,
    bg:   BackgroundTasks,
    db:   Session      = Depends(get_db),
    org:  Organization = Depends(get_current_org),
    user: User         = Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> AssemblySessionOut:
    """Close a session and add its output to the batch totals."""
    s = db.query(AssemblySession).filter_by(
        id=session_id, batch_id=batch_id, organization_id=org.id
    ).first()
    if not s:
        raise HTTPException(status_code=404, detail="Сесію не знайдено")
    if s.closed_at:
        raise HTTPException(status_code=400, detail="Сесія вже закрита")
    if user.role == UserRole.operator and s.worker_id != user.id:
        raise HTTPException(status_code=403, detail="Це не ваша сесія")
    # apply final counts
    if payload.units_good is not None:
        s.units_good = payload.units_good
    if payload.units_defective is not None:
        s.units_defective = payload.units_defective
    if payload.notes is not None:
        s.notes = payload.notes
    s.closed_at = datetime.utcnow()
    # roll up into the batch
    b = db.get(ProductionBatch, batch_id)
    if b:
        b.good_qty    += s.units_good
        b.defect_qty  += s.units_defective
        b.printed_qty += s.units_good + s.units_defective
    db.commit()
    db.refresh(s)
    bg.add_task(broadcast_warehouse, org.id, "production")
    return _session_to_out(s, db)


@full_router.get("/assembly/sessions", response_model=list[AssemblySessionOut])
def list_sessions(
    batch_id:  int | None = Query(None),
    worker_id: int | None = Query(None),
    date_from: date | None = Query(None),
    date_to:   date | None = Query(None),
    open_only: bool = Query(False),
    skip: PageOffset = 0,
    limit: PageLimit = DEFAULT_PAGE_SIZE,
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    user: User        = Depends(require_roles(UserRole.admin, UserRole.operator, UserRole.manager)),
) -> list[AssemblySessionOut]:
    """List sessions. Workers see only their own; managers/admins see all."""
    q = db.query(AssemblySession).filter(AssemblySession.organization_id == org.id)
    if user.role == UserRole.operator:
        q = q.filter(AssemblySession.worker_id == user.id)
    elif worker_id:
        q = q.filter(AssemblySession.worker_id == worker_id)
    if batch_id:
        q = q.filter(AssemblySession.batch_id == batch_id)
    if open_only:
        q = q.filter(AssemblySession.closed_at.is_(None))
    if date_from:
        q = q.filter(func.date(AssemblySession.started_at) >= date_from)
    if date_to:
        q = q.filter(func.date(AssemblySession.started_at) <= date_to)
    rows = (
        q.order_by(AssemblySession.started_at.desc(), AssemblySession.id.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )
    worker_ids = {s.worker_id for s in rows}
    batch_ids = {s.batch_id for s in rows}
    worker_map = {
        u.id: u
        for u in db.query(User).filter(User.organization_id == org.id, User.id.in_(worker_ids)).all()
    } if worker_ids else {}
    batch_map = {
        b.id: b
        for b in db.query(ProductionBatch).filter(ProductionBatch.organization_id == org.id, ProductionBatch.id.in_(batch_ids)).all()
    } if batch_ids else {}
    product_ids = {b.product_id for b in batch_map.values()}
    product_map = {
        p.id: p
        for p in db.query(Product).filter(Product.organization_id == org.id, Product.id.in_(product_ids)).all()
    } if product_ids else {}
    return [
        _session_to_out(s, db, worker_map=worker_map, batch_map=batch_map, product_map=product_map)
        for s in rows
    ]


@full_router.get("/assembly/stats", response_model=list[WorkerStatsOut])
def assembly_stats(
    date_from: date | None = Query(None),
    date_to:   date | None = Query(None),
    db:  Session      = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _:   User         = Depends(require_roles(UserRole.admin, UserRole.manager)),
) -> list[WorkerStatsOut]:
    """Per-worker output summary. Admin / manager only."""
    q = db.query(AssemblySession).filter(
        AssemblySession.organization_id == org.id,
        AssemblySession.closed_at.isnot(None),
    )
    if date_from:
        q = q.filter(func.date(AssemblySession.started_at) >= date_from)
    if date_to:
        q = q.filter(func.date(AssemblySession.started_at) <= date_to)
    sessions = q.all()

    from collections import defaultdict
    by_worker: dict[int, list[AssemblySession]] = defaultdict(list)
    for s in sessions:
        by_worker[s.worker_id].append(s)

    worker_ids = set(by_worker)
    worker_map = {
        u.id: u
        for u in db.query(User).filter(User.organization_id == org.id, User.id.in_(worker_ids)).all()
    } if worker_ids else {}
    batch_ids = {s.batch_id for s in sessions}
    batch_map = {
        b.id: b
        for b in db.query(ProductionBatch).filter(ProductionBatch.organization_id == org.id, ProductionBatch.id.in_(batch_ids)).all()
    } if batch_ids else {}
    product_ids = {b.product_id for b in batch_map.values()}
    product_map = {
        p.id: p
        for p in db.query(Product).filter(Product.organization_id == org.id, Product.id.in_(product_ids)).all()
    } if product_ids else {}

    result: list[WorkerStatsOut] = []
    for wid, wss in by_worker.items():
        worker = worker_map.get(wid)
        if not worker:
            continue
        total_min = sum(
            int((s.closed_at - s.started_at).total_seconds() / 60)   # type: ignore[operator]
            for s in wss if s.closed_at
        )
        total_good = sum(s.units_good for s in wss)
        total_def  = sum(s.units_defective for s in wss)
        total      = total_good + total_def
        defect_pct = round(total_def / total * 100, 1) if total else 0.0

        # per-product breakdown
        prod_counts: dict[int, int] = defaultdict(int)
        for s in wss:
            b = batch_map.get(s.batch_id)
            if b:
                prod_counts[b.product_id] += s.units_good

        products = []
        for pid, cnt in prod_counts.items():
            p = product_map.get(pid)
            products.append(WorkerProductStats(
                product_id=pid,
                product_name=p.name if p else f"#{pid}",
                units_good=cnt,
            ))
        products.sort(key=lambda x: x.units_good, reverse=True)

        result.append(WorkerStatsOut(
            worker_id=wid,
            worker_name=worker.name or worker.email,
            worker_email=worker.email,
            total_sessions=len(wss),
            total_minutes=total_min,
            total_good=total_good,
            total_defective=total_def,
            defect_rate_pct=defect_pct,
            products=products,
        ))

    result.sort(key=lambda x: x.total_good, reverse=True)
    return result
