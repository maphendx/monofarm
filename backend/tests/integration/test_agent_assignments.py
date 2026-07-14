from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from sqlalchemy.orm import Session

from app.core.security import hash_password
from app.models.organization import Organization
from app.models.printer import Printer, PrinterKind
from app.models.user import User, UserRole


ALL_AGENT_SCOPES = ["agent:connect", "commands:read", "events:write", "status:write"]


def _pair_agent(
    client,
    auth_headers: dict[str, str],
    *,
    name: str,
    site_id: str | None,
) -> dict:
    pairing = client.post(
        "/api/agent/devices/pairing-codes",
        headers=auth_headers,
        json={
            "name": name,
            "site_id": site_id,
            "scopes": ALL_AGENT_SCOPES,
        },
    )
    assert pairing.status_code == 201, pairing.text
    paired = client.post(
        "/api/agent/v2/pair",
        json={
            "pairing_code": pairing.json()["pairing_code"],
            "public_key": base64.b64encode(uuid4().bytes + uuid4().bytes).decode("ascii"),
            "capabilities": ["durable_commands_v2", "provider_adapters_v2"],
        },
    )
    assert paired.status_code == 201, paired.text
    return paired.json()


def _agent_headers(paired: dict) -> dict[str, str]:
    return {"Authorization": f"Bearer {paired['access_token']}"}


def _moonraker(db: Session, org: Organization, *, name: str, url: str) -> Printer:
    printer = Printer(
        organization_id=org.id,
        name=name,
        kind=PrinterKind.other,
        moonraker_url=url,
        is_active=True,
    )
    db.add(printer)
    db.commit()
    db.refresh(printer)
    return printer


def _bambu(db: Session, org: Organization, *, name: str, suffix: str) -> Printer:
    printer = Printer(
        organization_id=org.id,
        name=name,
        kind=PrinterKind.bambu,
        bambu_lan_mode=True,
        bambu_dev_id=f"DEV-{suffix}",
        bambu_dev_ip=f"192.168.70.{suffix}",
        bambu_access_code=f"code{suffix:0>4}",
        bambu_model="N1",
        is_active=True,
    )
    db.add(printer)
    db.commit()
    db.refresh(printer)
    return printer


def _command_body(device_id: str, printer_id: int, key: str) -> dict:
    return {
        "agent_device_id": device_id,
        "printer_id": printer_id,
        "command_type": "printer.status",
        "payload": {},
        "idempotency_key": key,
        "deadline_at": (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
    }


def test_scoped_runtime_config_exposes_only_explicitly_assigned_printer_credentials(
    client,
    db_session: Session,
    test_org: Organization,
    auth_headers: dict[str, str],
) -> None:
    moonraker = _moonraker(
        db_session,
        test_org,
        name="Site A Moonraker",
        url="http://192.168.70.10:7125",
    )
    bambu = _bambu(db_session, test_org, name="Site B Bambu", suffix="20")
    site_a = _pair_agent(client, auth_headers, name="Site A", site_id="site-a")
    site_b = _pair_agent(client, auth_headers, name="Site B", site_id="site-b")

    before_assignment = client.get(
        "/api/agent/v2/runtime-config",
        headers=_agent_headers(site_a),
    )
    assigned_a = client.put(
        f"/api/agent/devices/{site_a['device_id']}/printers",
        headers=auth_headers,
        json={"printer_ids": [moonraker.id]},
    )
    assigned_b = client.put(
        f"/api/agent/devices/{site_b['device_id']}/printers",
        headers=auth_headers,
        json={"printer_ids": [bambu.id]},
    )
    runtime_a = client.get("/api/agent/v2/runtime-config", headers=_agent_headers(site_a))
    runtime_b = client.get("/api/agent/v2/runtime-config", headers=_agent_headers(site_b))

    assert before_assignment.status_code == 200
    assert before_assignment.json()["printers"] == []
    assert assigned_a.status_code == 200, assigned_a.text
    assert assigned_a.json() == {
        "device_id": site_a["device_id"],
        "printer_ids": [moonraker.id],
    }
    assert assigned_b.status_code == 200, assigned_b.text
    assert [item["id"] for item in runtime_a.json()["printers"]] == [moonraker.id]
    assert [item["id"] for item in runtime_b.json()["printers"]] == [bambu.id]
    assert bambu.bambu_access_code not in runtime_a.text
    assert moonraker.moonraker_url not in runtime_b.text

    listed = client.get(
        f"/api/agent/devices/{site_a['device_id']}/printers",
        headers=auth_headers,
    )
    assert listed.status_code == 200
    assert listed.json() == assigned_a.json()


def test_unassigned_printers_fall_back_only_to_one_unscoped_paired_device(
    client,
    db_session: Session,
    test_org: Organization,
    auth_headers: dict[str, str],
) -> None:
    printer = _moonraker(
        db_session,
        test_org,
        name="Legacy Moonraker",
        url="http://192.168.71.10:7125",
    )
    first = _pair_agent(client, auth_headers, name="Legacy Agent", site_id=None)

    sole_runtime = client.get("/api/agent/v2/runtime-config", headers=_agent_headers(first))
    assert [item["id"] for item in sole_runtime.json()["printers"]] == [printer.id]

    second = _pair_agent(client, auth_headers, name="Second Agent", site_id=None)
    ambiguous_first = client.get("/api/agent/v2/runtime-config", headers=_agent_headers(first))
    ambiguous_second = client.get("/api/agent/v2/runtime-config", headers=_agent_headers(second))

    assert ambiguous_first.status_code == 200
    assert ambiguous_first.json()["printers"] == []
    assert ambiguous_second.status_code == 200
    assert ambiguous_second.json()["printers"] == []


def test_scoped_device_cannot_read_org_wide_telegram_credentials(
    client,
    test_org: Organization,
    auth_headers: dict[str, str],
) -> None:
    test_org.tg_bot_token = "123456:site-wide-secret"
    scoped = _pair_agent(client, auth_headers, name="Scoped Telegram Agent", site_id="site-a")

    response = client.get("/api/agent/v2/tg-config", headers=_agent_headers(scoped))

    assert response.status_code == 403


def test_assignment_is_org_scoped_and_command_target_must_match_device(
    client,
    db_session: Session,
    test_org: Organization,
    auth_headers: dict[str, str],
) -> None:
    owned = _moonraker(
        db_session,
        test_org,
        name="Owned Printer",
        url="http://192.168.72.10:7125",
    )
    unassigned = _moonraker(
        db_session,
        test_org,
        name="Unassigned Printer",
        url="http://192.168.72.11:7125",
    )
    first = _pair_agent(client, auth_headers, name="First Site", site_id="first")
    second = _pair_agent(client, auth_headers, name="Second Site", site_id="second")

    assignment = client.put(
        f"/api/agent/devices/{first['device_id']}/printers",
        headers=auth_headers,
        json={"printer_ids": [owned.id]},
    )
    allowed = client.post(
        "/api/agent/commands",
        headers=auth_headers,
        json=_command_body(first["device_id"], owned.id, "assigned-command"),
    )
    wrong_device = client.post(
        "/api/agent/commands",
        headers=auth_headers,
        json=_command_body(second["device_id"], owned.id, "wrong-device-command"),
    )
    ambiguous = client.post(
        "/api/agent/commands",
        headers=auth_headers,
        json=_command_body(first["device_id"], unassigned.id, "ambiguous-command"),
    )

    assert assignment.status_code == 200, assignment.text
    assert allowed.status_code == 201, allowed.text
    assert wrong_device.status_code == 409
    assert ambiguous.status_code == 409

    other_org = Organization(name="Other Assignment Org", slug=f"other-assignment-{uuid4().hex[:8]}")
    db_session.add(other_org)
    db_session.flush()
    other_admin = User(
        organization_id=other_org.id,
        email=f"other-assignment-{uuid4().hex[:8]}@example.com",
        password_hash=hash_password("test-password"),
        name="Other Admin",
        role=UserRole.admin,
        is_active=True,
    )
    foreign = Printer(
        organization_id=other_org.id,
        name="Foreign Printer",
        kind=PrinterKind.other,
    )
    db_session.add_all([other_admin, foreign])
    db_session.commit()

    cross_org = client.put(
        f"/api/agent/devices/{first['device_id']}/printers",
        headers=auth_headers,
        json={"printer_ids": [foreign.id]},
    )
    preserved = client.get(
        f"/api/agent/devices/{first['device_id']}/printers",
        headers=auth_headers,
    )

    assert cross_org.status_code == 404
    assert preserved.json()["printer_ids"] == [owned.id]
