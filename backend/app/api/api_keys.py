"""Scoped API keys — for OrcaSlicer / OctoPrint integration.

Flow:
  POST /api/api-keys  → generates key, returns raw value ONCE (never stored)
  GET  /api/api-keys  → list user's keys (no raw values)
  DELETE /api/api-keys/{id} → deactivate

Key format: mf_<40 random bytes urlsafe-base64> ≈ 57 chars.
Storage: SHA-256 hex digest of raw key. High-entropy random = no salt needed.
"""
from __future__ import annotations

import hashlib
import os
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, get_current_user
from app.core.db import get_db
from app.models.api_key import ApiKey
from app.models.organization import Organization
from app.models.user import User

router = APIRouter(prefix="/api-keys", tags=["api-keys"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class ApiKeyCreate(BaseModel):
    name: str
    scopes: str = "files:upload"


class ApiKeyOut(BaseModel):
    id: int
    name: str
    scopes: str
    is_active: bool
    last_used_at: str | None
    expires_at: str | None
    created_at: str

    model_config = {"from_attributes": True}


class ApiKeyCreated(ApiKeyOut):
    key: str  # raw key — shown once only


# ── Helpers ───────────────────────────────────────────────────────────────────

def _hash_key(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def _generate_raw_key() -> str:
    return "mf_" + secrets.token_urlsafe(40)


def _to_out(k: ApiKey) -> ApiKeyOut:
    return ApiKeyOut(
        id=k.id,
        name=k.name,
        scopes=k.scopes,
        is_active=k.is_active,
        last_used_at=k.last_used_at.isoformat() if k.last_used_at else None,
        expires_at=k.expires_at.isoformat() if k.expires_at else None,
        created_at=k.created_at.isoformat(),
    )


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("", response_model=list[ApiKeyOut])
def list_api_keys(
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    user: User = Depends(get_current_user),
) -> list[ApiKeyOut]:
    keys = (
        db.query(ApiKey)
        .filter(ApiKey.organization_id == org.id, ApiKey.user_id == user.id)
        .order_by(ApiKey.created_at.desc())
        .all()
    )
    return [_to_out(k) for k in keys]


@router.post("", response_model=ApiKeyCreated, status_code=status.HTTP_201_CREATED)
def create_api_key(
    payload: ApiKeyCreate,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    user: User = Depends(get_current_user),
) -> ApiKeyCreated:
    raw = _generate_raw_key()
    key = ApiKey(
        organization_id=org.id,
        user_id=user.id,
        name=payload.name,
        key_hash=_hash_key(raw),
        scopes=payload.scopes,
    )
    db.add(key)
    db.commit()
    db.refresh(key)
    out = _to_out(key)
    return ApiKeyCreated(**out.model_dump(), key=raw)


@router.delete("/{key_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_api_key(
    key_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    user: User = Depends(get_current_user),
) -> None:
    key = db.query(ApiKey).filter(
        ApiKey.id == key_id,
        ApiKey.organization_id == org.id,
        ApiKey.user_id == user.id,
    ).first()
    if not key:
        raise HTTPException(status_code=404, detail="API key not found")
    db.delete(key)
    db.commit()


# ── Public helper used by octoprint.py ────────────────────────────────────────

def resolve_api_key(raw_key: str, db: Session) -> User | None:
    """Look up a User by raw API key. Updates last_used_at. Returns None if invalid."""
    key_hash = _hash_key(raw_key)
    key = db.query(ApiKey).filter(ApiKey.key_hash == key_hash, ApiKey.is_active == True).first()  # noqa: E712
    if not key:
        return None
    if key.expires_at and key.expires_at.replace(tzinfo=None) < datetime.utcnow():
        return None
    key.last_used_at = datetime.now(timezone.utc)
    db.commit()
    from app.models.user import User as UserModel
    return db.get(UserModel, key.user_id)
