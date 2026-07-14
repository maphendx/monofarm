from __future__ import annotations

import base64
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from uuid import UUID

import pytest
from fastapi import WebSocketDisconnect
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.security import create_access_token, hash_password
from app.api import agent as agent_api
from app.models.agent import AgentCommand, AgentCommandState, AgentDevice, AgentEvent
from app.models.organization import Organization
from app.models.user import User, UserRole
from app.services.agent_auth import decode_agent_access_token, resolve_agent_access_token


def _headers(user: User) -> dict[str, str]:
    token = create_access_token(subject=str(user.id), role=user.role.value, org_id=user.organization_id)
    return {"Authorization": f"Bearer {token}"}


def _second_org_admin(db: Session) -> tuple[Organization, User]:
    org = Organization(name="Second Farm", slug="second-farm")
    db.add(org)
    db.flush()
    user = User(
        organization_id=org.id,
        email="second-admin@example.com",
        password_hash=hash_password("test-password"),
        name="Second Admin",
        role=UserRole.admin,
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(org)
    db.refresh(user)
    return org, user


def _create_pairing(client, headers: dict[str, str], name: str = "Farm PC") -> dict:
    response = client.post(
        "/api/agent/devices/pairing-codes",
        headers=headers,
        json={
            "name": name,
            "site_id": "main",
            "scopes": ["agent:connect", "commands:read", "events:write", "status:write"],
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def _pair_device(client, pairing_code: str) -> dict:
    response = client.post(
        "/api/agent/v2/pair",
        json={
            "pairing_code": pairing_code,
            "public_key": base64.b64encode(bytes([1]) * 32).decode("ascii"),
            "capabilities": ["moonraker", "bambu_lan"],
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_admin_pairing_is_single_use_and_secrets_are_only_returned_once(
    client,
    db_session: Session,
    auth_headers: dict[str, str],
) -> None:
    created = _create_pairing(client, auth_headers)
    device_id = UUID(created["device"]["id"])

    assert created["pairing_code"].startswith("mf_pair_")
    assert "pairing_code_hash" not in created["device"]
    assert "credential_hash" not in created["device"]

    paired = _pair_device(client, created["pairing_code"])
    assert paired["device_id"] == str(device_id)
    assert paired["device_secret"].startswith("mf_agent_")
    assert decode_agent_access_token(paired["access_token"], required_scopes={"agent:connect"}) is not None

    row = db_session.get(AgentDevice, device_id)
    assert row is not None
    assert row.credential_hash != paired["device_secret"]
    assert row.pairing_code_hash is None
    assert row.paired_at is not None

    replay = client.post(
        "/api/agent/v2/pair",
        json={
            "pairing_code": created["pairing_code"],
            "public_key": base64.b64encode(bytes([2]) * 32).decode("ascii"),
            "capabilities": [],
        },
    )
    assert replay.status_code == 409

    listed = client.get("/api/agent/devices", headers=auth_headers)
    assert listed.status_code == 200
    assert listed.json()[0]["id"] == str(device_id)
    serialized = str(listed.json())
    assert "pairing_code" not in serialized
    assert "credential_hash" not in serialized
    assert "device_secret" not in serialized


def test_only_tenant_admin_can_manage_devices_and_queries_are_org_scoped(
    client,
    db_session: Session,
    auth_headers: dict[str, str],
    operator_user: User,
) -> None:
    created = _create_pairing(client, auth_headers)
    device_id = created["device"]["id"]
    _, second_admin = _second_org_admin(db_session)

    operator_response = client.post(
        "/api/agent/devices/pairing-codes",
        headers=_headers(operator_user),
        json={"name": "Forbidden"},
    )
    cross_org_get = client.get(f"/api/agent/devices/{device_id}", headers=_headers(second_admin))
    cross_org_revoke = client.post(f"/api/agent/devices/{device_id}/revoke", headers=_headers(second_admin))

    assert operator_response.status_code == 403
    assert cross_org_get.status_code == 404
    assert cross_org_revoke.status_code == 404


def test_device_secret_mints_short_lived_token_and_revocation_invalidates_both(
    client,
    db_session: Session,
    auth_headers: dict[str, str],
) -> None:
    created = _create_pairing(client, auth_headers)
    paired = _pair_device(client, created["pairing_code"])
    device_id = UUID(paired["device_id"])

    token_response = client.post(
        "/api/agent/v2/token",
        json={"device_id": str(device_id), "device_secret": paired["device_secret"]},
    )
    wrong_secret = client.post(
        "/api/agent/v2/token",
        json={"device_id": str(device_id), "device_secret": "mf_agent_" + "x" * 32},
    )

    assert token_response.status_code == 200
    assert wrong_secret.status_code == 401
    access_token = token_response.json()["access_token"]
    device = resolve_agent_access_token(db_session, access_token, required_scopes={"agent:connect"})
    assert device is not None
    assert device.id == device_id

    revoked = client.post(f"/api/agent/devices/{device_id}/revoke", headers=auth_headers)
    assert revoked.status_code == 200
    assert revoked.json()["revoked_at"] is not None
    assert "credential_hash" not in revoked.json()
    assert resolve_agent_access_token(db_session, access_token, required_scopes={"agent:connect"}) is None

    after_revoke = client.post(
        "/api/agent/v2/token",
        json={"device_id": str(device_id), "device_secret": paired["device_secret"]},
    )
    assert after_revoke.status_code == 401


def test_pairing_rejects_non_base64_or_wrong_length_ed25519_public_key(
    client,
    auth_headers: dict[str, str],
) -> None:
    malformed_pairing = _create_pairing(client, auth_headers, name="Malformed Key Agent")
    wrong_length_pairing = _create_pairing(client, auth_headers, name="Short Key Agent")

    malformed = client.post(
        "/api/agent/v2/pair",
        json={
            "pairing_code": malformed_pairing["pairing_code"],
            "public_key": "ed25519:" + "a" * 64,
            "capabilities": [],
        },
    )
    wrong_length = client.post(
        "/api/agent/v2/pair",
        json={
            "pairing_code": wrong_length_pairing["pairing_code"],
            "public_key": "YWJjZA==",
            "capabilities": [],
        },
    )

    assert malformed.status_code == 422
    assert wrong_length.status_code == 422


def test_v1_and_v2_websocket_auth_are_explicitly_separated(
    client,
    db_session: Session,
    admin_token: str,
    auth_headers: dict[str, str],
    monkeypatch,
) -> None:
    @contextmanager
    def fresh_session():
        yield db_session

    monkeypatch.setattr(agent_api, "_fresh_agent_session", fresh_session)

    # Existing installations without a paired device retain the migration
    # route until they enroll protocol v2.
    with client.websocket_connect(f"/api/agent/connect?token={admin_token}") as websocket:
        websocket.send_json({"type": "AGENT_HELLO", "version": "test", "capabilities": []})

    created = _create_pairing(client, auth_headers)
    paired = _pair_device(client, created["pairing_code"])
    agent_token = paired["access_token"]

    # Once any active paired device exists, broad user JWTs can no longer open
    # an organization-wide physical control tunnel.
    with pytest.raises(WebSocketDisconnect) as paired_org_on_v1:
        with client.websocket_connect(f"/api/agent/connect?token={admin_token}"):
            pass
    assert paired_org_on_v1.value.code == 4003

    with client.websocket_connect(f"/api/agent/v2/connect?token={agent_token}") as websocket:
        websocket.send_json({"type": "AGENT_HELLO", "version": "test", "capabilities": []})

    with client.websocket_connect(
        "/api/agent/v2/connect",
        headers={"Authorization": f"Bearer {agent_token}"},
    ) as websocket:
        websocket.send_json({"type": "AGENT_HELLO", "version": "test", "capabilities": []})

    with pytest.raises(WebSocketDisconnect) as user_on_v2:
        with client.websocket_connect(f"/api/agent/v2/connect?token={admin_token}"):
            pass
    assert user_on_v2.value.code == 4001

    with pytest.raises(WebSocketDisconnect) as agent_on_v1:
        with client.websocket_connect(f"/api/agent/connect?token={agent_token}"):
            pass
    assert agent_on_v1.value.code == 4001


def test_v2_websocket_authorizes_each_message_instead_of_rejecting_connect_only_token(
    client,
    db_session: Session,
    auth_headers: dict[str, str],
    monkeypatch,
) -> None:
    @contextmanager
    def fresh_session():
        yield db_session

    monkeypatch.setattr(agent_api, "_fresh_agent_session", fresh_session)
    pairing = client.post(
        "/api/agent/devices/pairing-codes",
        headers=auth_headers,
        json={"name": "Connect-only agent", "scopes": ["agent:connect"]},
    )
    assert pairing.status_code == 201, pairing.text
    paired = _pair_device(client, pairing.json()["pairing_code"])

    with client.websocket_connect(
        "/api/agent/v2/connect",
        headers={"Authorization": f"Bearer {paired['access_token']}"},
    ) as websocket:
        websocket.send_json({"type": "AGENT_HELLO", "version": "test", "capabilities": []})
        websocket.send_json(
            {
                "type": "STATUS_PUSH",
                "url": "http://192.168.90.10:7125",
                "status": {"print_stats": {"state": "standby"}},
            }
        )
        with pytest.raises(WebSocketDisconnect) as rejected:
            websocket.receive_text()

    assert rejected.value.code == 4003


def test_legacy_websocket_requires_a_current_active_org_admin(
    client,
    db_session: Session,
    test_org: Organization,
    operator_user: User,
    monkeypatch,
) -> None:
    @contextmanager
    def fresh_session():
        yield db_session

    monkeypatch.setattr(agent_api, "_fresh_agent_session", fresh_session)
    inactive_admin = User(
        organization_id=test_org.id,
        email="inactive-agent-admin@example.com",
        password_hash=hash_password("test-password"),
        name="Inactive Agent Admin",
        role=UserRole.admin,
        is_active=True,
    )
    db_session.add(inactive_admin)
    db_session.commit()
    stale_token = create_access_token(
        subject=str(inactive_admin.id),
        role=inactive_admin.role.value,
        org_id=test_org.id,
    )
    inactive_admin.is_active = False
    db_session.commit()

    operator_token = create_access_token(
        subject=str(operator_user.id),
        role=operator_user.role.value,
        org_id=test_org.id,
    )
    for token in (operator_token, stale_token):
        with pytest.raises(WebSocketDisconnect) as rejected:
            with client.websocket_connect(f"/api/agent/connect?token={token}"):
                pass
        assert rejected.value.code == 4003


def test_agent_command_and_event_foundation_persists_and_enforces_replay_keys(
    db_session: Session,
    test_org: Organization,
    admin_user: User,
) -> None:
    device = AgentDevice(
        organization_id=test_org.id,
        name="Persistence Agent",
        scopes=["agent:connect"],
        created_by_user_id=admin_user.id,
    )
    db_session.add(device)
    db_session.flush()

    command = AgentCommand(
        organization_id=test_org.id,
        agent_device_id=device.id,
        command_type="printer.pause",
        payload_json={"printer_id": 7},
        idempotency_key="pause-7-once",
        state=AgentCommandState.queued,
        deadline_at=datetime.now(timezone.utc) + timedelta(minutes=1),
    )
    db_session.add(command)
    db_session.flush()
    event = AgentEvent(
        organization_id=test_org.id,
        agent_device_id=device.id,
        command_id=command.id,
        event_stream_id=device.id,
        monotonic_sequence=1,
        event_type="command.accepted",
        payload_json={},
        occurred_at_device=datetime.now(timezone.utc),
    )
    db_session.add(event)
    db_session.commit()

    assert db_session.get(AgentCommand, command.id).state == AgentCommandState.queued
    assert db_session.get(AgentEvent, event.id).monotonic_sequence == 1

    with pytest.raises(IntegrityError):
        with db_session.begin_nested():
            db_session.add(
                AgentCommand(
                    organization_id=test_org.id,
                    agent_device_id=device.id,
                    command_type="printer.pause",
                    payload_json={},
                    idempotency_key="pause-7-once",
                    state=AgentCommandState.queued,
                    deadline_at=datetime.now(timezone.utc) + timedelta(minutes=1),
                )
            )
            db_session.flush()
