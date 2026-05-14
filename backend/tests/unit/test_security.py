"""Unit tests for password hashing + JWT helpers. No DB, no network."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import jwt

from app.core import security
from app.core.security import (
    ALGORITHM,
    create_access_token,
    decode_token,
    hash_password,
    verify_password,
)


def test_hash_password_returns_different_hashes_for_same_input():
    a = hash_password("hunter2")
    b = hash_password("hunter2")
    assert a != b  # bcrypt salts each hash
    assert verify_password("hunter2", a)
    assert verify_password("hunter2", b)


def test_verify_password_rejects_wrong_password():
    h = hash_password("correct horse")
    assert not verify_password("wrong horse", h)


def test_verify_password_handles_invalid_hash_format():
    # Should not raise, just return False.
    assert not verify_password("anything", "not-a-bcrypt-hash")


def test_create_and_decode_access_token_roundtrip():
    token = create_access_token(subject="42", role="admin")
    payload = decode_token(token)
    assert payload is not None
    assert payload["sub"] == "42"
    assert payload["role"] == "admin"
    assert "exp" in payload


def test_decode_token_returns_none_for_garbage():
    assert decode_token("not.a.jwt") is None
    assert decode_token("") is None


def test_decode_token_rejects_token_signed_with_wrong_key():
    bad = jwt.encode({"sub": "1", "role": "admin"}, "other-secret", algorithm=ALGORITHM)
    assert decode_token(bad) is None


def test_decode_token_rejects_expired_token():
    expired = jwt.encode(
        {
            "sub": "1",
            "role": "admin",
            "exp": datetime.now(timezone.utc) - timedelta(minutes=1),
        },
        security.settings.SECRET_KEY,
        algorithm=ALGORITHM,
    )
    assert decode_token(expired) is None
