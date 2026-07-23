"""Tags API.

Endpoints:
  GET    /tags                         — list org tags (optional ?kind=)
  POST   /tags                         — create a tag
  DELETE /tags/{tag_id}                — delete a tag (removes from all entities)

  PUT    /printers/{printer_id}/tags   — replace printer tag set
  PUT    /queue/{task_id}/tags         — replace task tag set
  PUT    /files/{file_id}/tags         — replace gcode file tag set

  GET    /queue/{task_id}/matching-printers  — list printers + match status
"""
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles
from app.core.db import get_db
from app.models.gcode_file import GcodeFile
from app.models.organization import Organization
from app.models.printer import Printer
from app.models.tag import Tag, TagKind
from app.models.task import PrintTask
from app.models.user import User, UserRole
from app.schemas.tag import TagAssign, TagCreate, TagOut, TagSettingsOut, TagSettingsUpdate, TagUpdate, TagsMatchResult
from app.services.queue_targeting import target_reasons

router = APIRouter(tags=["tags"])


# ── Helpers ───────────────────────────────────────────────────────────────────────

def _tag_out(tag: Tag) -> TagOut:
    return TagOut(
        id=tag.id,
        kind=tag.kind,
        label=tag.label,
        color=tag.color,
        meta=tag.meta,
        display=tag.display,
    )


def _get_tag(db: Session, tag_id: int, org_id: int) -> Tag:
    tag = db.query(Tag).filter(Tag.id == tag_id, Tag.organization_id == org_id).first()
    if not tag:
        raise HTTPException(status_code=404, detail="Tag not found")
    return tag


def _task_matches_printer(task: PrintTask, printer: Printer) -> tuple[bool, list[str]]:
    """Return (matches, reasons_for_failure).

    Matching rules (mirrors SimplyPrint logic):
    1. If task has a nozzle tag → printer must have same nozzle tag diameter.
    2. If task has a material tag → printer must have same material type AND
       (if color_name set) same color_name.
    3. Printer must contain ALL custom tags the task has.
    4. If task has NO tags at all → always matches (fallback to gcode/size criteria).
    """
    task_tags = task.tags or []
    printer_tags = printer.tags or []

    if not task_tags:
        return True, []

    reasons: list[str] = []

    # — Nozzle
    task_nozzle = next((t for t in task_tags if t.kind == TagKind.nozzle), None)
    if task_nozzle:
        printer_nozzle = next((t for t in printer_tags if t.kind == TagKind.nozzle), None)
        if not printer_nozzle:
            reasons.append(f"Printer has no nozzle tag (required: Ø{task_nozzle.nozzle_diameter}mm)")
        elif printer_nozzle.nozzle_diameter != task_nozzle.nozzle_diameter:
            reasons.append(
                f"Nozzle mismatch: printer=Ø{printer_nozzle.nozzle_diameter}mm, task=Ø{task_nozzle.nozzle_diameter}mm"
            )

    # — Material
    task_material = next((t for t in task_tags if t.kind == TagKind.material), None)
    if task_material:
        printer_material = next((t for t in printer_tags if t.kind == TagKind.material), None)
        if not printer_material:
            reasons.append(f"Printer has no material tag (required: {task_material.material_type})")
        else:
            if printer_material.material_type != task_material.material_type:
                reasons.append(
                    f"Material type mismatch: printer={printer_material.material_type}, task={task_material.material_type}"
                )
            # Color name match only if task specifies it
            task_cn = task_material.material_color_name
            if task_cn and printer_material.material_color_name != task_cn:
                reasons.append(
                    f"Color name mismatch: printer='{printer_material.material_color_name}', task='{task_cn}'"
                )

    # — Custom tags: printer must have ALL custom tags that the task has
    task_custom = {t.label for t in task_tags if t.kind == TagKind.custom and t.label}
    printer_custom = {t.label for t in printer_tags if t.kind == TagKind.custom and t.label}
    missing_custom = task_custom - printer_custom
    if missing_custom:
        reasons.append(f"Missing custom tags: {', '.join(sorted(missing_custom))}")

    return len(reasons) == 0, reasons


# ── Tag CRUD ──────────────────────────────────────────────────────────────────────

@router.get("/tags", response_model=list[TagOut])
def list_tags(
    kind: TagKind | None = Query(None),
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
):
    q = db.query(Tag).filter(Tag.organization_id == org.id)
    if kind:
        q = q.filter(Tag.kind == kind)
    return [_tag_out(t) for t in q.order_by(Tag.kind, Tag.id).all()]


@router.post("/tags", response_model=TagOut, status_code=status.HTTP_201_CREATED)
def create_tag(
    body: TagCreate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles([UserRole.admin, UserRole.operator])),
):
    tag = Tag(
        organization_id=org.id,
        kind=body.kind,
        label=body.label,
        color=body.color,
        meta=body.meta,
    )
    db.add(tag)
    db.commit()
    db.refresh(tag)
    return _tag_out(tag)


@router.patch("/tags/{tag_id}", response_model=TagOut)
def update_tag(
    tag_id: int,
    body: TagUpdate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles([UserRole.admin, UserRole.operator])),
):
    tag = _get_tag(db, tag_id, org.id)
    if body.label is not None:
        tag.label = body.label
    if body.color is not None:
        tag.color = body.color
    if body.meta is not None:
        tag.meta = body.meta
    db.commit()
    db.refresh(tag)
    return _tag_out(tag)


@router.delete("/tags/{tag_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_tag(
    tag_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles([UserRole.admin, UserRole.operator])),
):
    tag = _get_tag(db, tag_id, org.id)
    db.delete(tag)
    db.commit()


# ── Assign tags to entities ──────────────────────────────────────────────────────

@router.put("/printers/{printer_id}/tags", response_model=list[TagOut])
def set_printer_tags(
    printer_id: int,
    body: TagAssign,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles([UserRole.admin, UserRole.operator])),
):
    printer = db.query(Printer).filter(Printer.id == printer_id, Printer.organization_id == org.id).first()
    if not printer:
        raise HTTPException(status_code=404, detail="Printer not found")
    tags = db.query(Tag).filter(Tag.id.in_(body.tag_ids), Tag.organization_id == org.id).all()
    if len(tags) != len(body.tag_ids):
        raise HTTPException(status_code=400, detail="Some tag IDs not found in your org")
    printer.tags = tags
    db.commit()
    return [_tag_out(t) for t in printer.tags]


@router.put("/queue/{task_id}/tags", response_model=list[TagOut])
def set_task_tags(
    task_id: int,
    body: TagAssign,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles([UserRole.admin, UserRole.operator])),
):
    task = db.query(PrintTask).filter(PrintTask.id == task_id, PrintTask.organization_id == org.id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    tags = db.query(Tag).filter(Tag.id.in_(body.tag_ids), Tag.organization_id == org.id).all()
    if len(tags) != len(body.tag_ids):
        raise HTTPException(status_code=400, detail="Some tag IDs not found in your org")
    task.tags = tags
    db.commit()
    return [_tag_out(t) for t in task.tags]


@router.put("/files/{file_id}/tags", response_model=list[TagOut])
def set_file_tags(
    file_id: int,
    body: TagAssign,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles([UserRole.admin, UserRole.operator])),
):
    gf = db.query(GcodeFile).filter(GcodeFile.id == file_id, GcodeFile.organization_id == org.id).first()
    if not gf:
        raise HTTPException(status_code=404, detail="File not found")
    tags = db.query(Tag).filter(Tag.id.in_(body.tag_ids), Tag.organization_id == org.id).all()
    if len(tags) != len(body.tag_ids):
        raise HTTPException(status_code=400, detail="Some tag IDs not found in your org")
    gf.tags = tags
    db.commit()
    return [_tag_out(t) for t in gf.tags]


# ── Matching ────────────────────────────────────────────────────────────────────────

@router.get("/queue/{task_id}/matching-printers", response_model=list[TagsMatchResult])
def get_matching_printers(
    task_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
):
    """Return all active printers with match status for the given queue item."""
    task = db.query(PrintTask).filter(PrintTask.id == task_id, PrintTask.organization_id == org.id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    printers = db.query(Printer).filter(
        Printer.organization_id == org.id,
        Printer.is_active.is_(True),
    ).all()

    results = []
    for p in printers:
        matches, reasons = _task_matches_printer(task, p)
        t_reasons = target_reasons(task, p)
        if t_reasons:
            matches = False
            reasons = [*reasons, *t_reasons]
        if p.is_out_of_order:
            matches = False
            reasons = [*reasons, "Printer is marked out of order"]
        results.append(
            TagsMatchResult(
                printer_id=p.id,
                printer_name=p.name,
                matches=matches,
                reasons=reasons,
            )
        )
    return results


# ── Tag settings (org-level) ───────────────────────────────────────────────────────

def _default_settings() -> dict:
    return {
        "auto_tag_on_upload": True,
        "nozzle_match_strict": True,
        "material_match_color": False,
        "material_clusters": [],
        "bed_type_map": {},
    }


@router.get("/orgs/tag-settings", response_model=TagSettingsOut)
def get_tag_settings(
    org: Organization = Depends(get_current_org),
):
    merged = {**_default_settings(), **(org.tag_settings or {})}
    return TagSettingsOut(**merged)


@router.patch("/orgs/tag-settings", response_model=TagSettingsOut)
def update_tag_settings(
    body: TagSettingsUpdate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user: User = Depends(require_roles([UserRole.admin])),
):
    current = {**_default_settings(), **(org.tag_settings or {})}
    patch = body.model_dump(exclude_none=True)
    current.update(patch)
    org.tag_settings = current
    db.add(org)
    db.commit()
    db.refresh(org)
    return TagSettingsOut(**{**_default_settings(), **(org.tag_settings or {})})
