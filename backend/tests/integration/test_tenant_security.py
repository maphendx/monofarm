"""Regression tests for cross-tenant access and session-purpose confusion."""
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, Mock

import pytest
from starlette.websockets import WebSocketDisconnect

from app.api import agent, files, ws
from app.core.security import create_access_token, create_invite_token, create_reset_token, create_verify_token
from app.models.gcode_file import GcodeFile
from app.models.organization import Organization
from app.models.user import User, UserRole
from app.services import tunnel


def headers(user):
    token = create_access_token(str(user.id), user.role.value, user.organization_id, user.session_version)
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def other_org(db_session):
    org = Organization(name="Other private farm", slug="other-private-farm")
    db_session.add(org)
    db_session.commit()
    return org


@pytest.fixture
def secret_file(db_session, other_org, tmp_path, monkeypatch):
    row = GcodeFile(organization_id=other_org.id, original_name="private.gcode", stored_name="private-uuid.gcode", size_bytes=12)
    db_session.add(row)
    db_session.commit()
    monkeypatch.setattr(files, "GCODES_DIR", tmp_path)
    (tmp_path / (row.stored_name + ".thumb.png")).write_bytes(b"private-thumbnail")
    (tmp_path / row.stored_name).write_bytes(b"private-gcode")
    return row


@pytest.fixture
def websocket_db(db_session, monkeypatch):
    @contextmanager
    def session():
        yield db_session
    monkeypatch.setattr(ws, "SessionLocal", session)
    monkeypatch.setattr(agent, "SessionLocal", session)
    monkeypatch.setattr("app.core.db.SessionLocal", session)


@pytest.mark.parametrize("path", ["", "/thumbnail", "/download"])
def test_foreign_file_is_not_readable(client, auth_headers, secret_file, path):
    response = client.get(f"/api/files/{secret_file.id}{path}", headers=auth_headers)
    assert response.status_code == 404
    assert b"private-thumbnail" not in response.content


def test_thumbnail_requires_authentication(client, secret_file):
    assert client.get(f"/api/files/{secret_file.id}/thumbnail").status_code == 401


def test_thumbnail_owner_can_read_and_response_is_not_cacheable(client, db_session, admin_user, secret_file):
    secret_file.organization_id = admin_user.organization_id
    db_session.commit()
    response = client.get(f"/api/files/{secret_file.id}/thumbnail", headers=headers(admin_user))
    assert response.status_code == 200
    assert response.content == b"private-thumbnail"
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("purpose", ["verify", "reset", "invite"])
def test_email_tokens_cannot_authenticate_http_or_websockets(client, admin_user, purpose, websocket_db):
    token = {
        "verify": create_verify_token(admin_user.id),
        "reset": create_reset_token(admin_user),
        "invite": create_invite_token(admin_user.id, admin_user.organization_id),
    }[purpose]
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"}).status_code == 401
    for path in ("/ws/printers", "/ws/org", "/api/agent/connect"):
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(f"{path}?token={token}"):
                pytest.fail("Non-access token opened an authenticated connection")


def test_revoked_session_is_rejected_across_transports(client, db_session, admin_user, websocket_db):
    old_headers = headers(admin_user)
    token = old_headers["Authorization"].removeprefix("Bearer ")
    admin_user.session_version += 1
    db_session.commit()
    assert client.get("/api/auth/me", headers=old_headers).status_code == 401
    assert ws._auth_org(token) is None
    assert agent._agent_org(token) is None
    assert client.get("/api/auth/me", headers=headers(admin_user)).status_code == 200


def test_password_reset_revokes_existing_access(client, admin_user, auth_headers):
    response = client.post("/api/auth/reset-password", json={
        "token": create_reset_token(admin_user), "new_password": "new-strong-test-password",
    })
    assert response.status_code == 200, response.text
    assert client.get("/api/auth/me", headers=auth_headers).status_code == 401


def test_admin_password_change_revokes_operator_session(client, admin_user, operator_user, auth_headers):
    old_headers = headers(operator_user)
    response = client.patch(f"/api/users/{operator_user.id}", headers=auth_headers, json={"password": "replacement-password"})
    assert response.status_code == 200, response.text
    assert client.get("/api/auth/me", headers=old_headers).status_code == 401


def test_moved_user_cannot_reuse_previous_org_token(client, db_session, admin_user, other_org, websocket_db):
    token = headers(admin_user)["Authorization"].removeprefix("Bearer ")
    admin_user.organization_id = other_org.id
    db_session.commit()
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"}).status_code == 401
    assert ws._auth_org(token) is None
    assert agent._agent_org(token) is None


def test_disabled_agent_account_cannot_reconnect(db_session, admin_user, websocket_db):
    token = headers(admin_user)["Authorization"].removeprefix("Bearer ")
    assert agent._agent_org(token) == admin_user.organization_id
    admin_user.is_active = False
    db_session.commit()
    assert agent._agent_org(token) is None


def test_operator_cannot_register_an_agent_or_read_agent_credentials(client, operator_user, websocket_db):
    auth = headers(operator_user)
    token = auth["Authorization"].removeprefix("Bearer ")
    assert agent._agent_org(token) is None
    for route in ("bambu-lan-config", "anycubic-lan-config", "tg-config"):
        assert client.get(f"/api/agent/{route}", headers=auth).status_code == 403


def test_tenant_admin_cannot_trigger_global_report(client, auth_headers, monkeypatch):
    send = AsyncMock()
    monkeypatch.setattr("app.services.daily_report.send_daily_plan_to_all", send)
    assert client.post("/api/internal/send-plan-now", headers=auth_headers).status_code == 403
    send.assert_not_called()


def test_telegram_cannot_read_foreign_chat_or_claim_foreign_link(client, db_session, other_org, admin_user, auth_headers, monkeypatch):
    other = User(organization_id=other_org.id, email="other@example.com", password_hash=admin_user.password_hash,
                 name="Private user", role=UserRole.admin, telegram_chat_id=9900123,
                 telegram_link_code="foreign-secret-link", telegram_link_expires_at=datetime.now(timezone.utc) + timedelta(hours=1))
    db_session.add(other)
    db_session.commit()
    build = Mock(return_value="CONFIDENTIAL PLAN")
    monkeypatch.setattr("app.services.daily_report.build_daily_plan_text", build)
    response = client.post("/api/agent/tg-command", headers=auth_headers, json={"command": "plan", "chat_id": other.telegram_chat_id})
    assert response.status_code == 200
    assert "CONFIDENTIAL" not in response.text
    build.assert_not_called()
    response = client.post("/api/agent/tg-command", headers=auth_headers,
                           json={"command": "start", "chat_id": 9900456, "args": [other.telegram_link_code]})
    assert response.status_code == 200
    db_session.refresh(other)
    assert other.telegram_chat_id == 9900123
    assert other.telegram_link_code == "foreign-secret-link"


@pytest.mark.asyncio
async def test_agent_cannot_overwrite_other_org_bot_username(db_session, admin_user, other_org, websocket_db):
    await tunnel.handle_agent_message({"type": "TG_BOT_USERNAME", "org_id": other_org.id, "username": "own_bot"}, admin_user.organization_id)
    db_session.refresh(other_org)
    assert other_org.tg_bot_username != "own_bot"
    own = db_session.get(Organization, admin_user.organization_id)
    assert own.tg_bot_username == "own_bot"


def test_registration_creates_an_isolated_org(client, db_session, admin_user, secret_file, monkeypatch):
    monkeypatch.setattr("app.services.email.send_email_verification", Mock())
    response = client.post("/api/orgs/register", json={
        "org_name": "New separate farm", "admin_email": "new-private@example.com",
        "admin_password": "strong-new-password", "admin_name": "New owner",
    })
    assert response.status_code == 201, response.text
    auth = {"Authorization": f"Bearer {response.json()['access_token']}"}
    me = client.get("/api/auth/me", headers=auth).json()
    assert me["organization_id"] not in (secret_file.organization_id, admin_user.organization_id)
    assert client.get("/api/files", headers=auth).json() == []
    assert client.get(f"/api/files/{secret_file.id}/thumbnail", headers=auth).status_code == 404
    assert client.get("/api/admin/overview", headers=auth).status_code == 403
    assert client.get("/api/files", headers={**auth, "X-Impersonated-Org-Id": str(secret_file.organization_id)}).status_code == 403


def test_bambu_report_cannot_update_other_org_job(db_session, admin_user, other_org, monkeypatch):
    from app.models.bambu_cloud_job import BambuCloudJob, BambuCloudJobStatus
    from app.models.printer import Printer, PrinterKind
    from app.services import bambu

    @contextmanager
    def session():
        yield db_session

    monkeypatch.setattr(bambu, "SessionLocal", session)
    printers = [Printer(organization_id=oid, name="Private Bambu", kind=PrinterKind.bambu, bambu_dev_id="SHARED-SERIAL")
                for oid in (admin_user.organization_id, other_org.id)]
    db_session.add_all(printers)
    db_session.flush()
    jobs = [BambuCloudJob(
        organization_id=printer.organization_id, printer_id=printer.id,
        printer_bambu_dev_id="SHARED-SERIAL", status=BambuCloudJobStatus.task_created,
        file_name="same.3mf", bambu_task_id="same-task-id", task_created_at=datetime.now(timezone.utc),
        correlation_id=f"private-correlation-{printer.id}", idempotency_key=f"private-job-{printer.id}",
    ) for printer in printers]
    db_session.add_all(jobs)
    db_session.commit()
    result = bambu._sync_cloud_job_from_report(
        "SHARED-SERIAL", {"gcode_state": "RUNNING", "task_id": "same-task-id", "mc_percent": 15},
        {"filename": "same.3mf", "eta_minutes": 10}, None, org_id=admin_user.organization_id,
    )
    assert result.id == jobs[0].id
    assert jobs[0].status == BambuCloudJobStatus.printing
    assert jobs[1].status == BambuCloudJobStatus.task_created


@pytest.mark.asyncio
async def test_open_browser_socket_is_closed_after_session_revocation(monkeypatch):
    monkeypatch.setattr(ws, "SESSION_RECHECK_SECONDS", 0.001)
    monkeypatch.setattr(ws, "_auth_org", lambda *args: None)
    socket = AsyncMock()

    async def idle_receive():
        import asyncio
        await asyncio.Future()

    socket.receive_text.side_effect = idle_receive
    await ws._receive_authenticated(socket, "revoked-token", 1)
    socket.close.assert_awaited_once_with(code=1008)


def test_api_key_cannot_follow_user_to_another_org(client, db_session, admin_user, other_org):
    from app.api.api_keys import resolve_api_key
    created = client.post("/api/api-keys", headers=headers(admin_user), json={"name": "Slicer"})
    assert created.status_code == 201
    raw_key = created.json()["key"]
    assert resolve_api_key(raw_key, db_session).id == admin_user.id
    admin_user.organization_id = other_org.id
    db_session.commit()
    assert resolve_api_key(raw_key, db_session) is None


def test_password_reset_also_revokes_slicer_keys(client, db_session, admin_user):
    from app.api.api_keys import resolve_api_key
    created = client.post("/api/api-keys", headers=headers(admin_user), json={"name": "Slicer"})
    raw_key = created.json()["key"]
    response = client.post("/api/auth/reset-password", json={
        "token": create_reset_token(admin_user), "new_password": "replacement-test-password",
    })
    assert response.status_code == 200
    assert resolve_api_key(raw_key, db_session) is None


def test_slicer_response_never_mints_a_browser_token(admin_user, secret_file):
    from app.api.octoprint import _build_response
    response = _build_response(secret_file, admin_user)
    assert "token=" not in response["url"]
    assert "token=" not in response["files"]["local"]["refs"]["resource"]


@pytest.mark.asyncio
async def test_camera_stops_yielding_after_session_revocation(db_session, admin_user, websocket_db, monkeypatch):
    from app.api import printers

    token = headers(admin_user)["Authorization"].removeprefix("Bearer ")
    closed = []
    clock_value = [0.0]
    monkeypatch.setattr("time.monotonic", lambda: clock_value[0])

    async def frames():
        try:
            yield b"first-private-frame"
            admin_user.session_version += 1
            db_session.commit()
            clock_value[0] = 31.0
            yield b"revoked-private-frame"
        finally:
            closed.append(True)

    output = [chunk async for chunk in printers._authenticated_camera_stream(frames(), token)]
    assert output == [b"first-private-frame"]
    assert closed == [True]


def test_camera_rejects_foreign_printer_before_connecting(client, db_session, other_org, admin_user, monkeypatch):
    from app.models.printer import Printer, PrinterKind
    from app.services import go2rtc

    printer = Printer(organization_id=other_org.id, name="Private camera", kind=PrinterKind.bambu,
                      bambu_dev_id="PRIVATE-CAMERA", bambu_dev_ip="192.168.1.55")
    db_session.add(printer)
    db_session.commit()
    register = AsyncMock()
    monkeypatch.setattr(go2rtc, "register_stream", register)
    token = headers(admin_user)["Authorization"].removeprefix("Bearer ")
    response = client.get(f"/api/printers/{printer.id}/camera/stream", params={"token": token})
    assert response.status_code == 404
    register.assert_not_called()
