from datetime import datetime, timedelta, timezone

import bcrypt
import jwt

from app.core.config import settings


ALGORITHM = "HS256"


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except ValueError:
        return False


def create_access_token(subject: str, role: str, org_id: int) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {"sub": subject, "role": role, "org_id": org_id, "exp": expire}
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, settings.SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.PyJWTError:
        return None


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


