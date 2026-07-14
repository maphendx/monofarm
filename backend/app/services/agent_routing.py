from __future__ import annotations

from sqlalchemy.orm import Query, Session

from app.models.agent import AgentDevice
from app.models.printer import Printer


def _active_paired_devices(db: Session, organization_id: int) -> Query:
    return db.query(AgentDevice).filter(
        AgentDevice.organization_id == organization_id,
        AgentDevice.revoked_at.is_(None),
        AgentDevice.paired_at.isnot(None),
        AgentDevice.credential_hash.isnot(None),
    )


def device_is_active_and_paired(device: AgentDevice) -> bool:
    return device.revoked_at is None and device.is_paired


def device_has_legacy_unassigned_access(db: Session, device: AgentDevice) -> bool:
    """Allow old unassigned farms only when one unscoped device is authoritative."""
    if device.site_id is not None or not device_is_active_and_paired(device):
        return False
    active_ids = [row[0] for row in _active_paired_devices(db, device.organization_id).with_entities(AgentDevice.id).limit(2)]
    return active_ids == [device.id]


def device_can_access_printer(db: Session, device: AgentDevice, printer: Printer) -> bool:
    if printer.organization_id != device.organization_id or not device_is_active_and_paired(device):
        return False
    if printer.agent_device_id is not None:
        return printer.agent_device_id == device.id
    return device_has_legacy_unassigned_access(db, device)


def printer_query_for_device(db: Session, device: AgentDevice) -> Query:
    query = db.query(Printer).filter(
        Printer.organization_id == device.organization_id,
        Printer.agent_device_id == device.id,
    )
    if device_has_legacy_unassigned_access(db, device):
        query = db.query(Printer).filter(
            Printer.organization_id == device.organization_id,
            (Printer.agent_device_id == device.id) | Printer.agent_device_id.is_(None),
        )
    return query


def device_can_handle_org_services(db: Session, device: AgentDevice) -> bool:
    """Telegram is org-wide, so only one unscoped paired device may own it."""
    return device_has_legacy_unassigned_access(db, device)


def printer_for_device_by_moonraker_url(
    db: Session,
    device: AgentDevice,
    moonraker_url: str,
) -> Printer | None:
    return (
        printer_query_for_device(db, device)
        .filter(
            Printer.is_active.is_(True),
            Printer.moonraker_url == moonraker_url,
        )
        .first()
    )


def printer_for_device_by_bambu_dev_id(
    db: Session,
    device: AgentDevice,
    dev_id: str,
) -> Printer | None:
    return (
        printer_query_for_device(db, device)
        .filter(
            Printer.is_active.is_(True),
            Printer.bambu_dev_id == dev_id,
        )
        .first()
    )
