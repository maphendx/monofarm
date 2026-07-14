from __future__ import annotations

import asyncio
import base64
from contextlib import contextmanager
from unittest.mock import AsyncMock
from uuid import UUID

import pytest
from sqlalchemy.orm import Session

from app.api import agent as agent_api
from app.models.agent import AgentDevice


def _paired_device(client, auth_headers: dict[str, str]) -> tuple[UUID, str]:
    pairing = client.post(
        "/api/agent/devices/pairing-codes",
        headers=auth_headers,
        json={"name": "Watchdog Agent", "scopes": ["agent:connect"]},
    )
    assert pairing.status_code == 201, pairing.text
    paired = client.post(
        "/api/agent/v2/pair",
        json={
            "pairing_code": pairing.json()["pairing_code"],
            "public_key": base64.b64encode(bytes([5]) * 32).decode("ascii"),
            "capabilities": [],
        },
    )
    assert paired.status_code == 201, paired.text
    return UUID(paired.json()["device_id"]), paired.json()["access_token"]


@pytest.mark.parametrize("invalidator", ["revoke", "rotate"])
def test_open_v2_socket_watchdog_closes_revoked_or_rotated_credentials_using_fresh_session(
    client,
    db_session: Session,
    test_org,
    auth_headers: dict[str, str],
    monkeypatch,
    invalidator: str,
) -> None:
    device_id, _ = _paired_device(client, auth_headers)
    device = db_session.get(AgentDevice, device_id)
    assert device is not None
    expected_version = device.credential_version
    if invalidator == "revoke":
        device.revoked_at = agent_api.datetime.now(agent_api.timezone.utc)
    else:
        device.credential_version += 1
    db_session.commit()

    opens = 0

    @contextmanager
    def fresh_session():
        nonlocal opens
        opens += 1
        yield db_session

    monkeypatch.setattr(agent_api, "_fresh_agent_session", fresh_session)
    monkeypatch.setattr(agent_api, "AGENT_CREDENTIAL_WATCHDOG_INTERVAL_SECONDS", 0)
    websocket = AsyncMock()

    asyncio.run(
        agent_api._watch_agent_credential(
            websocket,
            device_id=device_id,
            organization_id=test_org.id,
            credential_version=expected_version,
        )
    )

    assert opens == 1
    websocket.close.assert_awaited_once_with(code=4003, reason="Agent credential revoked")


def test_agent_hello_persistence_opens_its_own_session(
    client,
    db_session: Session,
    auth_headers: dict[str, str],
    monkeypatch,
) -> None:
    device_id, _ = _paired_device(client, auth_headers)
    device = db_session.get(AgentDevice, device_id)
    assert device is not None
    opens = 0

    @contextmanager
    def fresh_session():
        nonlocal opens
        opens += 1
        yield db_session

    monkeypatch.setattr(agent_api, "_fresh_agent_session", fresh_session)

    agent_api._persist_agent_hello(
        device_id=device.id,
        organization_id=device.organization_id,
        data={
            "type": "AGENT_HELLO",
            "version": "0.9.0",
            "build": "test-build",
            "capabilities": ["one", "two"],
        },
    )

    assert opens == 1
    db_session.refresh(device)
    assert device.version == "0.9.0"
    assert device.build == "test-build"
    assert device.capabilities == ["one", "two"]


def test_open_v2_socket_watchdog_fails_closed_when_credential_store_is_unavailable(
    client,
    db_session: Session,
    auth_headers: dict[str, str],
    monkeypatch,
) -> None:
    device_id, _ = _paired_device(client, auth_headers)
    device = db_session.get(AgentDevice, device_id)
    assert device is not None

    @contextmanager
    def broken_session():
        raise RuntimeError("database unavailable")
        yield db_session

    monkeypatch.setattr(agent_api, "_fresh_agent_session", broken_session)
    monkeypatch.setattr(agent_api, "AGENT_CREDENTIAL_WATCHDOG_INTERVAL_SECONDS", 0)
    websocket = AsyncMock()

    asyncio.run(
        agent_api._watch_agent_credential(
            websocket,
            device_id=device.id,
            organization_id=device.organization_id,
            credential_version=device.credential_version,
        )
    )

    websocket.close.assert_awaited_once_with(
        code=1011,
        reason="Unable to validate agent credential",
    )
