from __future__ import annotations

import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable
from uuid import UUID

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.db import get_db
from app.core.security import ALGORITHM
from app.models.agent import AgentDevice
from app.models.organization import Organization


AGENT_ACCESS_TOKEN_TTL_SECONDS = 5 * 60
PAIRING_CODE_TTL_SECONDS = 10 * 60
AGENT_ALLOWED_SCOPES = frozenset({"agent:connect", "commands:read", "events:write", "status:write"})
DEFAULT_AGENT_SCOPES = ("agent:connect", "commands:read", "events:write", "status:write")
AGENT_TOKEN_TYPE = "agent_access"


@dataclass(frozen=True)
class AgentAccessClaims:
    device_id: UUID
    organization_id: int
    scopes: frozenset[str]
    credential_version: int
    expires_at: datetime


@dataclass(frozen=True)
class AgentPrincipal:
    device: AgentDevice
    organization: Organization
    scopes: frozenset[str]


agent_bearer_scheme = HTTPBearer(auto_error=False, scheme_name="AgentBearer")


def hash_agent_secret(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def verify_agent_secret(raw: str, expected_hash: str) -> bool:
    return hmac.compare_digest(hash_agent_secret(raw), expected_hash)


def generate_pairing_code() -> str:
    return "mf_pair_" + secrets.token_urlsafe(24)


def generate_device_secret() -> str:
    return "mf_agent_" + secrets.token_urlsafe(32)


def normalize_agent_scopes(scopes: list[str] | tuple[str, ...]) -> tuple[str, ...]:
    normalized = tuple(dict.fromkeys(scope.strip() for scope in scopes if scope.strip()))
    unknown = set(normalized) - AGENT_ALLOWED_SCOPES
    if unknown:
        raise ValueError(f"Unknown agent scopes: {', '.join(sorted(unknown))}")
    if "agent:connect" not in normalized:
        raise ValueError("Agent scope 'agent:connect' is required")
    return normalized


def create_agent_access_token(
    *,
    device_id: UUID,
    organization_id: int,
    scopes: list[str] | tuple[str, ...],
    credential_version: int,
) -> str:
    normalized_scopes = normalize_agent_scopes(scopes)
    now = datetime.now(timezone.utc)
    expire = now + timedelta(seconds=AGENT_ACCESS_TOKEN_TTL_SECONDS)
    payload = {
        "sub": str(device_id),
        "typ": AGENT_TOKEN_TYPE,
        "org_id": organization_id,
        "scopes": list(normalized_scopes),
        "credential_version": credential_version,
        "iat": now,
        "exp": expire,
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=ALGORITHM)


def decode_agent_access_token(
    token: str,
    *,
    required_scopes: set[str] | frozenset[str] | None = None,
) -> AgentAccessClaims | None:
    try:
        data = jwt.decode(token, settings.SECRET_KEY, algorithms=[ALGORITHM])
        if data.get("typ") != AGENT_TOKEN_TYPE:
            return None
        scopes_raw = data.get("scopes")
        if not isinstance(scopes_raw, list) or not all(isinstance(scope, str) for scope in scopes_raw):
            return None
        scopes = frozenset(scopes_raw)
        if not scopes or not scopes.issubset(AGENT_ALLOWED_SCOPES):
            return None
        if required_scopes and not set(required_scopes).issubset(scopes):
            return None
        expires_at = datetime.fromtimestamp(float(data["exp"]), tz=timezone.utc)
        credential_version = int(data["credential_version"])
        if credential_version < 1:
            return None
        return AgentAccessClaims(
            device_id=UUID(str(data["sub"])),
            organization_id=int(data["org_id"]),
            scopes=scopes,
            credential_version=credential_version,
            expires_at=expires_at,
        )
    except (jwt.PyJWTError, KeyError, TypeError, ValueError):
        return None


def authenticate_device_secret(db: Session, device_id: UUID, raw_secret: str) -> AgentDevice | None:
    device = db.query(AgentDevice).filter(AgentDevice.id == device_id).first()
    if (
        device is None
        or device.revoked_at is not None
        or device.paired_at is None
        or not device.credential_hash
        or not verify_agent_secret(raw_secret, device.credential_hash)
    ):
        return None
    return device


def resolve_agent_access_token(
    db: Session,
    token: str,
    *,
    required_scopes: set[str] | frozenset[str] | None = None,
) -> AgentDevice | None:
    claims = decode_agent_access_token(token, required_scopes=required_scopes)
    if claims is None:
        return None
    device = (
        db.query(AgentDevice)
        .filter(
            AgentDevice.id == claims.device_id,
            AgentDevice.organization_id == claims.organization_id,
        )
        .first()
    )
    if (
        device is None
        or device.revoked_at is not None
        or device.paired_at is None
        or not device.credential_hash
        or device.credential_version != claims.credential_version
        or not claims.scopes.issubset(set(device.scopes or []))
    ):
        return None
    return device


def require_agent_principal(*required_scopes: str) -> Callable:
    required = frozenset(required_scopes)
    unknown = required - AGENT_ALLOWED_SCOPES
    if unknown:
        raise ValueError(f"Unknown required agent scopes: {', '.join(sorted(unknown))}")

    def dependency(
        credentials: HTTPAuthorizationCredentials | None = Depends(agent_bearer_scheme),
        db: Session = Depends(get_db),
    ) -> AgentPrincipal:
        if credentials is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Agent authentication required",
                headers={"WWW-Authenticate": "Bearer"},
            )
        claims = decode_agent_access_token(credentials.credentials)
        if claims is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid agent credential",
                headers={"WWW-Authenticate": "Bearer"},
            )
        device = resolve_agent_access_token(db, credentials.credentials)
        if device is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid agent credential",
                headers={"WWW-Authenticate": "Bearer"},
            )
        if not required.issubset(claims.scopes):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient agent scope")
        organization = db.get(Organization, device.organization_id)
        if organization is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Agent organization no longer exists",
            )
        return AgentPrincipal(device=device, organization=organization, scopes=claims.scopes)

    return dependency
