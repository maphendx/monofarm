from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

import bcrypt
import jwt

from app.core.config import settings

if TYPE_CHECKING:
    from sqlalchemy.orm import Session
    from app.models.user import User


ALGORITHM = "HS256"
ACCESS_TOKEN_TYPE = "access"


def revoke_user_credentials(user: "User", db: "Session") -> None:
    """Invalidate existing login tokens and API keys after account security changes."""
    from app.models.api_key import ApiKey

    user.session_version += 1
    db.query(ApiKey).filter(ApiKey.user_id == user.id).update({ApiKey.is_active: False})


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except ValueError:
        return False


def create_access_token(subject: str, role: str, org_id: int | None, session_version: int = 0) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {
        "sub": subject, "role": role, "org_id": org_id, "exp": expire,
        "typ": ACCESS_TOKEN_TYPE, "ver": session_version,
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> dict | None:
    """Decode access tokens only; email/reset/invitation tokens cannot authenticate."""
    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[ALGORITHM],
            options={"require": ["sub", "exp", "typ", "role", "ver"]},
        )
    except jwt.PyJWTError:
        return None
    if payload.get("typ") != ACCESS_TOKEN_TYPE or "org_id" not in payload:
        return None
    subject = payload.get("sub")
    if not isinstance(subject, str) or not subject.isascii() or not subject.isdigit() or int(subject) <= 0:
        return None
    org_id = payload["org_id"]
    if org_id is not None and (type(org_id) is not int or org_id <= 0):
        return None
    if type(payload["ver"]) is not int or payload["ver"] < 0:
        return None
    if not isinstance(payload["role"], str):
        return None
    return payload


def create_verify_token(user_id: int) -> str:
    expire = datetime.now(timezone.utc) + timedelta(hours=72)
    payload = {"sub": str(user_id), "typ": "email_verify", "exp": expire}
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=ALGORITHM)


def decode_verify_token(token: str) -> int | None:
    try:
        data = jwt.decode(token, settings.SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.PyJWTError:
        return None
    if data.get("typ") != "email_verify":
        return None
    try:
        return int(data["sub"])
    except (KeyError, ValueError):
        return None


def create_invite_token(user_id: int, org_id: int) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=7)
    payload = {"sub": str(user_id), "org": org_id, "typ": "invite", "exp": expire}
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=ALGORITHM)


def decode_invite_token(token: str) -> dict | None:
    try:
        data = jwt.decode(token, settings.SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.PyJWTError:
        return None
    if data.get("typ") != "invite":
        return None
    try:
        return {"user_id": int(data["sub"]), "org_id": int(data["org"])}
    except (KeyError, ValueError):
        return None


def create_reset_token(user: object) -> str:
    """JWT reset token. Includes pwh so it auto-invalidates after password change."""
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.PASSWORD_RESET_TTL_MINUTES)
    pwh: str = getattr(user, "password_hash", "") or ""
    payload = {
        "sub": str(getattr(user, "id")),
        "typ": "pwd_reset",
        "pwh": pwh[:16],
        "exp": expire,
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=ALGORITHM)
