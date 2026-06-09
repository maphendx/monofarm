
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, get_current_user, require_roles
from app.core.db import get_db
from app.core.ratelimit import limiter
from app.core.security import create_access_token, create_verify_token, hash_password
from app.services import bambu_provider
from app.services import email as email_svc
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
    from decimal import Decimal
    return OrgSettingsOut(
        id=org.id,
        name=org.name,
        slug=org.slug,
        bambu_email=org.bambu_email,
        bambu_region=org.bambu_region,
        bambu_configured=bool((org.bambu_email and org.bambu_password) or org.bambu_refresh_token),
        tg_configured=bool(org.tg_bot_token),
        tg_bot_username=org.tg_bot_username or None,
        electricity_rate=org.electricity_rate or Decimal("4.5"),
        labor_rate=org.labor_rate or Decimal("150"),
    )


def _unique_slug(db: Session, base: str) -> str:
    slug = base
    n = 2
    while db.query(Organization).filter(Organization.slug == slug).first():
        slug = f"{base}-{n}"
        n += 1
    return slug


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit("10/hour")
def register(request: Request, payload: OrgRegisterRequest, db: Session = Depends(get_db)) -> TokenResponse:
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

    # Best-effort verification email — never fail registration if email errors
    try:
        from app.core.config import settings as _s
        vtoken = create_verify_token(user.id)
        verify_url = f"{_s.FARM_PUBLIC_URL}/verify-email?token={vtoken}"
        email_svc.send_email_verification(user.email, user.name, verify_url)
    except Exception:
        pass

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

    if payload.electricity_rate is not None:
        org.electricity_rate = payload.electricity_rate
    if payload.labor_rate is not None:
        org.labor_rate = payload.labor_rate

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
@limiter.limit("5/minute")
def bambu_send_code(
    request: Request,
    payload: BambuSendCodeRequest,
    org: Organization = Depends(get_current_org),
    _admin: User = Depends(require_roles(UserRole.admin)),
) -> dict:
    """Send a 6-digit email verification code via Bambu API (works for Google/OAuth accounts)."""
    _ = request
    base = _bambu_api_base(payload.region or org.bambu_region or "eu")
    try:
        resp = bambu_provider.send_email_code(base, payload.email)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Bambu API недоступний: {e}") from e

    if resp.status_code not in (200, 201):
        msg = f"Bambu verification code request failed (HTTP {resp.status_code})"
        raise HTTPException(status_code=400, detail=msg)
    return {"ok": True}


@router.post("/me/bambu-verify-code", response_model=OrgSettingsOut)
@limiter.limit("5/minute")
async def bambu_verify_code(
    request: Request,
    payload: BambuVerifyCodeRequest,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _admin: User = Depends(require_roles(UserRole.admin)),
) -> OrgSettingsOut:
    """Verify email code → get Bambu token → save to org settings via bambu_auth."""
    _ = request
    from app.services import bambu, bambu_auth
    from app.services.encryption import encrypt

    region = payload.region or org.bambu_region or "eu"
    try:
        result = bambu_auth.login_with_email_code(payload.email, payload.code, region)
    except bambu_auth.BambuAuthError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    org.bambu_email = encrypt(payload.email)
    if payload.region:
        org.bambu_region = payload.region
    db.commit()

    # Persists access/refresh token, expiry, auth_type, user_id and clears reauth flags.
    bambu_auth.store_auth_result(org.id, result)
    db.refresh(org)

    await bambu.shutdown(org.id)
    await bambu.init(org)

    return _org_settings_out(org)


class ExtraSlotsPayload(BaseModel):
    slots: int


@router.post("/me/extra-printer-slots")
def set_extra_printer_slots(
    payload: ExtraSlotsPayload,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
    _admin: User = Depends(require_roles(UserRole.admin)),
) -> dict:
    """Set purchased extra printer slots (called after successful Paddle payment)."""
    from app.models.organization import PLAN_MAX_PRINTERS, EXTRA_PRINTER_PRICE_USD, PLAN_LIMITS
    if EXTRA_PRINTER_PRICE_USD.get(org.plan) is None:
        raise HTTPException(status_code=400, detail="Extra printer slots not available on your plan")
    max_printers = PLAN_MAX_PRINTERS[org.plan]
    base = PLAN_LIMITS[org.plan]["printers"]
    if max_printers is not None:
        allowed_extra = max_printers - base
        if payload.slots > allowed_extra:
            raise HTTPException(status_code=400, detail=f"Maximum {allowed_extra} extra slots on this plan")
    if payload.slots < 0:
        raise HTTPException(status_code=400, detail="slots must be >= 0")
    org.extra_printer_slots = payload.slots
    db.commit()
    from app.api.deps import printer_limit
    return {
        "extra_slots": org.extra_printer_slots,
        "limit": printer_limit(org),
        "plan": org.plan,
    }
