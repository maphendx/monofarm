"""Auth endpoint coverage. Login flow + /me."""
from __future__ import annotations


def test_login_succeeds_with_valid_credentials(client, admin_user):
    resp = client.post(
        "/api/auth/login",
        json={"email": admin_user.email, "password": "test-admin-pw"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["token_type"] == "bearer"
    assert body["access_token"]


def test_login_rejects_wrong_password(client, admin_user):
    resp = client.post(
        "/api/auth/login",
        json={"email": admin_user.email, "password": "wrong-password"},
    )
    assert resp.status_code == 401


def test_login_rejects_unknown_email(client):
    resp = client.post(
        "/api/auth/login",
        json={"email": "ghost@example.com", "password": "anything"},
    )
    assert resp.status_code == 401


def test_login_rejects_inactive_user(client, db_session, admin_user):
    admin_user.is_active = False
    db_session.commit()
    resp = client.post(
        "/api/auth/login",
        json={"email": admin_user.email, "password": "test-admin-pw"},
    )
    assert resp.status_code == 403


def test_me_requires_token(client):
    resp = client.get("/api/auth/me")
    assert resp.status_code == 401


def test_me_returns_current_user(client, admin_user, auth_headers):
    resp = client.get("/api/auth/me", headers=auth_headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["email"] == admin_user.email
    assert body["role"] == "admin"


def test_me_rejects_garbage_token(client):
    resp = client.get(
        "/api/auth/me",
        headers={"Authorization": "Bearer not.a.real.jwt"},
    )
    assert resp.status_code == 401


def test_health_endpoint_is_public(client):
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
