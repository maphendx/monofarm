from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import hash_password
from app.models.organization import Organization
from app.models.printer import Printer, PrinterKind
from app.models.user import User, UserRole


def _pair_agent(client, auth_headers: dict[str, str], *, scopes: list[str]) -> str:
    pairing = client.post(
        "/api/agent/devices/pairing-codes",
        headers=auth_headers,
        json={"name": "Runtime Agent", "scopes": scopes},
    )
    assert pairing.status_code == 201, pairing.text
    paired = client.post(
        "/api/agent/v2/pair",
        json={
            "pairing_code": pairing.json()["pairing_code"],
            "public_key": base64.b64encode(bytes([7]) * 32).decode("ascii"),
            "capabilities": ["moonraker", "bambu_lan"],
        },
    )
    assert paired.status_code == 201, paired.text
    return paired.json()["access_token"]


def _agent_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_runtime_config_returns_only_active_supported_printers_for_agent_org(
    client,
    db_session: Session,
    test_org: Organization,
    auth_headers: dict[str, str],
    monkeypatch,
) -> None:
    monkeypatch.setattr(settings, "FARM_PUBLIC_URL", "https://API.Monofarm.test:8443/app")
    monkeypatch.setattr(settings, "AGENT_UPDATE_BASE_URL", "https://updates.monofarm.test/runtime")
    monkeypatch.setattr(settings, "S3_ENDPOINT_URL", "https://r2.monofarm.test/bucket")
    moonraker = Printer(
        organization_id=test_org.id,
        name="U1 Local",
        kind=PrinterKind.snapmaker_u1,
        moonraker_url="http://192.168.10.21:7125",
        is_active=True,
        sort_order=1,
    )
    bambu = Printer(
        organization_id=test_org.id,
        name="A1 Mini Local",
        kind=PrinterKind.bambu,
        bambu_lan_mode=True,
        bambu_dev_id="01P00A123456789",
        bambu_dev_ip="192.168.10.22",
        bambu_access_code="12345678",
        bambu_model="N1",
        is_active=True,
        sort_order=2,
    )
    unsupported = [
        Printer(
            organization_id=test_org.id,
            name="Inactive Moonraker",
            kind=PrinterKind.other,
            moonraker_url="http://192.168.10.23:7125",
            is_active=False,
        ),
        Printer(
            organization_id=test_org.id,
            name="Manual Other",
            kind=PrinterKind.other,
            moonraker_url=None,
            is_active=True,
        ),
        Printer(
            organization_id=test_org.id,
            name="Cloud-only Bambu",
            kind=PrinterKind.bambu,
            bambu_lan_mode=False,
            bambu_dev_id="cloud-device",
            bambu_dev_ip="192.168.10.24",
            bambu_access_code="abcdefgh",
            is_active=True,
        ),
    ]
    other_org = Organization(name="Other Farm", slug="other-runtime-farm")
    db_session.add_all([moonraker, bambu, *unsupported, other_org])
    db_session.flush()
    db_session.add(
        Printer(
            organization_id=other_org.id,
            name="Foreign Moonraker",
            kind=PrinterKind.other,
            moonraker_url="http://10.0.0.50:7125",
            is_active=True,
        )
    )
    db_session.commit()

    token = _pair_agent(
        client,
        auth_headers,
        scopes=["agent:connect", "status:write"],
    )
    response = client.get("/api/agent/v2/runtime-config", headers=_agent_headers(token))

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["organization_id"] == test_org.id
    assert body["artifact_hosts"] == [
        "api.monofarm.test",
        "updates.monofarm.test",
        "r2.monofarm.test",
    ]
    assert [item["id"] for item in body["printers"]] == [moonraker.id, bambu.id]
    assert body["printers"] == [
        {
            "transport": "moonraker",
            "id": moonraker.id,
            "name": "U1 Local",
            "kind": "snapmaker_u1",
            "moonraker_url": "http://192.168.10.21:7125",
        },
        {
            "transport": "bambu_lan",
            "id": bambu.id,
            "name": "A1 Mini Local",
            "kind": "bambu",
            "dev_id": "01P00A123456789",
            "ip": "192.168.10.22",
            "access_code": "12345678",
            "model": "N1",
        },
    ]
    serialized = response.text
    assert "Foreign Moonraker" not in serialized
    assert "Cloud-only Bambu" not in serialized


def test_runtime_config_requires_agent_status_scope(
    client,
    admin_token: str,
    auth_headers: dict[str, str],
) -> None:
    agent_without_scope = _pair_agent(
        client,
        auth_headers,
        scopes=["agent:connect"],
    )

    user_response = client.get(
        "/api/agent/v2/runtime-config",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    missing_scope = client.get(
        "/api/agent/v2/runtime-config",
        headers=_agent_headers(agent_without_scope),
    )

    assert user_response.status_code == 401
    assert missing_scope.status_code == 403


def test_v2_telegram_routes_use_agent_auth_and_preserve_legacy_user_routes(
    client,
    db_session: Session,
    test_org: Organization,
    auth_headers: dict[str, str],
) -> None:
    test_org.tg_bot_token = "123456:agent-bot-token"
    test_org.tg_bot_username = "old_bot"
    db_session.commit()
    token = _pair_agent(
        client,
        auth_headers,
        scopes=["agent:connect", "status:write"],
    )
    headers = _agent_headers(token)

    v2_config = client.get("/api/agent/v2/tg-config", headers=headers)
    legacy_config = client.get("/api/agent/tg-config", headers=auth_headers)
    report = client.post(
        "/api/agent/v2/tg-report-username",
        headers=headers,
        json={"username": "@new_bot"},
    )
    command = client.post(
        "/api/agent/v2/tg-command",
        headers=headers,
        json={"command": "start", "chat_id": 987654, "args": []},
    )

    assert v2_config.status_code == 200
    assert v2_config.json() == {"token": "123456:agent-bot-token", "username": "old_bot"}
    assert legacy_config.status_code == 200
    assert legacy_config.json() == v2_config.json()
    assert report.status_code == 200
    assert report.json() == {"ok": True}
    db_session.refresh(test_org)
    assert test_org.tg_bot_username == "new_bot"
    assert command.status_code == 200
    assert command.json()["parse_mode"] is None
    assert "не привʼязаний" in command.json()["text"]


def test_v2_telegram_start_cannot_link_a_user_from_another_org(
    client,
    db_session: Session,
    test_org: Organization,
    auth_headers: dict[str, str],
) -> None:
    other_org = Organization(name="Other Telegram Farm", slug="other-tg-farm")
    db_session.add(other_org)
    db_session.flush()
    foreign_user = User(
        organization_id=other_org.id,
        email="foreign-tg@example.com",
        password_hash=hash_password("test-password"),
        name="Foreign Telegram User",
        role=UserRole.operator,
        is_active=True,
        telegram_link_code="foreign-link-code",
        telegram_link_expires_at=datetime.now(timezone.utc) + timedelta(minutes=10),
    )
    db_session.add(foreign_user)
    db_session.commit()
    token = _pair_agent(
        client,
        auth_headers,
        scopes=["agent:connect", "status:write"],
    )

    response = client.post(
        "/api/agent/v2/tg-command",
        headers=_agent_headers(token),
        json={"command": "start", "chat_id": 424242, "args": ["foreign-link-code"]},
    )

    assert response.status_code == 200
    assert "Невірний код" in response.json()["text"]
    db_session.refresh(foreign_user)
    assert foreign_user.telegram_chat_id is None
    assert foreign_user.telegram_link_code == "foreign-link-code"


def test_v2_telegram_rejects_user_tokens_and_requires_status_scope(
    client,
    admin_token: str,
    auth_headers: dict[str, str],
) -> None:
    token = _pair_agent(client, auth_headers, scopes=["agent:connect"])

    user_response = client.get(
        "/api/agent/v2/tg-config",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    agent_response = client.get("/api/agent/v2/tg-config", headers=_agent_headers(token))

    assert user_response.status_code == 401
    assert agent_response.status_code == 403
