"""Horoshop automatic order synchronization worker."""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from app.core.db import SessionLocal
import app.models.tag  # noqa: F401 — register Tag mapper before worker models are used
from app.models.organization import Organization
from app.models.warehouse import HoroshopSyncEvent
from app.services import horoshop

log = logging.getLogger("monofarm.horoshop.sync")


def _configured_org_ids(db) -> list[int]:
    return [
        org_id
        for (org_id,) in (
            db.query(Organization.id)
            .filter(
                Organization.horoshop_domain != "",
                Organization.horoshop_login != "",
                Organization.horoshop_password != "",
            )
            .all()
        )
    ]


def _record_error(org_id: int, exc: Exception, db) -> None:
    db.add(HoroshopSyncEvent(
        organization_id=org_id,
        event_type="auto_sync",
        external_order_id=None,
        payload={"source": "scheduler"},
        status="error",
        message=str(exc)[:1000],
        created_at=datetime.now(timezone.utc),
        processed_at=datetime.now(timezone.utc),
    ))
    db.commit()


def process_auto_horoshop_sync(*, session_factory=SessionLocal) -> dict[str, Any]:
    """Poll recent Horoshop orders for every configured organization.

    Webhooks are still the fastest path, but this scheduled poll closes gaps
    when a shop webhook is not subscribed, is delayed, or was missed during a
    deploy. APScheduler runs this as a single leader job.
    """
    with session_factory() as db:
        org_ids = _configured_org_ids(db)

    checked = synced = errors = seen = created = updated = unmatched = 0
    for org_id in org_ids:
        checked += 1
        with session_factory() as db:
            org = db.get(Organization, org_id)
            if not org or not horoshop.configured(org):
                continue
            try:
                result = horoshop.sync_recent(org, db)
            except Exception as exc:
                db.rollback()
                _record_error(org_id, exc, db)
                errors += 1
                log.warning("Horoshop auto-sync failed org=%s: %s", org_id, exc)
                continue

            synced += 1
            seen += int(result.get("seen", 0))
            created += int(result.get("created", 0))
            updated += int(result.get("updated", 0))
            unmatched += int(result.get("unmatched", 0))

    return {
        "checked": checked,
        "synced": synced,
        "errors": errors,
        "seen": seen,
        "created": created,
        "updated": updated,
        "unmatched": unmatched,
    }
