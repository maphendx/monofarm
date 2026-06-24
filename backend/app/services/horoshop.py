from __future__ import annotations

import logging
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any

import requests
import urllib3
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.organization import Organization
from app.models.warehouse import (
    CashTransaction,
    CashTxCategory,
    CashTxType,
    Counterparty,
    CounterpartyType,
    HoroshopSyncEvent,
    Order,
    OrderItem,
    OrderPayment,
    OrderSource,
    OrderStatus,
    Product,
)
from app.services.encryption import decrypt

log = logging.getLogger("monofarm.horoshop")

_TOKEN_CACHE: dict[int, tuple[str, float]] = {}
_EVENTS = ("order_created", "order_paid", "order_update")
AUTO_SYNC_INTERVAL_MINUTES = 5


class HoroshopError(RuntimeError):
    pass


def normalize_domain(value: str) -> str:
    domain = (value or "").strip().rstrip("/")
    if re.match(r"^https?://", domain, flags=re.I):
        scheme, rest = domain.split("://", 1)
        host = rest.split("/", 1)[0].strip()
        return f"{scheme.lower()}://{host}"
    domain = domain.split("/", 1)[0].strip()
    return domain


def configured(org: Organization) -> bool:
    return bool(org.horoshop_domain and org.horoshop_login and org.horoshop_password)


def webhook_secret(org: Organization) -> str:
    if not org.horoshop_webhook_secret:
        org.horoshop_webhook_secret = secrets.token_urlsafe(24)
    return org.horoshop_webhook_secret


def webhook_events() -> tuple[str, ...]:
    return _EVENTS


def _base_url(org: Organization) -> str:
    domain = normalize_domain(org.horoshop_domain)
    if not domain:
        raise HoroshopError("Домен Хорошопа не налаштовано")
    if re.match(r"^https?://", domain, flags=re.I):
        return f"{domain}/api"
    return f"https://{domain}/api"


def _decimal(value: Any, default: str = "0") -> Decimal:
    try:
        return Decimal(str(value if value is not None else default))
    except (InvalidOperation, ValueError):
        return Decimal(default)


def _int(value: Any, default: int = 0) -> int:
    try:
        return int(Decimal(str(value)))
    except Exception:
        return default


def _api_post(org: Organization, function: str, payload: dict[str, Any], timeout: int = 20) -> dict[str, Any]:
    url = f"{_base_url(org)}/{function.strip('/')}/"
    verify_ssl = bool(getattr(org, "horoshop_verify_ssl", True))
    if not verify_ssl:
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    try:
        resp = requests.post(
            url,
            json=payload,
            headers={"Content-Type": "application/json"},
            timeout=timeout,
            verify=verify_ssl,
        )
    except requests.RequestException as exc:
        raise HoroshopError(f"Хорошоп API недоступний: {exc}") from exc

    if resp.status_code not in (200, 201):
        raise HoroshopError(f"Хорошоп API HTTP {resp.status_code}: {resp.text[:300]}")
    try:
        data = resp.json()
    except ValueError as exc:
        raise HoroshopError("Хорошоп повернув не JSON-відповідь") from exc
    return data


def auth_token(org: Organization, force: bool = False) -> str:
    cached = _TOKEN_CACHE.get(org.id)
    now = time.monotonic()
    if cached and not force and cached[1] > now:
        return cached[0]

    password = decrypt(org.horoshop_password)
    if not org.horoshop_login or not password:
        raise HoroshopError("Логін або пароль Хорошопа не налаштовано")

    data = _api_post(org, "auth", {"login": org.horoshop_login, "password": password}, timeout=15)
    if data.get("status") != "OK":
        msg = (data.get("response") or {}).get("message") or data.get("message") or "помилка авторизації"
        raise HoroshopError(f"Хорошоп auth: {msg}")
    token = (data.get("response") or {}).get("token")
    if not token:
        raise HoroshopError("Хорошоп auth не повернув token")
    _TOKEN_CACHE[org.id] = (token, now + 540)
    return token


def request(org: Organization, function: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    body = {"token": auth_token(org), **(payload or {})}
    data = _api_post(org, function, body)
    if data.get("status") == "ERROR":
        message = str((data.get("response") or {}).get("message") or data.get("message") or "")
        if "token" in message.lower() or "автор" in message.lower():
            body["token"] = auth_token(org, force=True)
            data = _api_post(org, function, body)
    return data


def test_connection(org: Organization) -> dict[str, Any]:
    token = auth_token(org, force=True)
    return {"ok": True, "token_preview": f"{token[:4]}…{token[-4:]}"}


def get_orders(
    org: Organization,
    *,
    ids: list[str] | None = None,
    from_dt: datetime | None = None,
    to_dt: datetime | None = None,
    statuses: list[int] | None = None,
    additional_data: bool = True,
    offset: int | None = None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    payload: dict[str, Any] = {"additionalData": additional_data}
    if ids:
        payload["ids"] = ids
    if from_dt:
        payload["from"] = from_dt.strftime("%Y-%m-%d %H:%M:%S")
    if to_dt:
        payload["to"] = to_dt.strftime("%Y-%m-%d %H:%M:%S")
    if statuses:
        payload["status"] = statuses
    if offset is not None:
        payload["offset"] = offset
    if limit is not None:
        payload["limit"] = limit

    data = request(org, "orders/get", payload)
    if data.get("status") == "EMPTY":
        return []
    if data.get("status") != "OK":
        msg = (data.get("response") or {}).get("message") or data.get("message") or "orders/get failed"
        raise HoroshopError(str(msg))
    return list((data.get("response") or {}).get("orders") or [])


def subscribe_hook(org: Organization, event: str, target_url: str) -> int:
    if event not in _EVENTS:
        raise HoroshopError(f"Непідтримувана подія Хорошопа: {event}")
    data = request(org, "hooks/subscribe", {"event": event, "target_url": target_url})
    hook_id = data.get("id") or (data.get("response") or {}).get("id")
    if not hook_id:
        msg = (data.get("response") or {}).get("message") or data.get("message") or "hook id missing"
        raise HoroshopError(f"Не вдалося підписатися на {event}: {msg}")
    return int(hook_id)


_STATUS_MAP = {
    1: OrderStatus.new,
    2: OrderStatus.in_production,
    # Horoshop delivery statuses do not tell us which warehouse/cells were picked.
    # Keep stock movements explicit via the warehouse ship flow.
    3: OrderStatus.ready,
    4: OrderStatus.cancelled,
    6: OrderStatus.ready,
}


def _find_or_create_counterparty(org: Organization, order_data: dict[str, Any], db: Session) -> Counterparty | None:
    name = (order_data.get("delivery_name") or "").strip()
    email = (order_data.get("delivery_email") or "").strip() or None
    phone = (order_data.get("delivery_phone") or "").strip() or None
    user_id = str(order_data.get("user") or "").strip() or None
    external_id = f"horoshop:user:{user_id}" if user_id else None

    if not any([name, email, phone, external_id]):
        return None

    cp: Counterparty | None = None
    if external_id:
        cp = db.query(Counterparty).filter_by(organization_id=org.id, external_id=external_id).first()
    if not cp and email:
        cp = db.query(Counterparty).filter_by(organization_id=org.id, email=email).first()
    if not cp and phone:
        cp = db.query(Counterparty).filter_by(organization_id=org.id, phone=phone).first()
    if not cp and name:
        cp = db.query(Counterparty).filter_by(organization_id=org.id, name=name).first()

    address_parts = [
        order_data.get("delivery_country"),
        order_data.get("delivery_city_stable") or order_data.get("delivery_city"),
        order_data.get("delivery_address"),
    ]
    address = ", ".join(str(p).strip() for p in address_parts if p)

    if cp:
        if external_id and not cp.external_id:
            cp.external_id = external_id
        if email and not cp.email:
            cp.email = email
        if phone and not cp.phone:
            cp.phone = phone
        if address and not cp.address:
            cp.address = address
        return cp

    cp = Counterparty(
        organization_id=org.id,
        type=CounterpartyType.customer,
        name=name or email or phone or external_id or "Клієнт Хорошоп",
        email=email,
        phone=phone,
        address=address or None,
        external_id=external_id,
    )
    db.add(cp)
    db.flush()
    return cp


def _notes(order_data: dict[str, Any], unmatched: list[str]) -> str | None:
    parts: list[str] = []
    if order_data.get("comment"):
        parts.append(str(order_data["comment"]))
    if order_data.get("manager_comment"):
        parts.append(f"[менеджер] {order_data['manager_comment']}")
    delivery = order_data.get("delivery_type") or {}
    payment = order_data.get("payment_type") or {}
    delivery_title = delivery.get("title") if isinstance(delivery, dict) else None
    payment_title = payment.get("title") if isinstance(payment, dict) else None
    meta = [
        f"Статус Хорошоп: {order_data.get('stat_status')}" if order_data.get("stat_status") else None,
        f"Доставка: {delivery_title}" if delivery_title else None,
        f"Оплата: {payment_title}" if payment_title else None,
        f"ТТН: {order_data.get('np_number')}" if order_data.get("np_number") else None,
        "Без дзвінка" if order_data.get("order_without_callback") else None,
    ]
    meta = [m for m in meta if m]
    if meta:
        parts.append("[Хорошоп] " + "; ".join(meta))
    parts.extend(unmatched)
    return "\n".join(parts) or None


def _sync_payment(org: Organization, order: Order, order_data: dict[str, Any], db: Session) -> None:
    if _int(order_data.get("payed")) != 1:
        return
    total = order.total_amount or Decimal("0")
    amount = total - (order.paid_amount or Decimal("0"))
    if amount <= 0:
        return

    paid_at = datetime.now(timezone.utc).date()
    tx = CashTransaction(
        organization_id=org.id,
        type=CashTxType.income,
        category=CashTxCategory.order_payment,
        amount=amount,
        counterparty_id=order.counterparty_id,
        order_id=order.id,
        description=f"Оплата Хорошоп {order.order_number}",
        transaction_date=paid_at,
    )
    db.add(tx)
    db.flush()
    payment = OrderPayment(
        organization_id=org.id,
        order_id=order.id,
        amount=amount,
        paid_at=paid_at,
        method=((order_data.get("payment_type") or {}).get("title") if isinstance(order_data.get("payment_type"), dict) else None),
        note="Автоматично синхронізовано з Хорошопа",
        cashflow_id=tx.id,
    )
    db.add(payment)
    order.paid_amount = (order.paid_amount or Decimal("0")) + amount
    if order.counterparty_id:
        cp = db.query(Counterparty).with_for_update().filter_by(id=order.counterparty_id).first()
        if cp:
            cp.balance -= amount


def sync_order_payload(org: Organization, order_data: dict[str, Any], db: Session) -> tuple[Order, bool, list[str]]:
    ext_id = str(order_data.get("order_id") or "").strip()
    if not ext_id:
        raise HoroshopError("Замовлення Хорошопа без order_id")

    status_id = _int(order_data.get("stat_status"), 1)
    our_status = _STATUS_MAP.get(status_id, OrderStatus.new)
    cp = _find_or_create_counterparty(org, order_data, db)
    total = _decimal(order_data.get("total_sum"))
    currency = (order_data.get("currency") or "UAH").strip()[:3] or "UAH"
    external_id = f"horoshop:{ext_id}"

    order = db.query(Order).filter_by(
        organization_id=org.id,
        source=OrderSource.horoshop,
        external_id=external_id,
    ).first()
    if not order:
        order = db.query(Order).filter_by(organization_id=org.id, order_number=f"HS-{ext_id}").first()

    created = order is None
    if created:
        order = Order(
            organization_id=org.id,
            order_number=f"HS-{ext_id}",
            source=OrderSource.horoshop,
            external_id=external_id,
        )
        db.add(order)
        db.flush()

    assert order is not None
    order.counterparty_id = cp.id if cp else order.counterparty_id
    order.customer_name = order_data.get("delivery_name") or order.customer_name
    order.status = our_status
    order.total_amount = total
    order.currency = currency
    order.external_payload = order_data

    existing_items = db.query(OrderItem).filter_by(order_id=order.id).all()
    can_replace_items = created or not existing_items or (
        order.status in (OrderStatus.new, OrderStatus.in_production)
        and not any(item.warehouse_id for item in existing_items)
    )

    unmatched: list[str] = []
    if can_replace_items:
        for item in existing_items:
            db.delete(item)
        db.flush()

        for line in order_data.get("products") or []:
            sku = str(line.get("article") or "").strip()
            qty = max(1, _int(line.get("quantity"), 1))
            price = _decimal(line.get("price"))
            title = str(line.get("title") or sku or "Товар").strip()
            product = None
            if sku:
                product = db.query(Product).filter_by(organization_id=org.id, sku=sku).first()
            if not product:
                unmatched.append(f"[Хорошоп] {title} x{qty} @ {price} (SKU {sku or 'без SKU'} не знайдено)")
                continue
            db.add(OrderItem(
                order_id=order.id,
                product_id=product.id,
                quantity=qty,
                unit_price=price,
                total_price=_decimal(line.get("total_price"), str(price * qty)),
            ))

    order.notes = _notes(order_data, unmatched)
    _sync_payment(org, order, order_data, db)
    return order, created, unmatched


def sync_orders(
    org: Organization,
    db: Session,
    *,
    ids: list[str] | None = None,
    from_dt: datetime | None = None,
    to_dt: datetime | None = None,
    statuses: list[int] | None = None,
    limit: int = 100,
    max_pages: int = 5,
) -> dict[str, Any]:
    if not configured(org):
        raise HoroshopError("Інтеграцію Хорошопа не налаштовано")

    created = updated = unmatched = 0
    seen = 0

    if ids:
        pages = [get_orders(org, ids=ids, additional_data=True)]
    else:
        pages = []
        for page in range(max_pages):
            rows = get_orders(
                org,
                from_dt=from_dt,
                to_dt=to_dt,
                statuses=statuses,
                additional_data=True,
                offset=page * limit,
                limit=limit,
            )
            pages.append(rows)
            if len(rows) < limit:
                break

    for rows in pages:
        for row in rows:
            order, was_created, missing = sync_order_payload(org, row, db)
            seen += 1
            created += 1 if was_created else 0
            updated += 0 if was_created else 1
            unmatched += len(missing)

    org.horoshop_last_sync_at = datetime.now(timezone.utc)
    db.commit()
    return {"seen": seen, "created": created, "updated": updated, "unmatched": unmatched}


def sync_recent(org: Organization, db: Session) -> dict[str, Any]:
    start = org.horoshop_last_sync_at
    if not start:
        start = datetime.now(timezone.utc) - timedelta(days=14)
    else:
        start = start - timedelta(minutes=30)
    return sync_orders(org, db, from_dt=start, limit=100, max_pages=10)


def extract_order_ids(payload: Any) -> list[str]:
    ids: list[str] = []

    def add(value: Any) -> None:
        if value is None:
            return
        text = str(value).strip()
        if text and text not in ids:
            ids.append(text)

    def walk(value: Any, parent: str = "") -> None:
        if isinstance(value, dict):
            for key, val in value.items():
                k = str(key)
                lk = k.lower()
                if lk in {"order_id", "orderid", "order_number", "ordernumber"}:
                    add(val)
                elif lk == "id" and parent.lower() in {"order", "data", "payload"}:
                    add(val)
                walk(val, k)
        elif isinstance(value, list):
            for item in value:
                walk(item, parent)

    walk(payload)
    return ids


def process_event(event_id: int, db: Session) -> dict[str, Any]:
    event = db.get(HoroshopSyncEvent, event_id)
    if not event:
        raise HoroshopError("Подію Хорошопа не знайдено")
    org = db.get(Organization, event.organization_id)
    if not org:
        raise HoroshopError("Організацію події Хорошопа не знайдено")

    try:
        ids = [event.external_order_id] if event.external_order_id else extract_order_ids(event.payload or {})
        if ids:
            result = sync_orders(org, db, ids=ids)
        else:
            result = sync_recent(org, db)
        event.status = "synced"
        event.message = f"seen={result['seen']} created={result['created']} updated={result['updated']}"
        event.processed_at = datetime.now(timezone.utc)
        db.commit()
        return result
    except Exception as exc:
        db.rollback()
        event = db.get(HoroshopSyncEvent, event_id)
        if event:
            event.status = "error"
            event.message = str(exc)[:1000]
            event.processed_at = datetime.now(timezone.utc)
            db.commit()
        raise


def sync_stats(org: Organization, db: Session) -> dict[str, Any]:
    total = db.query(func.count(Order.id)).filter_by(organization_id=org.id, source=OrderSource.horoshop).scalar() or 0
    errors = db.query(func.count(HoroshopSyncEvent.id)).filter_by(organization_id=org.id, status="error").scalar() or 0
    last_event = (
        db.query(HoroshopSyncEvent)
        .filter_by(organization_id=org.id)
        .order_by(HoroshopSyncEvent.created_at.desc())
        .first()
    )
    return {
        "orders_total": total,
        "errors_total": errors,
        "last_event_status": last_event.status if last_event else None,
        "last_event_message": last_event.message if last_event else None,
    }
