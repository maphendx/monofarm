"""CRUD + reorder endpoints for printer groups."""
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles
from app.core.db import get_db
from app.models.organization import Organization
from app.models.printer import Printer
from app.models.printer_group import PrinterGroup
from app.models.task import FarmTask, FarmTaskStatus
from app.models.user import UserRole
from app.schemas.printer_group import (
    PrinterGroupAction,
    PrinterGroupActionRequest,
    PrinterGroupActionResult,
    PrinterGroupActionSkipped,
    PrinterGroupCreate,
    PrinterGroupOut,
    PrinterGroupReorderItem,
    PrinterGroupUpdate,
)

router = APIRouter(prefix="/printer-groups", tags=["printer-groups"])


def _to_dto(group: PrinterGroup, db: Session, org_id: int) -> PrinterGroupOut:
    count = (
        db.query(func.count(Printer.id))
        .filter(Printer.group_id == group.id, Printer.organization_id == org_id)
        .scalar()
        or 0
    )
    return PrinterGroupOut(
        id=group.id,
        name=group.name,
        sort_order=group.sort_order,
        printer_count=count,
        color=group.color,
        nozzle_diameter=group.nozzle_diameter,
        build_x=group.build_x,
        build_y=group.build_y,
        build_z=group.build_z,
        supported_materials=group.supported_materials or [],
    )


@router.get("", response_model=list[PrinterGroupOut])
def list_groups(
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> list[PrinterGroupOut]:
    groups = (
        db.query(PrinterGroup)
        .filter(PrinterGroup.organization_id == org.id)
        .order_by(PrinterGroup.sort_order, PrinterGroup.name)
        .all()
    )
    return [_to_dto(g, db, org.id) for g in groups]


@router.post("/{group_id}/actions", response_model=PrinterGroupActionResult)
def run_group_action(
    group_id: int,
    payload: PrinterGroupActionRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user=Depends(require_roles(UserRole.admin)),
) -> PrinterGroupActionResult:
    group = (
        db.query(PrinterGroup)
        .filter(PrinterGroup.id == group_id, PrinterGroup.organization_id == org.id)
        .first()
    )
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")

    printers = (
        db.query(Printer)
        .filter(Printer.organization_id == org.id, Printer.group_id == group.id)
        .order_by(Printer.sort_order, Printer.name)
        .all()
    )
    affected = 0
    skipped: list[PrinterGroupActionSkipped] = []
    task_id: int | None = None

    if payload.action in {
        PrinterGroupAction.mark_out_of_order,
        PrinterGroupAction.restore_service,
    }:
        target = payload.action == PrinterGroupAction.mark_out_of_order
        for printer in printers:
            if printer.is_out_of_order == target:
                continue
            printer.is_out_of_order = target
            affected += 1

    elif payload.action == PrinterGroupAction.create_maintenance:
        names = ", ".join(printer.name for printer in printers) or "немає принтерів"
        context = f"Група принтерів: {group.name}\nПринтери: {names}"
        if payload.description:
            context = f"{context}\n\n{payload.description.strip()}"
        task = FarmTask(
            organization_id=org.id,
            title=payload.title or f"Обслуговування: {group.name}",
            description=context,
            status=FarmTaskStatus.todo,
            deadline=payload.deadline,
            created_by_id=_user.id,
        )
        db.add(task)
        db.flush()
        task_id = task.id
        affected = len(printers)

    elif payload.action == PrinterGroupAction.enable_autoprint:
        from app.services.autoprint import is_a1_mini, start_next_for_printer

        for printer in printers:
            if printer.kind.value != "bambu" or not is_a1_mini(
                printer.bambu_model,
                printer.bambu_dev_id,
            ):
                skipped.append(
                    PrinterGroupActionSkipped(
                        printer_id=printer.id,
                        printer_name=printer.name,
                        reason="AutoPrint підтримує лише Bambu A1 Mini",
                    )
                )
                continue
            if (
                not printer.bambu_lan_mode
                or not printer.bambu_dev_ip
                or not printer.bambu_access_code
            ):
                skipped.append(
                    PrinterGroupActionSkipped(
                        printer_id=printer.id,
                        printer_name=printer.name,
                        reason="Потрібні LAN-only/Developer Mode, IP та Access Code",
                    )
                )
                continue
            printer.autoprint_mode = "platecycler"
            printer.autoprint_plates_remaining = payload.plates_loaded
            printer.autoprint_cooldown_temp_c = payload.cooldown_temp_c
            printer.autoprint_delay_seconds = payload.delay_seconds
            printer.autoprint_eject_last_plate = payload.eject_last_plate
            printer.autoprint_error = None
            affected += 1
            background_tasks.add_task(start_next_for_printer, printer.id)

    elif payload.action == PrinterGroupAction.disable_autoprint:
        for printer in printers:
            if printer.autoprint_mode == "off":
                continue
            printer.autoprint_mode = "off"
            printer.autoprint_error = None
            affected += 1

    db.commit()

    messages = {
        PrinterGroupAction.mark_out_of_order: f"Позначено несправними: {affected}",
        PrinterGroupAction.restore_service: f"Повернуто в роботу: {affected}",
        PrinterGroupAction.create_maintenance: "Завдання обслуговування створено",
        PrinterGroupAction.enable_autoprint: f"AutoPrint увімкнено: {affected}",
        PrinterGroupAction.disable_autoprint: f"AutoPrint вимкнено: {affected}",
    }
    return PrinterGroupActionResult(
        action=payload.action,
        group_id=group.id,
        group_name=group.name,
        affected=affected,
        skipped=skipped,
        task_id=task_id,
        message=messages[payload.action],
    )


@router.post("", response_model=PrinterGroupOut, status_code=status.HTTP_201_CREATED)
def create_group(
    payload: PrinterGroupCreate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user=Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> PrinterGroupOut:
    max_order = (
        db.query(func.max(PrinterGroup.sort_order))
        .filter(PrinterGroup.organization_id == org.id)
        .scalar()
        or 0
    )
    group = PrinterGroup(
        organization_id=org.id,
        name=payload.name.strip(),
        sort_order=max_order + 1,
        color=payload.color,
        nozzle_diameter=payload.nozzle_diameter,
        build_x=payload.build_x,
        build_y=payload.build_y,
        build_z=payload.build_z,
        supported_materials=payload.supported_materials,
    )
    db.add(group)
    db.commit()
    db.refresh(group)
    return _to_dto(group, db, org.id)


@router.patch("/{group_id}", response_model=PrinterGroupOut)
def update_group(
    group_id: int,
    payload: PrinterGroupUpdate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user=Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> PrinterGroupOut:
    group = db.query(PrinterGroup).filter(PrinterGroup.id == group_id, PrinterGroup.organization_id == org.id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    if payload.name is not None:
        group.name = payload.name.strip()
    if payload.color is not None:
        group.color = payload.color or None
    if payload.nozzle_diameter is not None:
        group.nozzle_diameter = payload.nozzle_diameter
    if payload.build_x is not None:
        group.build_x = payload.build_x
    if payload.build_y is not None:
        group.build_y = payload.build_y
    if payload.build_z is not None:
        group.build_z = payload.build_z
    if payload.supported_materials is not None:
        group.supported_materials = payload.supported_materials
    db.commit()
    db.refresh(group)
    return _to_dto(group, db, org.id)


@router.delete("/{group_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_group(
    group_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user=Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> None:
    group = db.query(PrinterGroup).filter(PrinterGroup.id == group_id, PrinterGroup.organization_id == org.id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    db.delete(group)
    db.commit()


@router.post("/reorder", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def reorder_groups(
    items: list[PrinterGroupReorderItem],
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _user=Depends(require_roles(UserRole.admin, UserRole.operator)),
) -> None:
    for item in items:
        group = db.query(PrinterGroup).filter(PrinterGroup.id == item.id, PrinterGroup.organization_id == org.id).first()
        if group:
            group.sort_order = item.sort_order
    db.commit()
