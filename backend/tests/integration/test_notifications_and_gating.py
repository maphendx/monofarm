"""Ready-made notification rules + experimental workflow-editor gating.

Notifications must work without the workflow engine, respect the org toggles,
never spam on repeated reports, and never break the flows that trigger them.
The experimental editor is opt-in per org; already-active automations keep
executing while the flag is off.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from app.models.filament import Filament
from app.models.telegram_notification import TelegramNotification
from app.models.workflow import Workflow, WorkflowRun
from app.services import workflow_events
from app.services.telegram_notify import notify_filament_low_if_crossed, send_print_event_notification


@pytest.fixture
def tg_send(monkeypatch) -> MagicMock:
    """Stand-in for the Telegram delivery used by both ready-made rules."""
    send = MagicMock(return_value=2)
    monkeypatch.setattr("app.services.telegram_notify.send_org_notification", send)
    monkeypatch.setattr("app.services.telegram_notify._printer_snapshot", lambda *args: None)
    return send


@pytest.fixture
def filament(db_session, test_org) -> Filament:
    row = Filament(
        organization_id=test_org.id,
        brand="TestBrand", material="PLA", color="Black",
        grams_remaining=150, min_grams=100, cost_per_kg=500,
    )
    db_session.add(row)
    db_session.commit()
    db_session.refresh(row)
    return row


def _deliver(db):
    from sqlalchemy.orm import sessionmaker
    from app.services.telegram_notify import process_pending_notifications
    db.commit()
    result = process_pending_notifications(session_factory=sessionmaker(bind=db.get_bind()))
    db.expire_all()
    return result


# ── ready-made rule: print failed ────────────────────────────────────────────


def test_print_failed_notification_respects_org_toggle(db_session, test_org, tg_send):
    test_org.notify_print_failed = False
    db_session.commit()

    sent = send_print_event_notification(
        db_session, test_org.id, event="failed",
        printer_name="P1", printer_id=None, file_name="x.gcode",
    )
    assert sent == 0
    tg_send.assert_not_called()


def test_print_failed_notification_sends_when_enabled(db_session, test_org, tg_send):
    assert test_org.notify_print_failed is True
    sent = send_print_event_notification(
        db_session, test_org.id, event="failed",
        printer_name="P1", printer_id=None, file_name="x.gcode",
    )
    assert sent == 1  # queued, never delivered inside the source transaction
    tg_send.assert_not_called()
    _deliver(db_session)
    tg_send.assert_called_once()


# ── ready-made rule: filament low ────────────────────────────────────────────


def test_filament_low_notifies_once_per_drop_and_rearms_after_refill(
    db_session, test_org, filament, tg_send,
):

    # Drop below the threshold → one warning.
    filament.grams_remaining = 90
    db_session.commit()
    assert notify_filament_low_if_crossed(db_session, test_org.id, filament, prev_grams=150) == 1
    _deliver(db_session)
    assert tg_send.call_count == 1

    # Continued low level: repeated reports never resend.
    filament.grams_remaining = 60
    db_session.commit()
    assert notify_filament_low_if_crossed(db_session, test_org.id, filament, prev_grams=90) == 0
    assert tg_send.call_count == 1

    # Refill above the threshold re-arms the rule silently.
    filament.grams_remaining = 300
    db_session.commit()
    assert notify_filament_low_if_crossed(db_session, test_org.id, filament, prev_grams=60) == 0
    assert tg_send.call_count == 1

    # A new drop after the refill warns again.
    filament.grams_remaining = 80
    db_session.commit()
    assert notify_filament_low_if_crossed(db_session, test_org.id, filament, prev_grams=300) == 1
    _deliver(db_session)
    assert tg_send.call_count == 2



def test_filament_low_respects_org_toggle(db_session, test_org, filament, tg_send):
    test_org.notify_filament_low = False
    db_session.commit()

    filament.grams_remaining = 50
    db_session.commit()
    assert notify_filament_low_if_crossed(db_session, test_org.id, filament, prev_grams=150) == 0
    tg_send.assert_not_called()


def test_filament_low_delivery_failure_never_raises(db_session, test_org, filament, tg_send):
    """A broken Telegram must not break the accounting flow that triggered it."""
    tg_send.side_effect = RuntimeError("telegram down")

    filament.grams_remaining = 10
    db_session.commit()
    assert notify_filament_low_if_crossed(db_session, test_org.id, filament, prev_grams=150) == 1
    _deliver(db_session)
    tg_send.assert_called_once()
    assert db_session.query(TelegramNotification).one().status == "failed"


def test_filament_low_without_telegram_configured_stays_silent(
    db_session, test_org, filament, tg_send, monkeypatch,
):
    """Clear state when the org has no bot: nothing sends and nothing is cached."""
    tg_send.return_value = 0  # send_org_notification no-ops without tg_bot_token

    filament.grams_remaining = 10
    db_session.commit()
    assert notify_filament_low_if_crossed(db_session, test_org.id, filament, prev_grams=150) == 1
    _deliver(db_session)
    tg_send.assert_called_once()


# ── experimental workflow editor gating ──────────────────────────────────────


def _make_webhook_workflow(db_session, test_org) -> Workflow:
    wf = Workflow(
        organization_id=test_org.id,
        name="hooked flow",
        graph={"nodes": [{"key": "t", "type": "trigger.webhook", "config": {"token": "secret123"}, "name": "t", "position": {"x": 0, "y": 0}}], "edges": []},
        enabled=True,
    )
    db_session.add(wf)
    db_session.commit()
    db_session.refresh(wf)
    return wf


def test_editor_disabled_by_default_and_gated(client, auth_headers, db_session, test_org):
    assert test_org.workflows_enabled is False

    assert client.get("/api/workflows", headers=auth_headers).status_code == 200  # view stays possible
    assert client.get("/api/workflows/catalog", headers=auth_headers).status_code == 200
    created = client.post(
        "/api/workflows", json={"name": "New", "graph": {"nodes": [], "edges": []}},
        headers=auth_headers,
    )
    assert created.status_code == 403

    wf = _make_webhook_workflow(db_session, test_org)

    # Existing automations can be viewed and switched off, not edited.
    graph_edit = client.put(
        f"/api/workflows/{wf.id}",
        json={"graph": {"nodes": [], "edges": []}},
        headers=auth_headers,
    )
    assert graph_edit.status_code == 403
    disable = client.put(f"/api/workflows/{wf.id}", json={"enabled": False}, headers=auth_headers)
    assert disable.status_code == 200
    assert disable.json()["enabled"] is False
    wf.enabled = True
    db_session.commit()

    assert client.post(f"/api/workflows/{wf.id}/run", json={}, headers=auth_headers).status_code == 403
    assert client.delete(f"/api/workflows/{wf.id}", headers=auth_headers).status_code == 403

    # Already-active automations keep executing: the webhook trigger still works.
    hook = client.post(f"/api/workflows/hooks/whk-{wf.id}-secret123", json={"go": 1})
    assert hook.status_code == 202
    assert db_session.query(WorkflowRun).filter(WorkflowRun.workflow_id == wf.id).count() == 1


def test_event_execution_continues_while_editor_disabled(db_session, test_org):
    """publish_event must not check the editor flag — live automations keep firing."""
    wf = Workflow(
        organization_id=test_org.id,
        name="event flow",
        graph={"nodes": [{"key": "t", "type": "trigger.event", "config": {"event_type": workflow_events.PRINT_COMPLETED}, "name": "t", "position": {"x": 0, "y": 0}}], "edges": []},
        enabled=True,
    )
    db_session.add(wf)
    db_session.commit()

    created = workflow_events.publish_event(db_session, test_org.id, workflow_events.PRINT_COMPLETED, {})
    assert created == 1
    run = db_session.query(WorkflowRun).filter(WorkflowRun.workflow_id == wf.id).one()
    assert run.status.value == "pending"


def test_admin_enables_experimental_editor(client, auth_headers, db_session, test_org):
    updated = client.put(
        "/api/orgs/me/settings", json={"workflows_enabled": True}, headers=auth_headers,
    )
    assert updated.status_code == 200
    assert updated.json()["workflows_enabled"] is True
    db_session.refresh(test_org)
    assert test_org.workflows_enabled is True

    created = client.post(
        "/api/workflows",
        json={
            "name": "Now allowed",
            "graph": {"nodes": [{"key": "t", "type": "trigger.manual", "config": {}, "name": "t", "position": {"x": 0, "y": 0}}], "edges": []},
        },
        headers=auth_headers,
    )
    assert created.status_code == 201
    assert client.delete(f"/api/workflows/{created.json()['id']}", headers=auth_headers).status_code == 204


def test_org_settings_expose_notification_toggles(client, auth_headers, test_org):
    body = client.get("/api/orgs/me", headers=auth_headers).json()
    assert body["notify_print_failed"] is True
    assert body["notify_filament_low"] is True
    assert body["workflows_enabled"] is False

    updated = client.put(
        "/api/orgs/me/settings",
        json={"notify_print_failed": False, "notify_filament_low": False},
        headers=auth_headers,
    )
    assert updated.status_code == 200
    assert updated.json()["notify_print_failed"] is False
    assert updated.json()["notify_filament_low"] is False


def test_print_queue_survives_restart_and_suppresses_duplicate_producers(db_session, test_org, tg_send):
    """Same run through MQTT + tracker, cache reset, repeat worker poll → one send."""
    from app.services.cache import cache_delete
    from app.services.telegram_notify import send_print_event_notification
    kwargs = dict(event="failed", printer_name="P1", dedupe_key="history:123:failed")
    assert send_print_event_notification(db_session, test_org.id, **kwargs) == 1
    assert send_print_event_notification(db_session, test_org.id, **kwargs) == 0
    tg_send.assert_not_called()
    assert _deliver(db_session) == 1
    cache_delete(f"tg:print-event:{test_org.id}:history:123:failed:P1:-")
    assert send_print_event_notification(db_session, test_org.id, **kwargs) == 0
    assert _deliver(db_session) == 0
    assert tg_send.call_count == 1
    assert db_session.query(TelegramNotification).one().status == "delivered"


def test_rolled_back_stock_never_delivers_notification(db_session, test_org, filament, tg_send):
    with pytest.raises(RuntimeError), db_session.begin_nested():
        filament.grams_remaining = 10
        assert notify_filament_low_if_crossed(db_session, test_org.id, filament, prev_grams=150) == 1
        raise RuntimeError("stock operation rejected")
    assert _deliver(db_session) == 0
    tg_send.assert_not_called()
    assert filament.grams_remaining == 150
    assert filament.low_alert_active is False


def test_ambiguous_delivery_is_not_retried(db_session, test_org, tg_send):
    send_print_event_notification(db_session, test_org.id, event="failed", printer_name="P1", dedupe_key="run:1")
    tg_send.side_effect = TimeoutError("response lost after Telegram accepted message")
    assert _deliver(db_session) == 1
    tg_send.side_effect = None
    assert _deliver(db_session) == 0
    assert tg_send.call_count == 1
    assert db_session.query(TelegramNotification).one().status == "failed"


def test_worker_crash_after_claim_does_not_resend(db_session, test_org, tg_send):
    send_print_event_notification(db_session, test_org.id, event="failed", printer_name="P1", dedupe_key="run:2")
    row = db_session.query(TelegramNotification).one()
    row.status = "attempted"  # committed claim; process dies during delivery
    db_session.commit()
    assert _deliver(db_session) == 0
    tg_send.assert_not_called()


def test_refill_while_disabled_rearms_persistent_state(db_session, test_org, filament, tg_send):
    filament.grams_remaining = 90
    notify_filament_low_if_crossed(db_session, test_org.id, filament, prev_grams=150)
    _deliver(db_session)
    test_org.notify_filament_low = False
    filament.grams_remaining = 200
    notify_filament_low_if_crossed(db_session, test_org.id, filament, prev_grams=90)
    db_session.commit()
    db_session.expire_all()  # new process reads the persistent state
    test_org.notify_filament_low = True
    filament.grams_remaining = 20
    assert notify_filament_low_if_crossed(db_session, test_org.id, filament, prev_grams=200) == 1
    _deliver(db_session)
    assert tg_send.call_count == 2


def test_foreign_filament_cannot_notify(db_session, test_org, filament, tg_send):
    filament.grams_remaining = 10
    assert notify_filament_low_if_crossed(db_session, test_org.id + 100, filament, prev_grams=150) == 0
    assert _deliver(db_session) == 0
    tg_send.assert_not_called()


def _notification_graph(event="print.failed"):
    return {"nodes": [
        {"key": "t", "type": "trigger.event", "config": {"event_type": event}},
        {"key": "send", "type": "action.notify_telegram", "config": {"message": "Print alert"}},
    ], "edges": [{"source": "t", "target": "send", "source_port": "out"}]}


@pytest.mark.parametrize("event,field", [("print.failed", "notify_print_failed"), ("filament.low", "notify_filament_low")])
def test_notification_ownership_must_be_explicit(client, auth_headers, db_session, test_org, event, field):
    test_org.workflows_enabled = True
    db_session.commit()
    body = {"name": "Custom alerts", "graph": _notification_graph(event), "enabled": True}
    assert client.post("/api/workflows", json=body, headers=auth_headers).status_code == 409
    assert client.put("/api/orgs/me/settings", json={field: False}, headers=auth_headers).status_code == 200
    response = client.post("/api/workflows", json=body, headers=auth_headers)
    assert response.status_code == 201, response.text
    workflow_id = response.json()["id"]
    assert client.put("/api/orgs/me/settings", json={field: True}, headers=auth_headers).status_code == 409
    settings = client.get("/api/orgs/me", headers=auth_headers).json()
    assert settings["notification_workflows"][event] == ["Custom alerts"]
    # Hiding the editor preserves discovery, read-only inspection and disable.
    client.put("/api/orgs/me/settings", json={"workflows_enabled": False}, headers=auth_headers)
    assert client.get("/api/auth/me", headers=auth_headers).json()["org_has_workflows"] is True
    assert client.get("/api/workflows/catalog", headers=auth_headers).status_code == 200
    assert client.put(f"/api/workflows/{workflow_id}", json={"enabled": False}, headers=auth_headers).status_code == 200
    assert client.put("/api/orgs/me/settings", json={field: True}, headers=auth_headers).status_code == 200


def test_workflow_sql_failure_does_not_poison_source_transaction(db_session, test_org, monkeypatch):
    from sqlalchemy import text
    wf = Workflow(organization_id=test_org.id, name="Broken", graph=_notification_graph(), enabled=True)
    db_session.add(wf)
    db_session.commit()

    def fail(*args, **kwargs):
        db_session.execute(text("SELECT 1 / 0"))

    monkeypatch.setattr(workflow_events, "create_run", fail)
    test_org.name = "Stock operation still commits"
    assert workflow_events.publish_event(db_session, test_org.id, "print.failed", {}) == 0
    db_session.commit()
    db_session.refresh(test_org)
    assert test_org.name == "Stock operation still commits"


def test_manager_cannot_change_rules_or_editor(client, db_session, test_org):
    from app.models.user import User, UserRole
    from app.core.security import create_access_token
    user = User(organization_id=test_org.id, email="manager-notify@example.test", name="Manager", role=UserRole.manager, password_hash="unused", is_active=True)
    db_session.add(user)
    db_session.commit()
    headers = {"Authorization": "Bearer " + create_access_token(subject=str(user.id), role="manager", org_id=test_org.id)}
    assert client.put("/api/orgs/me/settings", json={"notify_print_failed": False}, headers=headers).status_code == 403
    assert client.put("/api/orgs/me/settings", json={"workflows_enabled": True}, headers=headers).status_code == 403


def test_concurrent_producers_and_workers_send_once(db_engine, monkeypatch):
    """Real independent transactions contend on the unique key and worker claim."""
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier, Event
    from sqlalchemy.orm import sessionmaker
    from app.models.organization import Organization
    from app.services import telegram_notify

    factory = sessionmaker(bind=db_engine)
    with factory() as db:
        org = Organization(name="Concurrent notifications", slug="concurrent-notifications")
        db.add(org)
        db.commit()
        org_id = org.id
    barrier = Barrier(2)
    sending, release = Event(), Event()
    calls = []

    def enqueue():
        with factory() as db:
            barrier.wait(timeout=5)
            result = send_print_event_notification(db, org_id, event="failed", printer_name="P1", dedupe_key="physical-run:1")
            db.commit()
            return result

    def deliver(db, notification):
        calls.append(notification.id)
        sending.set()
        assert release.wait(timeout=5)
        return 1

    monkeypatch.setattr(telegram_notify, "_deliver_notification", deliver)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            first, second = pool.submit(enqueue), pool.submit(enqueue)
            assert sorted([first.result(timeout=10), second.result(timeout=10)]) == [0, 1]
            worker = pool.submit(telegram_notify.process_pending_notifications, session_factory=factory)
            assert sending.wait(timeout=5)
            # The first worker committed its claim before entering delivery.
            assert telegram_notify.process_pending_notifications(session_factory=factory) == 0
            release.set()
            assert worker.result(timeout=5) == 1
        assert len(calls) == 1
        with factory() as db:
            assert db.query(TelegramNotification).filter_by(organization_id=org_id).one().status == "delivered"
    finally:
        release.set()
        with factory() as db:
            db.query(Organization).filter_by(id=org_id).delete()
            db.commit()


def test_untracked_failure_after_worker_restart_queues_once(db_session, test_org, monkeypatch, tg_send):
    from datetime import datetime, timezone
    from app.models.printer import Printer, PrinterKind
    from app.models.print_history import PrintHistory
    from app.services import print_tracker
    from unittest.mock import MagicMock

    printer = Printer(organization_id=test_org.id, name="Restart test", kind=PrinterKind.other, is_active=True)
    db_session.add(printer)
    db_session.flush()
    history = PrintHistory(organization_id=test_org.id, printer_id=printer.id, printer_name=printer.name,
                           file_name="part.gcode", result="in_progress", started_at=datetime.now(timezone.utc))
    db_session.add(history)
    db_session.commit()
    driver = MagicMock()
    driver.get_slot_consumption.return_value = {}
    monkeypatch.setattr("app.services.printer_driver.get_driver", lambda kind: driver)
    monkeypatch.setattr(print_tracker, "_current_state", lambda row: {"state": "error", "error_msg": "Print failed", "file": "part.gcode"})
    print_tracker._prev.clear()
    print_tracker._check_org(db_session, test_org)
    assert history.result == "failed"
    print_tracker._prev.clear()  # simulate another worker restart
    print_tracker._check_org(db_session, test_org)
    assert db_session.query(TelegramNotification).count() == 1
    _deliver(db_session)
    tg_send.assert_called_once()
