"""Bambu Cloud auth/token lifecycle manager.

Owns the per-org access/refresh-token lifecycle: login (password / email-code),
token refresh, persistence to the `Organization.bambu_*` auth-lifecycle fields,
and reauth bookkeeping. Per-org locks prevent concurrent refresh/login storms.

Backward compatibility: legacy orgs only have `bambu_refresh_token` populated
(and it sometimes actually holds a long-lived access token — see `bambu.login()`).
This module reads the new `bambu_access_token` field first and falls back to the
legacy `bambu_refresh_token` field, writing results back into the new fields so
orgs migrate to the clean shape over time without any explicit backfill step.

Secrets hygiene: never log or raise raw tokens/passwords/emails — use `_redact*`.
"""
from __future__ import annotations

import dataclasses
import logging
import threading
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

import requests

from app.core import metrics
from app.models.organization import BambuAuthType
from app.services import bambu_provider
from app.services.bambu_errors import BambuErrorCode
from app.services.bambu_observability import event_tags, log_event

if TYPE_CHECKING:
    from app.models.organization import Organization

log = logging.getLogger(__name__)

# Refresh proactively this long before expiry (avoids racing a near-expiry token).
_EXPIRY_SAFETY_MARGIN = timedelta(minutes=2)


class BambuAuthError(Exception):
    """Raised when Bambu Cloud authentication/refresh fails."""

    def __init__(self, message: str, *, error_code: BambuErrorCode = BambuErrorCode.AUTH_REAUTH_REQUIRED):
        super().__init__(message)
        self.error_code = error_code.value


@dataclasses.dataclass
class AuthResult:
    access_token: str
    auth_type: BambuAuthType
    refresh_token: str | None = None
    expires_at: datetime | None = None
    user_id: str | None = None


# ── Redaction helpers (never leak secrets into logs/exceptions) ─────────────


def _redact_email(email: str | None) -> str:
    if not email or "@" not in email:
        return "<empty>"
    user, _, domain = email.partition("@")
    return f"{user[:2]}***@{domain}"


# ── Per-org locking (avoid concurrent refresh/login storms) ─────────────────

_locks: dict[int, threading.Lock] = {}
_locks_guard = threading.Lock()


def _org_lock(org_id: int) -> threading.Lock:
    with _locks_guard:
        lock = _locks.get(org_id)
        if lock is None:
            lock = threading.Lock()
            _locks[org_id] = lock
        return lock


# ── DB persistence ───────────────────────────────────────────────────────────


def _load_org(org_id: int) -> "Organization":
    from app.core.db import SessionLocal
    from app.models.organization import Organization

    with SessionLocal() as db:
        org = db.get(Organization, org_id)
        if org is None:
            raise BambuAuthError(f"Organization {org_id} not found")
        db.expunge(org)
        return org


def store_auth_result(org_id: int, result: AuthResult) -> None:
    """Persist a successful auth/refresh result and clear reauth bookkeeping."""
    from app.core.db import SessionLocal
    from app.models.organization import Organization
    from app.services.encryption import encrypt

    with SessionLocal() as db:
        org = db.get(Organization, org_id)
        if org is None:
            raise BambuAuthError(f"Organization {org_id} not found")

        org.bambu_access_token = encrypt(result.access_token)
        org.bambu_access_token_expires_at = result.expires_at
        org.bambu_auth_type = result.auth_type
        if result.refresh_token:
            org.bambu_refresh_token = encrypt(result.refresh_token)
        if result.user_id:
            org.bambu_user_id = result.user_id
        org.bambu_last_auth_success_at = datetime.now(timezone.utc)
        org.bambu_last_auth_error = None
        org.bambu_reauth_required = False
        db.commit()

    log_event(
        log,
        logging.INFO,
        "bambu.auth.store.success",
        org_id=org_id,
        auth_type=result.auth_type.value,
        user_id=result.user_id or "<unknown>",
        expires_at=result.expires_at,
    )
    _sync_legacy_runtime_state(org_id, result)


def mark_reauth_required(org_id: int, reason: str) -> None:
    """Flag an org as needing manual reauth (e.g. refresh + login both failed)."""
    from app.core.db import SessionLocal
    from app.models.organization import Organization

    redacted_reason = reason[:500]
    with SessionLocal() as db:
        org = db.get(Organization, org_id)
        if org is None:
            return
        org.bambu_reauth_required = True
        org.bambu_last_auth_error = redacted_reason
        db.commit()

    log_event(log, logging.WARNING, "bambu.auth.login.failed", org_id=org_id, reason=redacted_reason)
    metrics.increment("bambu.auth.login.failed.count", tags=event_tags(org_id=org_id))


def _sync_legacy_runtime_state(org_id: int, result: AuthResult) -> None:
    """Bridge the new auth result into bambu.py's in-memory caches.

    `bambu.py` (MQTT/dispatch) keys all live state off `_access_tokens`/`_user_ids`/
    `_regions`. Keeping these in sync means the new auth manager can be adopted here
    without touching the MQTT/dispatch code paths yet (Phase 3+).
    """
    try:
        from app.services import bambu
        bambu._access_tokens[org_id] = result.access_token
        if result.user_id:
            bambu._user_ids[org_id] = result.user_id
    except Exception:
        log.debug("bambu.auth: failed to sync legacy runtime state (org_id=%s)", org_id, exc_info=True)


# ── Cloud HTTP helpers ───────────────────────────────────────────────────────


def _api_base(region: str | None) -> str:
    from app.services.bambu import _REGION_HOSTS
    return _REGION_HOSTS.get(region or "us", _REGION_HOSTS["us"])["api"]


def _decode_jwt_user_id(token: str) -> str | None:
    """Best-effort user_id extraction from a JWT access token (no signature check)."""
    import base64
    import json

    parts = token.split(".")
    if len(parts) != 3:
        return None
    try:
        payload_b64 = parts[1]
        payload_b64 += "=" * (-len(payload_b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
        uid = payload.get("user_id") or payload.get("uid") or payload.get("sub")
        return str(uid) if uid else None
    except Exception:
        return None


def _expires_at_from_payload(data: dict) -> datetime | None:
    for key in ("expiresIn", "accessTokenExpiresIn", "expires_in"):
        seconds = data.get(key)
        if isinstance(seconds, (int, float)) and seconds > 0:
            return datetime.now(timezone.utc) + timedelta(seconds=seconds)
    return None


def _post_login(base: str, payload: dict) -> dict:
    try:
        return bambu_provider.post_login(base, payload)
    except requests.RequestException as e:
        raise BambuAuthError(f"Bambu login request failed: {e}", error_code=BambuErrorCode.AUTH_INVALID) from e


# ── Auth flow implementations (no locking — call only while holding _org_lock) ─


def _login_with_password_impl(org_id: int) -> str:
    from app.services.encryption import decrypt

    org = _load_org(org_id)
    email = decrypt(org.bambu_email)
    password = decrypt(org.bambu_password)
    if not (email and password):
        raise BambuAuthError("Bambu credentials are not configured for this organization", error_code=BambuErrorCode.AUTH_INVALID)

    region = org.bambu_region or "us"
    base = _api_base(region)
    data = _post_login(base, {"account": email, "password": password, "apiError": ""})

    if not data.get("success") and data.get("loginType") == "verifyCode":
        mark_reauth_required(org_id, "2FA verification code required — switch to email-code login")
        raise BambuAuthError("Bambu account requires 2FA email-code verification", error_code=BambuErrorCode.AUTH_REAUTH_REQUIRED)

    token = data.get("accessToken")
    if not token:
        mark_reauth_required(org_id, f"Bambu login rejected credentials for {_redact_email(email)}")
        raise BambuAuthError("Bambu password login failed — check credentials", error_code=BambuErrorCode.AUTH_INVALID)

    result = AuthResult(
        access_token=token,
        auth_type=BambuAuthType.password,
        refresh_token=data.get("refreshToken"),
        expires_at=_expires_at_from_payload(data),
        user_id=_decode_jwt_user_id(token),
    )
    store_auth_result(org_id, result)
    log_event(log, logging.INFO, "bambu.auth.login.success", org_id=org_id, auth_type="password", user_id=result.user_id)
    metrics.increment("bambu.auth.login.success.count", tags=event_tags(org_id=org_id, auth_type="password"))
    return token


def _refresh_impl(org_id: int) -> str:
    from app.services.encryption import decrypt

    org = _load_org(org_id)
    refresh_token = decrypt(org.bambu_refresh_token)
    if not refresh_token:
        raise BambuAuthError("No Bambu refresh token stored for this organization", error_code=BambuErrorCode.AUTH_REAUTH_REQUIRED)

    region = org.bambu_region or "us"
    base = _api_base(region)
    try:
        data = bambu_provider.post_refresh_token(base, refresh_token)
    except requests.RequestException as e:
        raise BambuAuthError(f"Bambu token refresh request failed: {e}", error_code=BambuErrorCode.AUTH_EXPIRED) from e

    token = data.get("accessToken") or data.get("token")
    if not token:
        raise BambuAuthError("Bambu token refresh returned no access token", error_code=BambuErrorCode.AUTH_EXPIRED)

    result = AuthResult(
        access_token=token,
        auth_type=org.bambu_auth_type or BambuAuthType.password,
        refresh_token=data.get("refreshToken"),
        expires_at=_expires_at_from_payload(data),
        user_id=_decode_jwt_user_id(token) or (org.bambu_user_id or None),
    )
    store_auth_result(org_id, result)
    log_event(log, logging.INFO, "bambu.auth.refresh.success", org_id=org_id, auth_type=result.auth_type.value)
    metrics.increment("bambu.auth.refresh.success.count", tags=event_tags(org_id=org_id, auth_type=result.auth_type.value))
    return token


def _legacy_token_fallback(org_id: int, org: "Organization") -> str | None:
    """Some pre-Phase-2 orgs only have a long-lived token stashed in the
    (overloaded) `bambu_refresh_token` field that works as an access token
    as-is — see `bambu.login()`'s last-resort branch. Adopt it into the new
    fields so the org converges onto the clean shape without manual backfill."""
    from app.services.encryption import decrypt

    legacy_token = decrypt(org.bambu_refresh_token)
    if not legacy_token:
        return None

    log.info("bambu.auth: adopting legacy stored token (org_id=%s)", org_id)
    result = AuthResult(
        access_token=legacy_token,
        auth_type=org.bambu_auth_type or BambuAuthType.email_code,
        user_id=_decode_jwt_user_id(legacy_token) or (org.bambu_user_id or None),
    )
    store_auth_result(org_id, result)
    return legacy_token


# ── Public auth flows ────────────────────────────────────────────────────────


def login_with_password(org_id: int) -> str:
    """Authenticate using the org's stored email + password. Returns access_token."""
    with _org_lock(org_id):
        return _login_with_password_impl(org_id)


def login_with_email_code(email: str, code: str, region: str) -> AuthResult:
    """Verify a Bambu email login code. Returns an AuthResult — the caller persists
    it via `store_auth_result(org_id, result)` once the target org is known
    (see `api/orgs.py:bambu_verify_code`, which doesn't have an authenticated
    org context until the verification itself succeeds)."""
    base = _api_base(region)
    data = _post_login(base, {"account": email, "code": code})

    token = data.get("accessToken") or data.get("token")
    if not token:
        msg = data.get("message") or "invalid or expired verification code"
        raise BambuAuthError(f"Bambu email-code login failed: {msg}", error_code=BambuErrorCode.AUTH_INVALID)

    return AuthResult(
        access_token=token,
        auth_type=BambuAuthType.email_code,
        refresh_token=data.get("refreshToken"),
        expires_at=_expires_at_from_payload(data),
        user_id=_decode_jwt_user_id(token),
    )


def refresh_access_token(org_id: int) -> str:
    """Use the stored refresh token to obtain a fresh access token. Returns access_token."""
    with _org_lock(org_id):
        return _refresh_impl(org_id)


def get_valid_access_token(org_id: int) -> str:
    """Return a usable access token for an org, refreshing/logging in as needed.

    Order of attempts (all under the per-org lock, so concurrent callers don't
    trigger a refresh storm — the cache is re-checked after acquiring the lock
    in case another thread just refreshed):
      1. Cached, non-expired `bambu_access_token`.
      2. `refresh_access_token` (refresh-token grant).
      3. `login_with_password` (password accounts only — email-code accounts
         can't be silently re-authenticated and need manual reauth).
      4. Legacy fallback: adopt whatever is in `bambu_refresh_token` as-is.
    """
    from app.services.encryption import decrypt

    def _cached(o: "Organization") -> str | None:
        token = decrypt(o.bambu_access_token)
        if not token:
            return None
        expires_at = o.bambu_access_token_expires_at
        if expires_at is None or expires_at - _EXPIRY_SAFETY_MARGIN > datetime.now(timezone.utc):
            return token
        return None

    org = _load_org(org_id)
    token = _cached(org)
    if token:
        return token

    with _org_lock(org_id):
        org = _load_org(org_id)
        token = _cached(org)
        if token:
            return token

        last_error: Exception | None = None
        try:
            return _refresh_impl(org_id)
        except BambuAuthError as e:
            last_error = e
            log_event(log, logging.WARNING, "bambu.auth.refresh.failed", org_id=org_id, error_code=e.error_code)
            metrics.increment("bambu.auth.refresh.failed.count", tags=event_tags(org_id=org_id, error_code=e.error_code))

        if (org.bambu_auth_type or BambuAuthType.password) == BambuAuthType.password:
            try:
                return _login_with_password_impl(org_id)
            except BambuAuthError as e:
                last_error = e
                log_event(log, logging.WARNING, "bambu.auth.login.failed", org_id=org_id, error_code=e.error_code)
                metrics.increment("bambu.auth.login.failed.count", tags=event_tags(org_id=org_id, error_code=e.error_code))

        fallback = _legacy_token_fallback(org_id, org)
        if fallback:
            return fallback

        mark_reauth_required(org_id, f"Bambu re-authentication required: {last_error or 'no valid token'}")
        raise BambuAuthError(
            "Bambu re-authentication required — please reconnect via email code",
            error_code=BambuErrorCode.AUTH_REAUTH_REQUIRED,
        )
