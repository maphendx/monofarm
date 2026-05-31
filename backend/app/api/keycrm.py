"""KeyCRM webhook integration.

Webhook URL to configure in KeyCRM:
  POST {FARM_PUBLIC_URL}/api/keycrm/webhook/{org_slug}

Signature header: X-KeyCRM-Signature: sha256=<hex>
Secret: the value stored in organizations.keycrm_webhook_secret
"""
import hashlib
import hmac
import json
import logging
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.models.organization import Organization
from app.models.warehouse import (
    Counterparty, CounterpartyType,
    Order, OrderItem, OrderSource, OrderStatus, Product,
)

log = logging.getLogger("monofarm.keycrm")

router = APIRouter(prefix="/keycrm", tags=["keycrm"])

# ── KeyCRM status → our OrderStatus mapping ───────────────────────────────────
# KeyCRM statuses are org-configurable; we map common names to ours.
_STATUS_MAP: dict[str, OrderStatus] = {
    "new":          OrderStatus.new,
    "новий":        OrderStatus.new,
    "нове":         OrderStatus.new,
    "confirmed":    OrderStatus.confirmed,
    "підтверджено": OrderStatus.confirmed,
    "processing":   OrderStatus.in_production,
    "in_progress":  OrderStatus.in_production,
    "в роботі":     OrderStatus.in_production,
    "ready":        OrderStatus.ready,
    "готово":       OrderStatus.ready,
    "shipped":      OrderStatus.shipped,
    "відправлено":  OrderStatus.shipped,
    "completed":    OrderStatus.shipped,
    "cancelled":    OrderStatus.cancelled,
    "скасовано":    OrderStatus.cancelled,
}


def _verify_signature(body: bytes, secret: str, header: str) -> bool:
    """Verify HMAC-SHA256 signature from KeyCRM webhook."""
    expected = "sha256=" + hmac.new(
        secret.encode(), body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, header)


def _find_or_create_counterparty(org: Organization, buyer: dict, db: Session) -> Counterparty | None:
    name  = buyer.get("full_name") or buyer.get("name", "").strip()
    email = (buyer.get("email") or "").strip() or None
    phone = (buyer.get("phone") or "").strip() or None

    if not name:
        return None

    # Try match by external_id (KeyCRM buyer ID), then email, then name
    buyer_ext_id = str(buyer.get("id", "")) if buyer.get("id") else None
    cp: Counterparty | None = None

    if buyer_ext_id:
        cp = db.query(Counterparty).filter_by(
            organization_id=org.id, external_id=f"keycrm:{buyer_ext_id}"
        ).first()

    if not cp and email:
        cp = db.query(Counterparty).filter_by(
            organization_id=org.id, email=email
        ).first()

    if not cp:
        cp = db.query(Counterparty).filter_by(
            organization_id=org.id, name=name
        ).first()

    if cp:
        # Update contact info if missing
        if email and not cp.email:
            cp.email = email
        if phone and not cp.phone:
            cp.phone = phone
        if buyer_ext_id and not cp.external_id:
            cp.external_id = f"keycrm:{buyer_ext_id}"
        return cp

    # Create new counterparty
    cp = Counterparty(
        organization_id=org.id,
        type=CounterpartyType.customer,
        name=name,
        email=email,
        phone=phone,
        external_id=f"keycrm:{buyer_ext_id}" if buyer_ext_id else None,
    )
    db.add(cp)
    db.flush()
    return cp


def _next_order_number(org: Organization, db: Session) -> str:
    count = db.query(Order).filter(Order.organization_id == org.id).count()
    return f"#ORD-{count + 1:04d}"


def _sync_order(org: Organization, payload: dict, db: Session) -> Order:
    """Create or update an Order from a KeyCRM webhook payload."""
    ext_id      = str(payload.get("id", ""))
    keycrm_num  = payload.get("number") or ext_id
    status_raw  = (payload.get("status") or {}).get("name", "new").lower()
    our_status  = _STATUS_MAP.get(status_raw, OrderStatus.new)

    total = Decimal(str(payload.get("total_price") or "0"))
    notes_parts = []
    if payload.get("buyer_comment"):
        notes_parts.append(payload["buyer_comment"])
    if payload.get("manager_comment"):
        notes_parts.append(f"[менеджер] {payload['manager_comment']}")
    notes = "\n".join(notes_parts) or None

    # Counterparty
    buyer = payload.get("buyer") or {}
    cp = _find_or_create_counterparty(org, buyer, db)

    # Find existing order by external_id
    order = db.query(Order).filter_by(
        organization_id=org.id,
        order_number=f"KEY-{keycrm_num}",
    ).first()

    if order:
        order.status         = our_status
        order.total_amount   = total
        order.notes          = notes
        if cp:
            order.counterparty_id = cp.id
        return order

    # Create new order
    order = Order(
        organization_id=org.id,
        order_number=f"KEY-{keycrm_num}",
        counterparty_id=cp.id if cp else None,
        customer_name=buyer.get("full_name") or buyer.get("name"),
        source=OrderSource.keycrm,
        status=our_status,
        total_amount=total,
        notes=notes,
    )
    db.add(order)
    db.flush()

    # Order items — match products by SKU
    for product_line in payload.get("products") or []:
        offer     = product_line.get("offer") or {}
        sku       = (offer.get("sku") or "").strip()
        qty       = int(product_line.get("quantity") or 1)
        price     = Decimal(str(product_line.get("price") or "0"))
        prod_name = (offer.get("product") or {}).get("name") or offer.get("name") or sku

        product: Product | None = None
        if sku:
            product = db.query(Product).filter_by(
                organization_id=org.id, sku=sku
            ).first()

        if product:
            db.add(OrderItem(
                order_id=order.id,
                product_id=product.id,
                quantity=qty,
                unit_price=price,
                total_price=price * qty,
            ))
        else:
            # SKU not found — store as a note so nothing is lost
            unmatched = f"[KeyCRM] {prod_name} ×{qty} @ {price} (SKU {sku!r} не знайдено)"
            order.notes = (order.notes or "") + f"\n{unmatched}"

    return order


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.post("/webhook/{org_slug}", status_code=200)
async def keycrm_webhook(
    org_slug: str,
    request:  Request,
    db:       Session = Depends(get_db),
) -> dict:
    org = db.query(Organization).filter_by(slug=org_slug).first()
    if not org:
        # Return 200 to prevent KeyCRM from disabling the webhook
        log.warning("KeyCRM webhook: unknown org slug %r", org_slug)
        return {"status": "ignored"}

    if not org.keycrm_webhook_secret:
        raise HTTPException(status_code=403, detail="KeyCRM webhook secret not configured")

    body = await request.body()
    sig  = request.headers.get("X-KeyCRM-Signature", "")

    if sig and not _verify_signature(body, org.keycrm_webhook_secret, sig):
        raise HTTPException(status_code=401, detail="Invalid signature")

    try:
        data = json.loads(body)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    event = data.get("event", "order_created")
    log.info("KeyCRM webhook org=%s event=%s", org_slug, event)

    if event in ("order_created", "order_updated", "order_status_changed"):
        order_payload = data.get("data") or data  # KeyCRM sends event+data or flat payload
        try:
            order = _sync_order(org, order_payload, db)
            db.commit()
            log.info("KeyCRM order synced: %s", order.order_number)
        except Exception:
            log.exception("KeyCRM order sync failed")
            db.rollback()
            return {"status": "error", "detail": "sync failed"}

    return {"status": "ok"}
