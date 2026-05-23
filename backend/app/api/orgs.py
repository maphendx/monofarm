import re

import requests as _requests
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, get_current_user, require_roles
from app.core.db import get_db
from app.core.security import create_access_token, hash_password
from app.models.organization import Organization, _slugify
from app.models.user import User, UserRole
from app.schemas.auth import TokenResponse
from app.schemas.org import OrgRegisterRequest, OrgSettingsOut, OrgSettingsUpdate


class BambuSendCodeRequest(BaseModel):
    email: str
    region: str = "eu"


class BambuVerifyCodeRequest(BaseModel):
    email: str
    code: str
    region: str = "eu"


router = APIRouter(prefix="/orgs", tags=["orgs"])


def _org_settings_out(org: Organization) -> OrgSettingsOut:
    return OrgSettingsOut(
        id=org.id,
        name=org.name,
        slug=org.slug,
        bambu_email=org.bambu_email,
        bambu_region=org.bambu_region,
        bambu_configured=bool((org.bambu_email and org.bambu_password) or org.bambu_refresh_token),
        tg_configured=bool(org.tg_bot_token),
        tg_bot_username=org.tg_bot_username or None,
    )


def _unique_slug(db: Session, base: str) -> str:
    slug = base
    n = 2
    while db.query(Organization).filter(Organization.slug == slug).first():
        slug = f"{base}-{n}"
        n += 1
    return slug


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
def register(payload: OrgRegisterRequest, db: Session = Depends(get_db)) -> TokenResponse:
    """Create a new organization and its first admin user."""
    if db.query(User).filter(User.email == payload.admin_email).first():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered")

    slug = _unique_slug(db, _slugify(payload.org_name))
    org = Organization(name=payload.org_name, slug=slug)
    db.add(org)
    db.flush()  # get org.id before creating user

    user = User(
        organization_id=org.id,
        email=payload.admin_email,
        password_hash=hash_password(payload.admin_password),
        name=payload.admin_name,
        role=UserRole.admin,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    token = create_access_token(subject=str(user.id), role=user.role.value, org_id=org.id)
    return TokenResponse(access_token=token)


@router.get("/me", response_model=OrgSettingsOut)
def get_org(
    org: Organization = Depends(get_current_org),
) -> OrgSettingsOut:
    return _org_settings_out(org)


@router.put("/me/settings", response_model=OrgSettingsOut)
async def update_org_settings(
    payload: OrgSettingsUpdate,
    user: User = Depends(get_current_user),
    org: Organization = Depends(get_current_org),
    db: Session = Depends(get_db),
) -> OrgSettingsOut:
    if user.role != UserRole.admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin only")

    if payload.name is not None:
        org.name = payload.name

    from app.services.encryption import encrypt
    if payload.bambu_email is not None:
        org.bambu_email = encrypt(payload.bambu_email)
    if payload.bambu_password is not None:
        org.bambu_password = encrypt(payload.bambu_password)
    if payload.bambu_refresh_token is not None:
        org.bambu_refresh_token = encrypt(payload.bambu_refresh_token)
    if payload.bambu_region is not None:
        org.bambu_region = payload.bambu_region

    tg_token_changed = payload.tg_bot_token is not None
    if tg_token_changed:
        if payload.tg_bot_token:
            org.tg_bot_token = encrypt(payload.tg_bot_token)
        else:
            org.tg_bot_token = ""
        org.tg_bot_username = ""  # agent will refresh after restart

    db.commit()
    db.refresh(org)

    # Re-init Bambu MQTT for this org if Bambu creds changed
    from app.services import bambu, tunnel
    if payload.bambu_email is not None or payload.bambu_password is not None or payload.bambu_refresh_token is not None:
        await bambu.shutdown(org.id)
        await bambu.init(org)

    # Push new TG token to the live agent (if connected)
    if tg_token_changed:
        new_token: str | None = None
        if org.tg_bot_token:
            from app.services.encryption import decrypt
            try:
                new_token = decrypt(org.tg_bot_token)
            except Exception:
                pass
        await tunnel.send_tg_config(org.id, new_token)

    return _org_settings_out(org)


@router.get("/me/keycrm-settings")
def get_keycrm_settings(
    org:    Organization = Depends(get_current_org),
    _admin: User         = Depends(require_roles(UserRole.admin)),
) -> dict:
    from app.core.config import settings as app_settings
    webhook_url = f"{app_settings.FARM_PUBLIC_URL}/api/keycrm/webhook/{org.slug}"
    return {
        "keycrm_api_key":    org.keycrm_api_key or "",
        "keycrm_configured": bool(org.keycrm_webhook_secret),
        "webhook_url":       webhook_url,
    }


@router.put("/me/keycrm-settings")
def update_keycrm_settings(
    payload: dict,
    db:      Session      = Depends(get_db),
    org:     Organization = Depends(get_current_org),
    _admin:  User         = Depends(require_roles(UserRole.admin)),
) -> dict:
    if "keycrm_api_key" in payload:
        org.keycrm_api_key = (payload["keycrm_api_key"] or "").strip()
    if "keycrm_webhook_secret" in payload:
        org.keycrm_webhook_secret = (payload["keycrm_webhook_secret"] or "").strip()
    db.commit()
    from app.core.config import settings as app_settings
    return {
        "keycrm_api_key":    org.keycrm_api_key,
        "keycrm_configured": bool(org.keycrm_webhook_secret),
        "webhook_url":       f"{app_settings.FARM_PUBLIC_URL}/api/keycrm/webhook/{org.slug}",
    }


@router.get("/me/bambu-status")
def bambu_status(
    org: Organization = Depends(get_current_org),
    _admin: User = Depends(require_roles(UserRole.admin)),
) -> dict:
    """Debug: show current in-memory Bambu state for this org."""
    from app.services.bambu import _access_tokens, _user_ids, _mqtt_clients, _dev_to_org
    has_token = bool(_access_tokens.get(org.id))
    user_id = _user_ids.get(org.id, "NOT SET")
    has_mqtt = org.id in _mqtt_clients
    devices = [dev for dev, oid in _dev_to_org.items() if oid == org.id]
    return {
        "bambu_configured": bool((org.bambu_email and org.bambu_password) or org.bambu_refresh_token),
        "has_access_token": has_token,
        "user_id": user_id,
        "mqtt_started": has_mqtt,
        "tracked_devices": devices,
        "region": org.bambu_region,
    }


def _bambu_api_base(region: str) -> str:
    from app.services.bambu import _REGION_HOSTS
    return _REGION_HOSTS.get(region, _REGION_HOSTS["eu"])["api"]


@router.post("/me/bambu-send-code")
def bambu_send_code(
    payload: BambuSendCodeRequest,
    org: Organization = Depends(get_current_org),
    _admin: User = Depends(require_roles(UserRole.admin)),
) -> dict:
    """Send a 6-digit email verification code via Bambu API (works for Google/OAuth accounts)."""
    base = _bambu_api_base(payload.region or org.bambu_region or "eu")
    try:
        resp = _requests.post(
            f"{base}/v1/user-service/user/sendemail/code",
            json={"email": payload.email, "type": "codeLogin"},
            timeout=10,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Bambu API недоступний: {e}") from e

    if resp.status_code not in (200, 201):
        try:
            msg = resp.json().get("message") or resp.text
        except Exception:
            msg = resp.text or f"HTTP {resp.status_code}"
        raise HTTPException(status_code=400, detail=msg)
    return {"ok": True}


@router.post("/me/bambu-verify-code", response_model=OrgSettingsOut)
async def bambu_verify_code(
    payload: BambuVerifyCodeRequest,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _admin: User = Depends(require_roles(UserRole.admin)),
) -> OrgSettingsOut:
    """Verify email code → get Bambu token → save to org settings."""
    base = _bambu_api_base(payload.region or org.bambu_region or "eu")
    try:
        resp = _requests.post(
            f"{base}/v1/user-service/user/login",
            json={"account": payload.email, "code": payload.code},
            timeout=10,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Bambu API недоступний: {e}") from e

    try:
        data = resp.json()
    except Exception:
        raise HTTPException(status_code=502, detail=f"Bambu повернув невалідну відповідь (HTTP {resp.status_code}): {resp.text[:200]}")

    access_token = data.get("accessToken") or data.get("token")
    if not access_token:
        msg = data.get("message") or f"Невірний або прострочений код (HTTP {resp.status_code})"
        raise HTTPException(status_code=400, detail=msg)

    from app.services.encryption import encrypt
    org.bambu_email = encrypt(payload.email)
    # Store the access token (JWT) — MQTT authentication requires the JWT access token,
    # not the opaque refresh token. For Google/email-code accounts the JWT is long-lived.
    org.bambu_refresh_token = encrypt(access_token)
    if payload.region:
        org.bambu_region = payload.region
    db.commit()
    db.refresh(org)

    from app.services import bambu
    bambu._access_tokens[org.id] = access_token
    bambu._regions[org.id] = org.bambu_region or "eu"
    bambu._extract_user_id(org.id, access_token)
    await bambu.shutdown(org.id)
    await bambu.init(org)

    return _org_settings_out(org)
