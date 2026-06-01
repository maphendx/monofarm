import jwt
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, get_current_user
from app.core.config import settings
from app.core.db import get_db
from app.core.security import (
    create_access_token,
    create_reset_token,
    create_verify_token,
    decode_invite_token,
    decode_verify_token,
    hash_password,
    verify_password,
)
from app.models.organization import Organization
from app.models.user import User
from app.schemas.auth import (
    ForgotPasswordRequest,
    LoginRequest,
    ResetPasswordRequest,
    TokenResponse,
    UserOut,
)
from app.core.ratelimit import limiter
from app.services import email


router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=TokenResponse)
@limiter.limit("5/minute")
def login(request: Request, payload: LoginRequest, db: Session = Depends(get_db)) -> TokenResponse:
    user = db.query(User).filter(User.email == payload.email).first()
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Невірний email або пароль")
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Користувача деактивовано")
    token = create_access_token(subject=str(user.id), role=user.role.value, org_id=user.organization_id)
    return TokenResponse(access_token=token)


@router.post("/forgot-password", status_code=status.HTTP_202_ACCEPTED)
@limiter.limit("3/hour")
def forgot_password(request: Request, payload: ForgotPasswordRequest, db: Session = Depends(get_db)) -> dict:
    user = db.query(User).filter(User.email == payload.email).first()
    if user and user.is_active:
        token = create_reset_token(user)
        reset_url = f"{settings.FARM_PUBLIC_URL}/reset-password?token={token}"
        email.send_password_reset(user.email, user.name, reset_url)
    # Always same response — anti-enumeration
    return {"ok": True}


@router.post("/reset-password", status_code=status.HTTP_200_OK)
@limiter.limit("10/hour")
def reset_password(request: Request, payload: ResetPasswordRequest, db: Session = Depends(get_db)) -> dict:
    _bad = HTTPException(status_code=400, detail="Посилання недійсне або застаріло")
    try:
        data = jwt.decode(payload.token, settings.SECRET_KEY, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise _bad
    if data.get("typ") != "pwd_reset":
        raise _bad
    try:
        uid = int(data["sub"])
    except (KeyError, ValueError):
        raise _bad
    user = db.get(User, uid)
    if not user or data.get("pwh") != (user.password_hash or "")[:16]:
        raise _bad
    user.password_hash = hash_password(payload.new_password)
    db.commit()
    return {"ok": True}


@router.get("/me", response_model=UserOut)
def me(
    user: User         = Depends(get_current_user),
    org:  Organization = Depends(get_current_org),
) -> dict:
    return {
        "id":                user.id,
        "email":             user.email,
        "name":              user.name,
        "role":              user.role,
        "org_plan":          org.plan,
        "created_at":        user.created_at,
        "email_verified_at": user.email_verified_at,
        "telegram_chat_id":  user.telegram_chat_id,
    }


class ChangeEmailRequest(BaseModel):
    new_email: EmailStr


class VerifyEmailRequest(BaseModel):
    token: str


@router.post("/verify-email", status_code=status.HTTP_200_OK)
def verify_email(payload: VerifyEmailRequest, db: Session = Depends(get_db)) -> dict:
    uid = decode_verify_token(payload.token)
    if not uid:
        raise HTTPException(status_code=400, detail="Посилання недійсне або застаріло")
    user = db.get(User, uid)
    if not user:
        raise HTTPException(status_code=400, detail="Посилання недійсне або застаріло")
    if user.email_verified_at is None:
        from datetime import datetime, timezone
        user.email_verified_at = datetime.now(timezone.utc)
        db.commit()
    return {"ok": True}


@router.post("/resend-verification", status_code=status.HTTP_202_ACCEPTED)
def resend_verification(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    if current_user.email_verified_at is not None:
        return {"ok": True}
    token = create_verify_token(current_user.id)
    verify_url = f"{settings.FARM_PUBLIC_URL}/verify-email?token={token}"
    email.send_email_verification(current_user.email, current_user.name, verify_url)
    return {"ok": True}


@router.patch("/me/email", status_code=status.HTTP_200_OK)
def change_email(
    payload: ChangeEmailRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    new_email = payload.new_email.lower()
    if new_email == current_user.email.lower():
        raise HTTPException(status_code=400, detail="Це вже ваш поточний email")
    if db.query(User).filter(User.email == new_email).first():
        raise HTTPException(status_code=409, detail="Email вже використовується")
    from datetime import datetime, timezone
    current_user.email = new_email
    current_user.email_verified_at = None
    db.commit()
    token = create_verify_token(current_user.id)
    verify_url = f"{settings.FARM_PUBLIC_URL}/verify-email?token={token}"
    email.send_email_verification(new_email, current_user.name, verify_url)
    return {"ok": True}


class InviteInfo(BaseModel):
    email: str
    org_name: str
    valid: bool


class AcceptInviteRequest(BaseModel):
    token: str
    password: str = Field(min_length=8, max_length=128)


@router.get("/invite/{token}", response_model=InviteInfo)
def get_invite(token: str, db: Session = Depends(get_db)) -> InviteInfo:
    data = decode_invite_token(token)
    if not data:
        return InviteInfo(email="", org_name="", valid=False)
    user = db.get(User, data["user_id"])
    if not user or user.email_verified_at is not None:
        return InviteInfo(email="", org_name="", valid=False)
    org = db.get(Organization, data["org_id"])
    return InviteInfo(email=user.email, org_name=org.name if org else "", valid=True)


@router.post("/accept-invite", status_code=status.HTTP_200_OK)
@limiter.limit("10/hour")
def accept_invite(
    request: Request,
    payload: AcceptInviteRequest,
    db: Session = Depends(get_db),
) -> dict:
    data = decode_invite_token(payload.token)
    if not data:
        raise HTTPException(status_code=400, detail="Посилання недійсне або застаріло")
    user = db.get(User, data["user_id"])
    if not user or user.email_verified_at is not None:
        raise HTTPException(status_code=400, detail="Посилання вже використано")
    from datetime import datetime, timezone
    user.password_hash = hash_password(payload.password)
    user.email_verified_at = datetime.now(timezone.utc)
    db.commit()
    return {"ok": True}
