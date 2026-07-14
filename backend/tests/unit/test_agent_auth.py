"""Unit contracts for protocol-v2 agent credentials."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import jwt

from app.core.config import settings
from app.core.security import ALGORITHM, decode_token
from app.services.agent_auth import (
    AGENT_ACCESS_TOKEN_TTL_SECONDS,
    create_agent_access_token,
    decode_agent_access_token,
    hash_agent_secret,
    verify_agent_secret,
)


def test_agent_secret_is_hashed_and_verified_without_storing_raw_value() -> None:
    raw = "mf_agent_test-secret"

    digest = hash_agent_secret(raw)

    assert digest != raw
    assert len(digest) == 64
    assert verify_agent_secret(raw, digest)
    assert not verify_agent_secret("wrong-secret", digest)


def test_agent_access_token_is_scoped_short_lived_and_not_a_user_token() -> None:
    device_id = uuid4()

    token = create_agent_access_token(
        device_id=device_id,
        organization_id=42,
        scopes=["agent:connect", "events:write"],
        credential_version=3,
    )
    claims = decode_agent_access_token(token, required_scopes={"agent:connect"})

    assert claims is not None
    assert claims.device_id == device_id
    assert claims.organization_id == 42
    assert claims.scopes == frozenset({"agent:connect", "events:write"})
    assert claims.credential_version == 3
    assert 0 < (claims.expires_at - datetime.now(timezone.utc)).total_seconds() <= AGENT_ACCESS_TOKEN_TTL_SECONDS
    assert decode_token(token) is None


def test_agent_access_token_rejects_missing_scope() -> None:
    token = create_agent_access_token(
        device_id=uuid4(),
        organization_id=1,
        scopes=["agent:connect", "events:write"],
        credential_version=1,
    )

    assert decode_agent_access_token(token, required_scopes={"commands:read"}) is None


def test_agent_access_token_rejects_expired_or_wrong_type_tokens() -> None:
    now = datetime.now(timezone.utc)
    base = {
        "sub": str(uuid4()),
        "org_id": 1,
        "scopes": ["agent:connect"],
        "credential_version": 1,
    }
    expired = jwt.encode(
        {**base, "typ": "agent_access", "iat": now - timedelta(minutes=2), "exp": now - timedelta(minutes=1)},
        settings.SECRET_KEY,
        algorithm=ALGORITHM,
    )
    wrong_type = jwt.encode(
        {**base, "typ": "access", "iat": now, "exp": now + timedelta(minutes=1)},
        settings.SECRET_KEY,
        algorithm=ALGORITHM,
    )

    assert decode_agent_access_token(expired) is None
    assert decode_agent_access_token(wrong_type) is None
