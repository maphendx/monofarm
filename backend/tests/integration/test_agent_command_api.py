from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from sqlalchemy.orm import Session

from app.core.security import create_access_token, hash_password
from app.models.agent import AgentCommand, AgentCommandState, AgentDevice, AgentEvent
from app.models.organization import Organization
from app.models.printer import Printer, PrinterKind
from app.models.user import User, UserRole


ALL_AGENT_SCOPES = ["agent:connect", "commands:read", "events:write", "status:write"]
EVENT_STREAM_ID = "019f0000-0000-7000-8000-000000000100"
RECREATED_EVENT_STREAM_ID = "019f0000-0000-7000-8000-000000000101"
INVALID_EVENT_STREAM_ID = "019f0000-0000-7000-8000-000000000102"


def _user_headers(user: User) -> dict[str, str]:
    token = create_access_token(subject=str(user.id), role=user.role.value, org_id=user.organization_id)
    return {"Authorization": f"Bearer {token}"}


def _agent_headers(access_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {access_token}"}


def _pair_agent(
    client,
    auth_headers: dict[str, str],
    *,
    name: str = "Farm Agent",
    scopes: list[str] | None = None,
) -> dict:
    pairing = client.post(
        "/api/agent/devices/pairing-codes",
        headers=auth_headers,
        json={"name": name, "scopes": scopes or ALL_AGENT_SCOPES},
    )
    assert pairing.status_code == 201, pairing.text
    paired = client.post(
        "/api/agent/v2/pair",
        json={
            "pairing_code": pairing.json()["pairing_code"],
            "public_key": base64.b64encode(uuid4().bytes + uuid4().bytes).decode("ascii"),
            "capabilities": ["durable_commands", "event_outbox"],
        },
    )
    assert paired.status_code == 201, paired.text
    return paired.json()


def _printer(
    db: Session,
    org: Organization,
    *,
    name: str = "Printer",
    agent_device_id: str | None = None,
) -> Printer:
    printer = Printer(
        organization_id=org.id,
        agent_device_id=UUID(agent_device_id) if agent_device_id else None,
        name=name,
        kind=PrinterKind.other,
        is_active=True,
    )
    db.add(printer)
    db.commit()
    db.refresh(printer)
    return printer


def _second_org(db: Session) -> tuple[Organization, User, Printer]:
    suffix = uuid4().hex[:8]
    org = Organization(name="Other Farm", slug=f"other-farm-{suffix}")
    db.add(org)
    db.flush()
    admin = User(
        organization_id=org.id,
        email=f"other-admin-{suffix}@example.com",
        password_hash=hash_password("test-password"),
        name="Other Admin",
        role=UserRole.admin,
        is_active=True,
    )
    printer = Printer(organization_id=org.id, name="Other Printer", kind=PrinterKind.other)
    db.add_all([admin, printer])
    db.commit()
    db.refresh(org)
    db.refresh(admin)
    db.refresh(printer)
    return org, admin, printer


def _command_body(
    device_id: str,
    printer_id: int | None,
    *,
    idempotency_key: str = "command-once",
    deadline_at: datetime | None = None,
) -> dict:
    return {
        "agent_device_id": device_id,
        "printer_id": printer_id,
        "command_type": "printer.start",
        "payload": {"file_name": "part.3mf", "priority": 2},
        "idempotency_key": idempotency_key,
        "deadline_at": (deadline_at or datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
    }


def _create_command(client, auth_headers: dict[str, str], body: dict) -> dict:
    response = client.post("/api/agent/commands", headers=auth_headers, json=body)
    assert response.status_code == 201, response.text
    return response.json()


def test_admin_command_create_is_tenant_scoped_and_idempotent(
    client,
    db_session: Session,
    test_org: Organization,
    auth_headers: dict[str, str],
    operator_user: User,
) -> None:
    paired = _pair_agent(client, auth_headers)
    printer = _printer(db_session, test_org)
    body = _command_body(paired["device_id"], printer.id)

    created = client.post("/api/agent/commands", headers=auth_headers, json=body)
    replayed = client.post("/api/agent/commands", headers=auth_headers, json=body)
    conflict = client.post(
        "/api/agent/commands",
        headers=auth_headers,
        json={**body, "payload": {"file_name": "other.3mf"}},
    )
    forbidden = client.post(
        "/api/agent/commands",
        headers=_user_headers(operator_user),
        json={**body, "idempotency_key": "operator-command"},
    )

    assert created.status_code == 201
    assert replayed.status_code == 200
    assert replayed.json()["id"] == created.json()["id"]
    assert replayed.json()["payload"] == body["payload"]
    assert len(replayed.json()["payload_sha256"]) == 64
    assert conflict.status_code == 409
    assert forbidden.status_code == 403
    assert (
        db_session.query(AgentCommand)
        .filter(
            AgentCommand.organization_id == test_org.id,
            AgentCommand.idempotency_key == body["idempotency_key"],
        )
        .count()
        == 1
    )


def test_admin_command_create_rejects_foreign_or_revoked_targets_and_invalid_body(
    client,
    db_session: Session,
    test_org: Organization,
    auth_headers: dict[str, str],
) -> None:
    paired = _pair_agent(client, auth_headers)
    printer = _printer(db_session, test_org)
    other_org, other_admin, other_printer = _second_org(db_session)
    other_pair = _pair_agent(client, _user_headers(other_admin), name="Other Agent")

    foreign_device = client.post(
        "/api/agent/commands",
        headers=auth_headers,
        json=_command_body(other_pair["device_id"], printer.id, idempotency_key="foreign-device"),
    )
    foreign_printer = client.post(
        "/api/agent/commands",
        headers=auth_headers,
        json=_command_body(paired["device_id"], other_printer.id, idempotency_key="foreign-printer"),
    )
    wrong_digest = client.post(
        "/api/agent/commands",
        headers=auth_headers,
        json={
            **_command_body(
                paired["device_id"],
                printer.id,
                idempotency_key="wrong-digest",
            ),
            "payload_sha256": "0" * 64,
        },
    )
    unknown_command_type = client.post(
        "/api/agent/commands",
        headers=auth_headers,
        json={
            **_command_body(
                paired["device_id"],
                printer.id,
                idempotency_key="unknown-command-type",
            ),
            "command_type": "shell.exec",
        },
    )

    revoked = db_session.get(AgentDevice, UUID(paired["device_id"]))
    assert revoked is not None
    revoked.revoked_at = datetime.now(timezone.utc)
    db_session.commit()
    revoked_device = client.post(
        "/api/agent/commands",
        headers=auth_headers,
        json=_command_body(paired["device_id"], printer.id, idempotency_key="revoked-device"),
    )
    expired = client.post(
        "/api/agent/commands",
        headers=auth_headers,
        json=_command_body(
            paired["device_id"],
            printer.id,
            idempotency_key="expired",
            deadline_at=datetime.now(timezone.utc) - timedelta(seconds=1),
        ),
    )
    unknown_field = client.post(
        "/api/agent/commands",
        headers=auth_headers,
        json={**_command_body(paired["device_id"], printer.id), "organization_id": other_org.id},
    )
    wrong_type = client.post(
        "/api/agent/commands",
        headers=auth_headers,
        json={**_command_body(paired["device_id"], printer.id), "printer_id": str(printer.id)},
    )
    assert foreign_device.status_code == 404
    assert foreign_printer.status_code == 404
    assert revoked_device.status_code == 409
    assert expired.status_code == 422
    assert unknown_field.status_code == 422
    assert wrong_type.status_code == 422
    assert wrong_digest.status_code == 422
    assert unknown_command_type.status_code == 422


def test_agent_pull_leases_only_its_pending_commands_and_releases_expired_lease(
    client,
    db_session: Session,
    test_org: Organization,
    auth_headers: dict[str, str],
) -> None:
    first_agent = _pair_agent(client, auth_headers, name="First Agent")
    second_agent = _pair_agent(client, auth_headers, name="Second Agent")
    printer = _printer(
        db_session,
        test_org,
        name="First Printer",
        agent_device_id=first_agent["device_id"],
    )
    second_printer = _printer(
        db_session,
        test_org,
        name="Second Printer",
        agent_device_id=second_agent["device_id"],
    )
    first = _create_command(
        client,
        auth_headers,
        _command_body(first_agent["device_id"], printer.id, idempotency_key="first-command"),
    )
    _create_command(
        client,
        auth_headers,
        _command_body(second_agent["device_id"], second_printer.id, idempotency_key="second-command"),
    )
    expired = AgentCommand(
        organization_id=test_org.id,
        agent_device_id=UUID(first_agent["device_id"]),
        printer_id=printer.id,
        command_type="printer.status",
        payload_json={},
        payload_sha256="0" * 64,
        idempotency_key="already-expired",
        state=AgentCommandState.queued,
        deadline_at=datetime.now(timezone.utc) - timedelta(seconds=1),
    )
    db_session.add(expired)
    db_session.commit()

    pulled = client.post(
        "/api/agent/v2/commands/pull",
        headers=_agent_headers(first_agent["access_token"]),
        json={"limit": 10, "lease_seconds": 30},
    )
    immediate_retry = client.post(
        "/api/agent/v2/commands/pull",
        headers=_agent_headers(first_agent["access_token"]),
        json={"limit": 10, "lease_seconds": 30},
    )

    assert pulled.status_code == 200, pulled.text
    assert [item["id"] for item in pulled.json()["commands"]] == [first["id"]]
    assert pulled.json()["commands"][0]["state"] == "leased"
    assert pulled.json()["commands"][0]["attempt"] == 1
    assert pulled.json()["commands"][0]["payload"] == first["payload"]
    assert immediate_retry.status_code == 200
    assert immediate_retry.json()["commands"] == []

    expired_row = db_session.get(AgentCommand, expired.id)
    assert expired_row is not None
    assert expired_row.state is AgentCommandState.failed
    assert expired_row.last_error == "deadline_expired"

    leased_row = db_session.get(AgentCommand, UUID(first["id"]))
    assert leased_row is not None
    leased_row.lease_expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    db_session.commit()
    released = client.post(
        "/api/agent/v2/commands/pull",
        headers=_agent_headers(first_agent["access_token"]),
        json={"limit": 1, "lease_seconds": 30},
    )
    assert released.status_code == 200
    assert released.json()["commands"][0]["id"] == first["id"]
    assert released.json()["commands"][0]["attempt"] == 2


def test_agent_pull_requires_scoped_device_bearer_and_strict_body(
    client,
    auth_headers: dict[str, str],
) -> None:
    unscoped = _pair_agent(
        client,
        auth_headers,
        name="Events Only",
        scopes=["agent:connect", "events:write"],
    )
    no_scope = client.post(
        "/api/agent/v2/commands/pull",
        headers=_agent_headers(unscoped["access_token"]),
        json={"limit": 1, "lease_seconds": 30},
    )
    user_token = client.post(
        "/api/agent/v2/commands/pull",
        headers=auth_headers,
        json={"limit": 1, "lease_seconds": 30},
    )

    assert no_scope.status_code == 403
    assert user_token.status_code == 401
    # Authentication runs before body validation, so use a fully scoped token for 422 checks.
    scoped = _pair_agent(client, auth_headers, name="Scoped Agent")
    unknown = client.post(
        "/api/agent/v2/commands/pull",
        headers=_agent_headers(scoped["access_token"]),
        json={"limit": 1, "lease_seconds": 30, "cursor": "unexpected"},
    )
    wrong_type = client.post(
        "/api/agent/v2/commands/pull",
        headers=_agent_headers(scoped["access_token"]),
        json={"limit": "1", "lease_seconds": 30},
    )
    assert unknown.status_code == 422
    assert wrong_type.status_code == 422


def test_active_command_heartbeat_keeps_lease_and_crashed_work_is_released(
    client,
    db_session: Session,
    test_org: Organization,
    auth_headers: dict[str, str],
) -> None:
    paired = _pair_agent(client, auth_headers, name="Crash Recovery Agent")
    printer = _printer(db_session, test_org, agent_device_id=paired["device_id"])
    command = _create_command(
        client,
        auth_headers,
        _command_body(
            paired["device_id"],
            printer.id,
            idempotency_key="crash-recovery-command",
        ),
    )
    headers = _agent_headers(paired["access_token"])
    pull_url = "/api/agent/v2/commands/pull"
    ack_url = f"/api/agent/v2/commands/{command['id']}/ack"

    assert client.post(
        pull_url,
        headers=headers,
        json={"limit": 1, "lease_seconds": 30},
    ).status_code == 200
    assert client.post(
        ack_url,
        headers=headers,
        json={"state": "accepted", "attempt": 1},
    ).status_code == 200
    assert client.post(
        ack_url,
        headers=headers,
        json={"state": "executing", "attempt": 1},
    ).status_code == 200

    row = db_session.get(AgentCommand, UUID(command["id"]))
    assert row is not None
    first_deadline = row.lease_expires_at
    assert first_deadline is not None

    heartbeat = client.post(
        ack_url,
        headers=headers,
        json={"state": "executing", "attempt": 1},
    )
    assert heartbeat.status_code == 200
    db_session.refresh(row)
    assert row.lease_expires_at is not None
    assert row.lease_expires_at >= first_deadline

    row.lease_expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    db_session.commit()
    recovered = client.post(
        pull_url,
        headers=headers,
        json={"limit": 1, "lease_seconds": 30},
    )

    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["commands"][0]["id"] == command["id"]
    assert recovered.json()["commands"][0]["state"] == "leased"
    assert recovered.json()["commands"][0]["attempt"] == 2


def test_agent_command_ack_enforces_attempt_device_and_monotonic_state_machine(
    client,
    db_session: Session,
    test_org: Organization,
    auth_headers: dict[str, str],
) -> None:
    agent = _pair_agent(client, auth_headers, name="Command Agent")
    other_agent = _pair_agent(client, auth_headers, name="Other Command Agent")
    printer = _printer(db_session, test_org, agent_device_id=agent["device_id"])
    command = _create_command(
        client,
        auth_headers,
        _command_body(agent["device_id"], printer.id, idempotency_key="ack-command"),
    )
    pull = client.post(
        "/api/agent/v2/commands/pull",
        headers=_agent_headers(agent["access_token"]),
        json={"limit": 1, "lease_seconds": 30},
    )
    assert pull.status_code == 200
    ack_url = f"/api/agent/v2/commands/{command['id']}/ack"
    headers = _agent_headers(agent["access_token"])

    skipped = client.post(ack_url, headers=headers, json={"state": "executing", "attempt": 1})
    accepted = client.post(ack_url, headers=headers, json={"state": "accepted", "attempt": 1})
    executing = client.post(ack_url, headers=headers, json={"state": "executing", "attempt": 1})
    stale = client.post(ack_url, headers=headers, json={"state": "delivered", "attempt": 2})
    regressed = client.post(ack_url, headers=headers, json={"state": "accepted", "attempt": 1})
    delivered = client.post(ack_url, headers=headers, json={"state": "delivered", "attempt": 1})
    printer_ack = client.post(ack_url, headers=headers, json={"state": "printer_ack", "attempt": 1})
    terminal = client.post(ack_url, headers=headers, json={"state": "terminal", "attempt": 1})
    terminal_replay = client.post(ack_url, headers=headers, json={"state": "terminal", "attempt": 1})
    after_terminal = client.post(
        ack_url,
        headers=headers,
        json={"state": "failed", "attempt": 1, "last_error": "too late"},
    )
    other_device = client.post(
        ack_url,
        headers=_agent_headers(other_agent["access_token"]),
        json={"state": "terminal", "attempt": 1},
    )

    assert skipped.status_code == 409
    assert accepted.status_code == 200
    assert executing.status_code == 200
    assert stale.status_code == 409
    assert regressed.status_code == 409
    assert delivered.status_code == 200
    assert printer_ack.status_code == 200
    assert terminal.status_code == 200
    assert terminal.json()["state"] == "terminal"
    assert terminal_replay.status_code == 200
    assert after_terminal.status_code == 409
    assert other_device.status_code == 404

    unknown_state = client.post(ack_url, headers=headers, json={"state": "succeeded", "attempt": 1})
    wrong_attempt_type = client.post(ack_url, headers=headers, json={"state": "terminal", "attempt": "1"})
    missing_error = client.post(
        ack_url,
        headers=headers,
        json={"state": "needs_reconcile", "attempt": 1},
    )
    unexpected_error = client.post(
        ack_url,
        headers=headers,
        json={"state": "terminal", "attempt": 1, "last_error": "unexpected"},
    )
    assert unknown_state.status_code == 422
    assert wrong_attempt_type.status_code == 422
    assert missing_error.status_code == 422
    assert unexpected_error.status_code == 422


def test_agent_command_ack_supports_failure_and_explicit_reconciliation_branches(
    client,
    db_session: Session,
    test_org: Organization,
    auth_headers: dict[str, str],
) -> None:
    agent = _pair_agent(client, auth_headers, name="Recovery Agent")
    printer = _printer(db_session, test_org)
    reconcile_command = _create_command(
        client,
        auth_headers,
        _command_body(agent["device_id"], printer.id, idempotency_key="reconcile-command"),
    )
    rejected_command = _create_command(
        client,
        auth_headers,
        _command_body(agent["device_id"], printer.id, idempotency_key="rejected-command"),
    )
    headers = _agent_headers(agent["access_token"])
    pull = client.post(
        "/api/agent/v2/commands/pull",
        headers=headers,
        json={"limit": 2, "lease_seconds": 30},
    )
    assert pull.status_code == 200

    reconcile_url = f"/api/agent/v2/commands/{reconcile_command['id']}/ack"
    assert client.post(
        reconcile_url,
        headers=headers,
        json={"state": "accepted", "attempt": 1},
    ).status_code == 200
    assert client.post(
        reconcile_url,
        headers=headers,
        json={"state": "executing", "attempt": 1},
    ).status_code == 200
    ambiguous = client.post(
        reconcile_url,
        headers=headers,
        json={
            "state": "needs_reconcile",
            "attempt": 1,
            "last_error": "printer ACK timed out",
        },
    )
    retry_after_reconcile = client.post(
        reconcile_url,
        headers=headers,
        json={"state": "executing", "attempt": 1},
    )
    failed = client.post(
        reconcile_url,
        headers=headers,
        json={"state": "failed", "attempt": 1, "last_error": "printer rejected job"},
    )
    rejected = client.post(
        f"/api/agent/v2/commands/{rejected_command['id']}/ack",
        headers=headers,
        json={"state": "failed", "attempt": 1, "last_error": "unsupported command"},
    )

    assert ambiguous.status_code == 200
    assert ambiguous.json()["state"] == "needs_reconcile"
    assert retry_after_reconcile.status_code == 200
    assert retry_after_reconcile.json()["state"] == "executing"
    assert failed.status_code == 200
    assert failed.json()["state"] == "failed"
    assert rejected.status_code == 200
    assert rejected.json()["state"] == "failed"


def _event(
    sequence: int | str,
    *,
    command_id: str | None = None,
    printer_id: int | None = None,
    payload: dict | None = None,
) -> dict:
    return {
        "sequence": sequence,
        "command_id": command_id,
        "printer_id": printer_id,
        "event_type": "command.progress",
        "payload": payload or {"progress": 50},
        "occurred_at_device": datetime.now(timezone.utc).isoformat(),
    }


def _event_batch(
    device_id: str,
    events: list[dict],
    *,
    event_stream_id: str = EVENT_STREAM_ID,
) -> dict:
    return {
        "agent_device_id": device_id,
        "event_stream_id": event_stream_id,
        "events": events,
    }


def test_agent_event_batch_is_idempotent_and_reports_contiguous_ack(
    client,
    db_session: Session,
    test_org: Organization,
    auth_headers: dict[str, str],
) -> None:
    agent = _pair_agent(client, auth_headers, name="Event Agent")
    printer = _printer(db_session, test_org)
    command = _create_command(
        client,
        auth_headers,
        _command_body(agent["device_id"], printer.id, idempotency_key="event-command"),
    )
    headers = _agent_headers(agent["access_token"])
    url = "/api/agent/v2/events/batch"
    first = _event(1, command_id=command["id"], printer_id=printer.id)
    second = _event(2, command_id=command["id"], printer_id=printer.id)
    third = _event(3, command_id=command["id"], printer_id=printer.id)

    gap = client.post(
        url,
        headers=headers,
        json=_event_batch(agent["device_id"], [first, third]),
    )
    replay = client.post(
        url,
        headers=headers,
        json=_event_batch(agent["device_id"], [third]),
    )
    fill_gap = client.post(
        url,
        headers=headers,
        json=_event_batch(agent["device_id"], [second]),
    )
    assert gap.status_code == 200, gap.text
    assert gap.json() == {
        "accepted_count": 2,
        "duplicate_count": 0,
        "highest_accepted_sequence": 3,
        "highest_contiguous_sequence": 1,
    }
    assert replay.status_code == 200
    assert replay.json()["accepted_count"] == 0
    assert replay.json()["duplicate_count"] == 1
    assert fill_gap.status_code == 200
    assert fill_gap.json()["accepted_count"] == 1
    assert fill_gap.json()["highest_accepted_sequence"] == 3
    assert fill_gap.json()["highest_contiguous_sequence"] == 3
    assert (
        db_session.query(AgentEvent)
        .filter(AgentEvent.agent_device_id == UUID(agent["device_id"]))
        .count()
        == 3
    )

    conflicting_replay = client.post(
        url,
        headers=headers,
        json={
            **_event_batch(agent["device_id"], [{**third, "payload": {"progress": 99}}]),
        },
    )
    assert conflicting_replay.status_code == 409

    invalid_new_stream = client.post(
        url,
        headers=headers,
        json=_event_batch(
            agent["device_id"],
            [second],
            event_stream_id=INVALID_EVENT_STREAM_ID,
        ),
    )
    recreated = client.post(
        url,
        headers=headers,
        json=_event_batch(
            agent["device_id"],
            [_event(1, command_id=command["id"], printer_id=printer.id)],
            event_stream_id=RECREATED_EVENT_STREAM_ID,
        ),
    )
    retired_replay = client.post(
        url,
        headers=headers,
        json=_event_batch(agent["device_id"], [first]),
    )
    assert invalid_new_stream.status_code == 409
    assert recreated.status_code == 200, recreated.text
    assert recreated.json()["highest_contiguous_sequence"] == 1
    assert retired_replay.status_code == 409


def test_agent_event_batch_rejects_cross_device_org_references_and_bad_types(
    client,
    db_session: Session,
    test_org: Organization,
    auth_headers: dict[str, str],
) -> None:
    agent = _pair_agent(client, auth_headers, name="Event Agent")
    other_agent = _pair_agent(client, auth_headers, name="Other Event Agent")
    printer = _printer(db_session, test_org, agent_device_id=agent["device_id"])
    other_local_printer = _printer(
        db_session,
        test_org,
        name="Other Local Printer",
        agent_device_id=other_agent["device_id"],
    )
    _, _, foreign_printer = _second_org(db_session)
    other_command = _create_command(
        client,
        auth_headers,
        _command_body(
            other_agent["device_id"],
            other_local_printer.id,
            idempotency_key="other-device-command",
        ),
    )
    own_command = _create_command(
        client,
        auth_headers,
        _command_body(agent["device_id"], printer.id, idempotency_key="own-command"),
    )
    headers = _agent_headers(agent["access_token"])
    url = "/api/agent/v2/events/batch"

    cross_device_batch = client.post(
        url,
        headers=headers,
        json=_event_batch(other_agent["device_id"], [_event(1)]),
    )
    cross_device_command = client.post(
        url,
        headers=headers,
        json=_event_batch(
            agent["device_id"],
            [_event(1, command_id=other_command["id"], printer_id=other_local_printer.id)],
        ),
    )
    cross_org_printer = client.post(
        url,
        headers=headers,
        json=_event_batch(agent["device_id"], [_event(1, printer_id=foreign_printer.id)]),
    )
    command_printer_mismatch = client.post(
        url,
        headers=headers,
        json=_event_batch(
            agent["device_id"],
            [_event(1, command_id=own_command["id"], printer_id=other_local_printer.id)],
        ),
    )
    unknown_field = client.post(
        url,
        headers=headers,
        json={**_event_batch(agent["device_id"], [_event(1)]), "org_id": test_org.id},
    )
    wrong_sequence_type = client.post(
        url,
        headers=headers,
        json=_event_batch(agent["device_id"], [_event("1")]),
    )
    duplicated_sequence = _event(1, printer_id=printer.id)
    conflicting_in_batch = client.post(
        url,
        headers=headers,
        json=_event_batch(
            agent["device_id"],
            [
                duplicated_sequence,
                {**duplicated_sequence, "printer_id": other_local_printer.id},
            ],
        ),
    )

    assert cross_device_batch.status_code == 403
    assert cross_device_command.status_code == 404
    assert cross_org_printer.status_code == 404
    assert command_printer_mismatch.status_code == 409
    assert unknown_field.status_code == 422
    assert wrong_sequence_type.status_code == 422
    assert conflicting_in_batch.status_code == 409
