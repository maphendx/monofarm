"""Unit tests for the Bambu Cloud auth/token lifecycle manager. No DB, no network.

`Organization` instances are constructed in-memory (never flushed) and `_load_org`/
`store_auth_result`/`_post_login` are monkeypatched so these tests exercise the auth
decision logic (cache/refresh/login/fallback ordering, redaction, locking) in isolation.
"""
from __future__ import annotations

import base64
import json
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest

from app.models.organization import BambuAuthType, Organization
from app.services import bambu_auth
from app.services.bambu_auth import AuthResult, BambuAuthError
from app.services.encryption import encrypt


def _fake_jwt(user_id: str) -> str:
    payload = base64.urlsafe_b64encode(json.dumps({"user_id": user_id}).encode()).decode().rstrip("=")
    return f"header.{payload}.signature"


def _make_org(**overrides) -> Organization:
    org = Organization(id=1, name="Test Farm", slug="test-farm")
    org.bambu_email = encrypt("owner@example.com")
    org.bambu_password = encrypt("hunter2")
    org.bambu_refresh_token = ""
    org.bambu_access_token = ""
    org.bambu_access_token_expires_at = None
    org.bambu_auth_type = BambuAuthType.password
    org.bambu_user_id = ""
    org.bambu_region = "us"
    for key, value in overrides.items():
        setattr(org, key, value)
    return org


# ── helpers ──────────────────────────────────────────────────────────────────


def test_decode_jwt_user_id_extracts_claim():
    assert bambu_auth._decode_jwt_user_id(_fake_jwt("u-789")) == "u-789"


def test_decode_jwt_user_id_returns_none_for_opaque_token():
    assert bambu_auth._decode_jwt_user_id("opaque-long-lived-token") is None


def test_expires_at_from_payload_parses_known_keys():
    before = datetime.now(timezone.utc)
    result = bambu_auth._expires_at_from_payload({"expiresIn": 3600})
    assert result is not None and result > before + timedelta(minutes=59)


def test_expires_at_from_payload_returns_none_when_absent():
    assert bambu_auth._expires_at_from_payload({}) is None


def test_redact_email_masks_local_part():
    assert bambu_auth._redact_email("john.doe@example.com") == "jo***@example.com"
    assert bambu_auth._redact_email(None) == "<empty>"


def test_org_lock_is_stable_per_org_and_distinct_across_orgs():
    assert bambu_auth._org_lock(42) is bambu_auth._org_lock(42)
    assert bambu_auth._org_lock(1) is not bambu_auth._org_lock(2)


# ── login_with_email_code (no persistence — returns AuthResult to caller) ───


def test_login_with_email_code_returns_auth_result(monkeypatch):
    token = _fake_jwt("u123")
    monkeypatch.setattr(bambu_auth, "_post_login", lambda base, payload: {"accessToken": token, "expiresIn": 3600})

    result = bambu_auth.login_with_email_code("user@example.com", "123456", "us")

    assert isinstance(result, AuthResult)
    assert result.access_token == token
    assert result.auth_type is BambuAuthType.email_code
    assert result.user_id == "u123"
    assert result.expires_at is not None


def test_login_with_email_code_raises_when_no_token_in_response(monkeypatch):
    monkeypatch.setattr(bambu_auth, "_post_login", lambda base, payload: {"message": "wrong code"})

    with pytest.raises(BambuAuthError, match="wrong code"):
        bambu_auth.login_with_email_code("user@example.com", "000000", "us")


# ── login_with_password ──────────────────────────────────────────────────────


def test_login_with_password_persists_result(monkeypatch):
    org = _make_org()
    token = _fake_jwt("uX")
    store_mock = MagicMock()
    monkeypatch.setattr(bambu_auth, "_load_org", lambda org_id: org)
    monkeypatch.setattr(bambu_auth, "store_auth_result", store_mock)
    monkeypatch.setattr(
        bambu_auth, "_post_login",
        lambda base, payload: {"accessToken": token, "expiresIn": 7200, "refreshToken": "rt-1"},
    )

    returned = bambu_auth.login_with_password(1)

    assert returned == token
    store_mock.assert_called_once()
    org_id_arg, result_arg = store_mock.call_args[0]
    assert org_id_arg == 1
    assert result_arg.access_token == token
    assert result_arg.auth_type is BambuAuthType.password
    assert result_arg.user_id == "uX"


def test_login_with_password_raises_and_marks_reauth_on_2fa(monkeypatch):
    org = _make_org()
    mark_mock = MagicMock()
    monkeypatch.setattr(bambu_auth, "_load_org", lambda org_id: org)
    monkeypatch.setattr(bambu_auth, "mark_reauth_required", mark_mock)
    monkeypatch.setattr(bambu_auth, "_post_login", lambda base, payload: {"success": False, "loginType": "verifyCode"})

    with pytest.raises(BambuAuthError, match="2FA"):
        bambu_auth.login_with_password(1)
    mark_mock.assert_called_once()


def test_login_with_password_raises_when_credentials_missing(monkeypatch):
    org = _make_org(bambu_email="", bambu_password="")
    monkeypatch.setattr(bambu_auth, "_load_org", lambda org_id: org)

    with pytest.raises(BambuAuthError, match="not configured"):
        bambu_auth.login_with_password(1)


# ── legacy fallback ──────────────────────────────────────────────────────────


def test_legacy_token_fallback_adopts_existing_token(monkeypatch):
    legacy = _fake_jwt("legacy-u")
    org = _make_org(bambu_refresh_token=encrypt(legacy), bambu_auth_type=None)
    store_mock = MagicMock()
    monkeypatch.setattr(bambu_auth, "store_auth_result", store_mock)

    token = bambu_auth._legacy_token_fallback(1, org)

    assert token == legacy
    store_mock.assert_called_once()
    _, result = store_mock.call_args[0]
    assert result.access_token == legacy
    assert result.auth_type is BambuAuthType.email_code
    assert result.user_id == "legacy-u"


def test_legacy_token_fallback_returns_none_when_nothing_stored():
    org = _make_org(bambu_refresh_token="")
    assert bambu_auth._legacy_token_fallback(1, org) is None


# ── get_valid_access_token (the orchestration entry point) ──────────────────


def test_get_valid_access_token_returns_cached_token_without_refresh(monkeypatch):
    token = _fake_jwt("u1")
    org = _make_org(
        bambu_access_token=encrypt(token),
        bambu_access_token_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
    )
    monkeypatch.setattr(bambu_auth, "_load_org", lambda org_id: org)
    monkeypatch.setattr(bambu_auth, "_refresh_impl", MagicMock(side_effect=AssertionError("must not refresh")))
    monkeypatch.setattr(bambu_auth, "_login_with_password_impl", MagicMock(side_effect=AssertionError("must not login")))

    assert bambu_auth.get_valid_access_token(1) == token


def test_get_valid_access_token_refreshes_when_expired(monkeypatch):
    new_token = _fake_jwt("u1")
    org = _make_org(
        bambu_access_token=encrypt(_fake_jwt("stale")),
        bambu_access_token_expires_at=datetime.now(timezone.utc) - timedelta(minutes=5),
        bambu_refresh_token=encrypt("refresh-xyz"),
    )
    refresh_mock = MagicMock(return_value=new_token)
    monkeypatch.setattr(bambu_auth, "_load_org", lambda org_id: org)
    monkeypatch.setattr(bambu_auth, "_refresh_impl", refresh_mock)

    assert bambu_auth.get_valid_access_token(1) == new_token
    refresh_mock.assert_called_once_with(1)


def test_get_valid_access_token_falls_back_to_password_login_when_refresh_fails(monkeypatch):
    org = _make_org(bambu_access_token="", bambu_access_token_expires_at=None, bambu_refresh_token="")
    login_mock = MagicMock(return_value="fresh-token")
    monkeypatch.setattr(bambu_auth, "_load_org", lambda org_id: org)
    monkeypatch.setattr(bambu_auth, "_refresh_impl", MagicMock(side_effect=BambuAuthError("no refresh token stored")))
    monkeypatch.setattr(bambu_auth, "_login_with_password_impl", login_mock)

    assert bambu_auth.get_valid_access_token(1) == "fresh-token"
    login_mock.assert_called_once_with(1)


def test_get_valid_access_token_marks_reauth_required_when_all_attempts_fail(monkeypatch):
    org = _make_org(
        bambu_access_token="", bambu_access_token_expires_at=None,
        bambu_refresh_token="", bambu_auth_type=BambuAuthType.email_code,
        bambu_email="", bambu_password="",
    )
    mark_mock = MagicMock()
    monkeypatch.setattr(bambu_auth, "_load_org", lambda org_id: org)
    monkeypatch.setattr(bambu_auth, "_refresh_impl", MagicMock(side_effect=BambuAuthError("no refresh token stored")))
    monkeypatch.setattr(bambu_auth, "mark_reauth_required", mark_mock)

    with pytest.raises(BambuAuthError, match="re-authentication required"):
        bambu_auth.get_valid_access_token(1)
    mark_mock.assert_called_once()
