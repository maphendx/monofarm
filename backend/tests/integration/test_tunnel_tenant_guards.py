from __future__ import annotations

import asyncio
import hashlib
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest
from sqlalchemy.orm import Session

from app.core import db as core_db
from app.core.security import hash_password
from app.models.agent import AgentDevice
from app.models.organization import Organization
from app.models.printer import Printer, PrinterKind
from app.models.user import User, UserRole
from app.services import bambu, tunnel


def _other_org(db: Session) -> Organization:
    suffix = uuid4().hex[:8]
    org = Organization(name=f"Other {suffix}", slug=f"other-tunnel-{suffix}")
    db.add(org)
    db.commit()
    db.refresh(org)
    return org


def _use_test_session(monkeypatch, db_session: Session) -> None:
    @contextmanager
    def session_factory():
        yield db_session

    monkeypatch.setattr(core_db, "SessionLocal", session_factory)


def _paired_device(
    db: Session,
    org: Organization,
    *,
    name: str,
    site_id: str | None,
) -> AgentDevice:
    device = AgentDevice(
        organization_id=org.id,
        name=name,
        site_id=site_id,
        scopes=["agent:connect", "commands:read", "events:write", "status:write"],
        credential_hash=hashlib.sha256(f"{name}-{uuid4()}".encode()).hexdigest(),
        paired_at=datetime.now(timezone.utc),
    )
    db.add(device)
    db.commit()
    db.refresh(device)
    return device


def test_tg_claim_link_cannot_consume_a_code_from_another_org(
    db_session: Session,
    test_org: Organization,
    monkeypatch,
) -> None:
    other_org = _other_org(db_session)
    foreign_user = User(
        organization_id=other_org.id,
        email=f"foreign-tunnel-{uuid4().hex[:8]}@example.com",
        password_hash=hash_password("test-password"),
        name="Foreign Telegram User",
        role=UserRole.operator,
        is_active=True,
        telegram_link_code="foreign-tunnel-code",
        telegram_link_expires_at=datetime.now(timezone.utc) + timedelta(minutes=10),
    )
    db_session.add(foreign_user)
    db_session.commit()
    _use_test_session(monkeypatch, db_session)
    send = AsyncMock(return_value=True)
    monkeypatch.setattr(tunnel, "send_telegram", send)

    asyncio.run(
        tunnel._handle_tg_claim_link(
            {"code": "foreign-tunnel-code", "chat_id": 424242},
            test_org.id,
        )
    )

    db_session.refresh(foreign_user)
    assert foreign_user.telegram_chat_id is None
    assert foreign_user.telegram_link_code == "foreign-tunnel-code"
    assert "Невірний код" in send.await_args.args[2]


def test_bambu_status_push_rejects_a_device_owned_by_another_org(
    db_session: Session,
    test_org: Organization,
    monkeypatch,
) -> None:
    other_org = _other_org(db_session)
    foreign_printer = Printer(
        organization_id=other_org.id,
        name="Foreign Bambu",
        kind=PrinterKind.bambu,
        bambu_dev_id="FOREIGN-DEV-ID",
        bambu_lan_mode=True,
        bambu_dev_ip="192.168.20.20",
        bambu_access_code="12345678",
        bambu_model="N1",
        is_active=True,
    )
    db_session.add(foreign_printer)
    db_session.commit()
    _use_test_session(monkeypatch, db_session)
    handle_report = MagicMock(return_value=None)
    monkeypatch.setattr(bambu, "handle_agent_report", handle_report)

    tunnel._handle_bambu_status_push(
        {
            "dev_id": foreign_printer.bambu_dev_id,
            "payload": {"print": {"gcode_state": "RUNNING"}},
        },
        test_org.id,
    )

    handle_report.assert_not_called()


def test_bambu_status_push_accepts_an_active_device_from_the_socket_org(
    db_session: Session,
    test_org: Organization,
    monkeypatch,
) -> None:
    printer = Printer(
        organization_id=test_org.id,
        name="Owned Bambu",
        kind=PrinterKind.bambu,
        bambu_dev_id="OWNED-DEV-ID",
        bambu_lan_mode=True,
        bambu_dev_ip="192.168.20.21",
        bambu_access_code="12345678",
        bambu_model="N1",
        is_active=True,
    )
    db_session.add(printer)
    db_session.commit()
    _use_test_session(monkeypatch, db_session)
    handle_report = MagicMock(return_value=None)
    monkeypatch.setattr(bambu, "handle_agent_report", handle_report)

    tunnel._handle_bambu_status_push(
        {
            "dev_id": printer.bambu_dev_id,
            "payload": {"print": {"gcode_state": "RUNNING"}},
        },
        test_org.id,
    )

    handle_report.assert_called_once_with(
        test_org.id,
        printer.bambu_dev_id,
        {"print": {"gcode_state": "RUNNING"}},
    )


def test_v2_status_push_requires_scope_and_matching_printer_assignment(
    db_session: Session,
    test_org: Organization,
    monkeypatch,
) -> None:
    assigned_device = _paired_device(db_session, test_org, name="Assigned", site_id="site-a")
    other_device = _paired_device(db_session, test_org, name="Other", site_id="site-b")
    printer = Printer(
        organization_id=test_org.id,
        agent_device_id=assigned_device.id,
        name="Assigned Moonraker",
        kind=PrinterKind.other,
        moonraker_url="http://192.168.80.10:7125",
        is_active=True,
    )
    db_session.add(printer)
    db_session.commit()
    _use_test_session(monkeypatch, db_session)
    status_handler = MagicMock()
    monkeypatch.setattr(tunnel, "_handle_status_push", status_handler)
    message = {
        "type": "STATUS_PUSH",
        "url": printer.moonraker_url,
        "status": {"print_stats": {"state": "standby"}},
    }

    with pytest.raises(tunnel.AgentMessageRejected):
        asyncio.run(
            tunnel.handle_agent_message(
                message,
                org_id=test_org.id,
                device_id=assigned_device.id,
                scopes=frozenset({"agent:connect"}),
            )
        )
    with pytest.raises(tunnel.AgentMessageRejected):
        asyncio.run(
            tunnel.handle_agent_message(
                message,
                org_id=test_org.id,
                device_id=other_device.id,
                scopes=frozenset({"agent:connect", "status:write"}),
            )
        )

    asyncio.run(
        tunnel.handle_agent_message(
            message,
            org_id=test_org.id,
            device_id=assigned_device.id,
            scopes=frozenset({"agent:connect", "status:write"}),
        )
    )
    status_handler.assert_called_once_with(message, test_org.id)


def test_v2_bambu_push_rejects_a_printer_assigned_to_another_device(
    db_session: Session,
    test_org: Organization,
    monkeypatch,
) -> None:
    assigned_device = _paired_device(db_session, test_org, name="Bambu Assigned", site_id="site-a")
    other_device = _paired_device(db_session, test_org, name="Bambu Other", site_id="site-b")
    printer = Printer(
        organization_id=test_org.id,
        agent_device_id=assigned_device.id,
        name="Assigned Bambu",
        kind=PrinterKind.bambu,
        bambu_dev_id="ASSIGNED-BAMBU",
        bambu_lan_mode=True,
        bambu_dev_ip="192.168.80.20",
        bambu_access_code="12345678",
        bambu_model="N1",
        is_active=True,
    )
    db_session.add(printer)
    db_session.commit()
    _use_test_session(monkeypatch, db_session)
    handle_report = MagicMock(return_value=None)
    monkeypatch.setattr(bambu, "handle_agent_report", handle_report)

    with pytest.raises(tunnel.AgentMessageRejected):
        asyncio.run(
            tunnel.handle_agent_message(
                {
                    "type": "BAMBU_STATUS_PUSH",
                    "dev_id": printer.bambu_dev_id,
                    "payload": {"print": {"gcode_state": "RUNNING"}},
                },
                org_id=test_org.id,
                device_id=other_device.id,
                scopes=frozenset({"agent:connect", "status:write"}),
            )
        )

    handle_report.assert_not_called()


def test_v2_tg_messages_use_authenticated_org_and_reject_scoped_devices(
    db_session: Session,
    test_org: Organization,
    monkeypatch,
) -> None:
    other_org = _other_org(db_session)
    unscoped = _paired_device(db_session, test_org, name="Org Service Agent", site_id=None)
    _use_test_session(monkeypatch, db_session)

    asyncio.run(
        tunnel.handle_agent_message(
            {
                "type": "TG_BOT_USERNAME",
                "org_id": other_org.id,
                "username": "authenticated_org_bot",
            },
            org_id=test_org.id,
            device_id=unscoped.id,
            scopes=frozenset({"agent:connect", "status:write"}),
        )
    )

    db_session.refresh(test_org)
    db_session.refresh(other_org)
    assert test_org.tg_bot_username == "authenticated_org_bot"
    assert other_org.tg_bot_username != "authenticated_org_bot"

    unscoped.site_id = "scoped-site"
    db_session.commit()
    with pytest.raises(tunnel.AgentMessageRejected):
        asyncio.run(
            tunnel.handle_agent_message(
                {"type": "TG_BOT_USERNAME", "username": "must_not_apply"},
                org_id=test_org.id,
                device_id=unscoped.id,
                scopes=frozenset({"agent:connect", "status:write"}),
            )
        )
