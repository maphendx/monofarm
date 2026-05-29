"""Lemon Squeezy billing: checkout, webhook, status."""
import hashlib
import hmac
import json
import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.api.deps import get_current_org, require_roles
from app.core.config import settings
from app.core.db import get_db
from app.models.organization import (
    PLAN_LIMITS,
    PLAN_PRICE_USD,
    YEARLY_DISCOUNT_PCT,
    OrgPlan,
    Organization,
    yearly_price_usd,
)
from app.models.printer import Printer
from app.models.user import User, UserRole

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/billing", tags=["billing"])

_LMSQ_API = "https://api.lemonsqueezy.com/v1"


def _headers() -> dict[str, str]:
    if not settings.LMSQ_API_KEY:
        raise HTTPException(status_code=503, detail="Billing not configured")
    return {
        "Authorization": f"Bearer {settings.LMSQ_API_KEY}",
        "Accept": "application/vnd.api+json",
        "Content-Type": "application/vnd.api+json",
    }


def _variant_for(plan: OrgPlan, interval: str = "month") -> str:
    monthly = {
        OrgPlan.starter: settings.LMSQ_VARIANT_STARTER,
        OrgPlan.pro:     settings.LMSQ_VARIANT_PRO,
        OrgPlan.farm:    settings.LMSQ_VARIANT_FARM,
    }
    yearly = {
        OrgPlan.starter: settings.LMSQ_VARIANT_STARTER_YEARLY,
        OrgPlan.pro:     settings.LMSQ_VARIANT_PRO_YEARLY,
        OrgPlan.farm:    settings.LMSQ_VARIANT_FARM_YEARLY,
    }
    vid = (yearly if interval == "year" else monthly).get(plan, "")
    if not vid:
        raise HTTPException(status_code=503, detail=f"Variant for plan '{plan}' ({interval}) not configured")
    return vid


@router.get("/status")
def billing_status(
    org: Organization = Depends(get_current_org),
    db: Session = Depends(get_db),
) -> dict:
    printer_count = db.query(Printer).filter(Printer.organization_id == org.id).count()
    user_count = db.query(User).filter(User.organization_id == org.id, User.is_active).count()
    from app.models.organization import PLAN_MAX_PRINTERS, EXTRA_PRINTER_PRICE_USD
    from app.api.deps import printer_limit
    effective_limit = printer_limit(org)
    return {
        "plan": org.plan,
        "plan_expires_at": org.plan_expires_at,
        "usage": {"printers": printer_count, "users": user_count},
        "limits": {"printers": effective_limit, "users": PLAN_LIMITS[org.plan]["users"]},
        "price_usd": PLAN_PRICE_USD[org.plan],
        "extra_slots": org.extra_printer_slots or 0,
        "extra_price_usd": EXTRA_PRINTER_PRICE_USD[org.plan],
        "max_printers": PLAN_MAX_PRINTERS[org.plan],
        "yearly_discount_pct": YEARLY_DISCOUNT_PCT,
        "plans": [
            {
                "key": p.value,
                "price_usd": PLAN_PRICE_USD[p],
                "yearly_price_usd": yearly_price_usd(p),
                "limits": PLAN_LIMITS[p],
            }
            for p in OrgPlan
        ],
    }


@router.post("/upgrade-free")
def upgrade_free(
    body: dict,
    org: Organization = Depends(get_current_org),
    _admin: User = Depends(require_roles(UserRole.admin)),
    db: Session = Depends(get_db),
) -> dict:
    """Directly set org plan without payment (dev/beta mode)."""
    try:
        plan = OrgPlan(body.get("plan", ""))
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid plan")
    org.plan = plan
    db.commit()
    return {"ok": True, "plan": plan.value}


@router.post("/checkout")
def create_checkout(
    body: dict,
    org: Organization = Depends(get_current_org),
    _admin: User = Depends(require_roles(UserRole.admin)),
    db: Session = Depends(get_db),
) -> dict:
    try:
        plan = OrgPlan(body.get("plan", ""))
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid plan")
    if plan == OrgPlan.free:
        raise HTTPException(status_code=400, detail="Use cancel to downgrade to free")

    interval = body.get("interval", "month")
    if interval not in ("month", "year"):
        raise HTTPException(status_code=400, detail="Invalid interval")
    discount_code = (body.get("discount_code") or "").strip()

    # Billing not configured → upgrade directly (bootstrap / dev mode)
    if not settings.LMSQ_API_KEY:
        import datetime
        org.plan = plan
        org.plan_expires_at = datetime.datetime.utcnow() + datetime.timedelta(days=3650)
        db.commit()
        log.info("Free upgrade: org %s → %s (billing not configured)", org.id, plan.value)
        return {"url": None, "upgraded": True, "plan": plan.value}

    attributes: dict = {
        "checkout_data": {
            "custom": {"org_id": str(org.id), "plan": plan.value},
        },
        "product_options": {
            "redirect_url": f"{settings.FARM_PUBLIC_URL}/settings?billing=success",
        },
    }
    # Pre-apply a promo code (codes themselves are created in the LS dashboard).
    if discount_code:
        attributes["checkout_data"]["discount_code"] = discount_code

    payload = {
        "data": {
            "type": "checkouts",
            "attributes": attributes,
            "relationships": {
                "store":   {"data": {"type": "stores",   "id": settings.LMSQ_STORE_ID}},
                "variant": {"data": {"type": "variants", "id": _variant_for(plan, interval)}},
            },
        }
    }

    resp = httpx.post(f"{_LMSQ_API}/checkouts", headers=_headers(), json=payload, timeout=10)
    if resp.status_code not in (200, 201):
        log.error("LemonSqueezy checkout error %s: %s", resp.status_code, resp.text)
        raise HTTPException(status_code=502, detail="Failed to create checkout session")

    return {"url": resp.json()["data"]["attributes"]["url"]}


@router.post("/cancel")
def cancel_subscription(
    org: Organization = Depends(get_current_org),
    _admin: User = Depends(require_roles(UserRole.admin)),
    db: Session = Depends(get_db),
) -> dict:
    if not org.payment_subscription_id:
        raise HTTPException(status_code=400, detail="No active subscription")

    resp = httpx.delete(
        f"{_LMSQ_API}/subscriptions/{org.payment_subscription_id}",
        headers=_headers(),
        timeout=10,
    )
    if resp.status_code not in (200, 204):
        log.error("LemonSqueezy cancel error %s: %s", resp.status_code, resp.text)
        raise HTTPException(status_code=502, detail="Failed to cancel subscription")

    org.plan = OrgPlan.free
    org.payment_subscription_id = None
    org.plan_expires_at = None
    db.commit()
    return {"ok": True}


@router.post("/webhook")
async def lmsq_webhook(request: Request, db: Session = Depends(get_db)) -> dict:
    if not settings.LMSQ_WEBHOOK_SECRET:
        raise HTTPException(status_code=503, detail="Webhook secret not configured")

    raw = await request.body()
    sig = request.headers.get("x-signature", "")
    expected = hmac.new(settings.LMSQ_WEBHOOK_SECRET.encode(), raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        raise HTTPException(status_code=400, detail="Invalid signature")

    data = json.loads(raw)
    event = data.get("meta", {}).get("event_name", "")
    custom = data.get("meta", {}).get("custom_data", {})
    attrs = data.get("data", {}).get("attributes", {})
    sub_id = str(data.get("data", {}).get("id", ""))
    customer_id = str(attrs.get("customer_id", ""))
    plan_key = custom.get("plan", "")
    org_id = int(custom.get("org_id", 0) or 0)

    org: Organization | None = db.get(Organization, org_id) if org_id else None

    if event in ("subscription_created", "subscription_updated"):
        if org and plan_key:
            try:
                org.plan = OrgPlan(plan_key)
            except ValueError:
                log.warning("Unknown plan key in webhook: %s", plan_key)
            org.payment_customer_id = customer_id
            org.payment_subscription_id = sub_id
            db.commit()
            log.info("Org %s → plan %s (%s)", org_id, plan_key, event)

    elif event in ("subscription_cancelled", "subscription_expired"):
        if not org:
            org = db.query(Organization).filter(
                Organization.payment_subscription_id == sub_id
            ).first()
        if org:
            org.plan = OrgPlan.free
            org.payment_subscription_id = None
            org.plan_expires_at = None
            db.commit()
            log.info("Org %s → free (%s)", org.id, event)

    return {"ok": True}
