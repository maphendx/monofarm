"""Workflow CRUD, runs and public webhook triggers."""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles
from app.core.db import get_db
from app.models.organization import Organization
from app.models.user import User, UserRole
from app.models.workflow import Workflow, WorkflowRun, WorkflowRunStatus
from app.schemas.workflow import (
    WorkflowCatalog,
    WorkflowCreate,
    WorkflowRunCreate,
    WorkflowOut,
    WorkflowRunOut,
    WorkflowUpdate,
)
from app.services import workflow_events
from app.services.workflow_engine import create_run
from app.services.workflow_nodes import (
    CATALOG,
    EVENT_TYPES,
    assign_webhook_secrets,
    validate_graph,
)
from app.services.workflow_scheduler import remove_workflow_jobs, sync_workflow_jobs

log = logging.getLogger(__name__)

router = APIRouter(prefix="/workflows", tags=["workflows"])

MAX_WEBHOOK_BODY = 64_000

ReadRoles = Depends(require_roles(UserRole.admin, UserRole.operator, UserRole.manager))
WriteRoles = Depends(require_roles(UserRole.admin, UserRole.operator))


def _get_workflow(workflow_id: int, org: Organization, db: Session) -> Workflow:
    workflow = (
        db.query(Workflow)
        .filter(Workflow.id == workflow_id, Workflow.organization_id == org.id)
        .first()
    )
    if workflow is None:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return workflow


def _validate_or_400(graph: Any) -> dict[str, Any]:
    errors = validate_graph(graph)
    if errors:
        raise HTTPException(
            status_code=400,
            detail="; ".join(errors[:5]),
        )
    return graph


def _require_experimental_editor(org: Organization) -> None:
    """Editor access is opt-in per org; already-active automations keep running."""
    if not org.workflows_enabled:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Експериментальний редактор автоматизацій вимкнено. "
                   "Адміністратор може увімкнути його в Налаштуваннях.",
        )


def _lock_notification_owner(db: Session, org: Organization) -> Organization:
    return db.query(Organization).filter(Organization.id == org.id).with_for_update().populate_existing().one()


def _validate_notification_owner(org: Organization, graph: dict, enabled: bool) -> None:
    if not enabled:
        return
    from app.services.workflow_nodes import telegram_rule_events
    overlaps = telegram_rule_events(graph)
    if ("print.failed" in overlaps and org.notify_print_failed) or ("filament.low" in overlaps and org.notify_filament_low):
        raise HTTPException(409, detail="Спочатку вимкніть відповідне готове правило в Налаштуваннях → Сповіщення / Disable the matching ready-made notification rule first")


@router.get("", response_model=list[WorkflowOut])
def list_workflows(
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = ReadRoles,
):
    return (
        db.query(Workflow)
        .filter(Workflow.organization_id == org.id)
        .order_by(Workflow.id.desc())
        .all()
    )


@router.post("", response_model=WorkflowOut, status_code=status.HTTP_201_CREATED)
def create_workflow(
    payload: WorkflowCreate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = WriteRoles,
):
    org = _lock_notification_owner(db, org)
    _require_experimental_editor(org)
    graph = assign_webhook_secrets(payload.graph)
    _validate_or_400(graph)
    _validate_notification_owner(org, graph, payload.enabled)
    workflow = Workflow(
        organization_id=org.id,
        name=payload.name,
        description=payload.description,
        graph=graph,
        enabled=payload.enabled,
        version=1,
    )
    db.add(workflow)
    db.commit()
    db.refresh(workflow)
    sync_workflow_jobs(workflow)
    return workflow


@router.get("/catalog", response_model=WorkflowCatalog)
def get_catalog(
    org: Organization = Depends(get_current_org),
    _user: User = ReadRoles,
):
    # Read-only metadata remains available to inspect existing automations.
    return WorkflowCatalog(nodes=CATALOG, events=EVENT_TYPES)


@router.get("/runs/{run_id}", response_model=WorkflowRunOut)
def get_run(
    run_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = ReadRoles,
):
    run = (
        db.query(WorkflowRun)
        .filter(WorkflowRun.id == run_id, WorkflowRun.organization_id == org.id)
        .first()
    )
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return run


@router.post("/runs/{run_id}/stop", response_model=WorkflowRunOut)
def stop_run(
    run_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = WriteRoles,
):
    run = (
        db.query(WorkflowRun)
        .filter(WorkflowRun.id == run_id, WorkflowRun.organization_id == org.id)
        .first()
    )
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    if run.status in (WorkflowRunStatus.pending, WorkflowRunStatus.waiting, WorkflowRunStatus.running):
        run.status = WorkflowRunStatus.stopped
        db.commit()
        db.refresh(run)
    return run


@router.get("/{workflow_id}", response_model=WorkflowOut)
def get_workflow(
    workflow_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = ReadRoles,
):
    return _get_workflow(workflow_id, org, db)


@router.put("/{workflow_id}", response_model=WorkflowOut)
def update_workflow(
    workflow_id: int,
    payload: WorkflowUpdate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = WriteRoles,
):
    org = _lock_notification_owner(db, org)
    workflow = _get_workflow(workflow_id, org, db)
    if not org.workflows_enabled:
        # With the editor disabled, an existing automation may only be switched
        # off — full edits require consciously enabling the experimental flag.
        disabling_only = (
            payload.name is None
            and payload.description is None
            and payload.graph is None
            and payload.enabled is False
        )
        if not disabling_only:
            _require_experimental_editor(org)
    if payload.name is not None:
        workflow.name = payload.name
    if payload.description is not None:
        workflow.description = payload.description
    if payload.graph is not None:
        graph = assign_webhook_secrets(payload.graph)
        _validate_or_400(graph)
        workflow.graph = graph
    if payload.enabled is not None:
        workflow.enabled = payload.enabled
    _validate_notification_owner(org, workflow.graph, workflow.enabled)
    workflow.version += 1
    db.commit()
    db.refresh(workflow)
    sync_workflow_jobs(workflow)
    return workflow


@router.delete("/{workflow_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_workflow(
    workflow_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles(UserRole.admin)),
):
    _require_experimental_editor(org)
    workflow = _get_workflow(workflow_id, org, db)
    db.delete(workflow)
    db.commit()
    remove_workflow_jobs(workflow_id)


@router.post("/{workflow_id}/run", response_model=WorkflowRunOut, status_code=status.HTTP_202_ACCEPTED)
def run_workflow(
    workflow_id: int,
    payload: WorkflowRunCreate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = WriteRoles,
):
    _require_experimental_editor(org)
    workflow = _get_workflow(workflow_id, org, db)
    run = create_run(db, workflow, "manual", dict(payload.payload))
    db.commit()
    db.refresh(run)
    return run


@router.get("/{workflow_id}/runs", response_model=list[WorkflowRunOut])
def list_runs(
    workflow_id: int,
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = ReadRoles,
):
    _get_workflow(workflow_id, org, db)
    return (
        db.query(WorkflowRun)
        .filter(WorkflowRun.workflow_id == workflow_id, WorkflowRun.organization_id == org.id)
        .order_by(WorkflowRun.id.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )


@router.post("/hooks/{token}", status_code=status.HTTP_202_ACCEPTED)
async def webhook_trigger(
    token: str,
    request: Request,
    db: Session = Depends(get_db),
):
    """Public webhook trigger — the token is the credential.

    Token format: ``whk-<workflow_id>-<secret>``; the secret must match the
    workflow's webhook trigger node. Disabled or unknown tokens get 404 so
    the endpoint does not leak existence.
    """
    parts = token.split("-")
    if len(parts) != 3 or parts[0] != "whk":
        raise HTTPException(status_code=404, detail="Unknown webhook")
    try:
        workflow_id = int(parts[1])
    except ValueError:
        raise HTTPException(status_code=404, detail="Unknown webhook") from None

    workflow = db.get(Workflow, workflow_id)
    if workflow is None or not workflow.enabled:
        raise HTTPException(status_code=404, detail="Unknown webhook")

    fired = None
    for node in (workflow.graph or {}).get("nodes", []):
        if node.get("type") == "trigger.webhook" and (node.get("config") or {}).get("token") == parts[2]:
            fired = node
            break
    if fired is None:
        raise HTTPException(status_code=404, detail="Unknown webhook")

    body: Any
    try:
        body = await request.json()
    except Exception:
        raw = await request.body()
        body = raw.decode("utf-8", errors="replace")[:MAX_WEBHOOK_BODY]
    payload = {"body": body, "query": dict(request.query_params)}

    run = create_run(db, workflow, workflow_events.WEBHOOK_RECEIVED, payload, fired_node_key=fired.get("key"))
    db.commit()
    log.info("workflow webhook fired: workflow=%s run=%s", workflow.id, run.id)
    return {"run_id": run.id, "status": run.status.value if hasattr(run.status, "value") else str(run.status)}
