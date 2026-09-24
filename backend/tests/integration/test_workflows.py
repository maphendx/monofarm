"""Workflow engine + API integration tests.

External side effects (Telegram, HTTP, print dispatch) are mocked; the engine
runs against the per-test transactional session.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.models.organization import OrgPlan
from app.models.printer import Printer, PrinterKind
from app.models.gcode_file import GcodeFile
from app.models.workflow import Workflow, WorkflowRun, WorkflowRunStatus
from app.services import workflow_engine, workflow_events


@pytest.fixture(autouse=True)
def _enable_experimental_editor(test_org, db_session):
    """These tests exercise the editor itself; the org flag starts enabled."""
    test_org.workflows_enabled = True
    # Tests explicitly choose workflow notification ownership.
    test_org.notify_print_failed = False
    test_org.notify_filament_low = False
    db_session.commit()
    yield


def node(key: str, type_: str, config: dict | None = None, name: str | None = None) -> dict:
    return {"key": key, "type": type_, "config": config or {}, "name": name or key, "position": {"x": 0, "y": 0}}


def edge(src: str, dst: str, port: str | None = None) -> dict:
    out = {"source": src, "target": dst}
    if port:
        out["source_port"] = port
    return out


def make_workflow(db_session, org_id: int, nodes: list, edges: list, *, enabled: bool = True) -> Workflow:
    wf = Workflow(
        organization_id=org_id,
        name="test flow",
        graph={"nodes": nodes, "edges": edges},
        enabled=enabled,
    )
    db_session.add(wf)
    db_session.commit()
    db_session.refresh(wf)
    return wf


async def run_manual(db_session, wf: Workflow, payload: dict | None = None) -> WorkflowRun:
    run = workflow_engine.create_run(db_session, wf, "manual", payload or {})
    db_session.commit()
    await workflow_engine.execute_run(db_session, run)
    return run


# ── engine core ──────────────────────────────────────────────────────────────


async def test_condition_routes_to_taken_branch(db_session, test_org, monkeypatch):
    notify = MagicMock(return_value=3)
    monkeypatch.setattr("app.services.telegram_notify.send_org_notification", notify)

    wf = make_workflow(
        db_session,
        test_org.id,
        [
            node("t", "trigger.manual"),
            node("sv", "flow.set_var", {"assignments": [{"name": "count", "value": "{{trigger.payload.n}}"}]}),
            node("cond", "flow.condition", {"left": "{{vars.count}}", "op": "gte", "right": "5"}),
            node("big", "action.notify_telegram", {"message": "Count: {{vars.count}}"}),
            node("small", "action.notify_telegram", {"message": "small"}),
        ],
        [
            edge("t", "sv"),
            edge("sv", "cond"),
            edge("cond", "big", "true"),
            edge("cond", "small", "false"),
        ],
    )
    run = await run_manual(db_session, wf, {"n": 7})

    assert run.status == WorkflowRunStatus.success
    assert run.variables["count"] == 7
    notify.assert_called_once()
    assert notify.call_args[0][2] == "Count: 7"
    assert run.node_states["big"]["status"] == "success"
    assert run.node_states["small"]["status"] == "skipped"


async def test_condition_false_branch(db_session, test_org, monkeypatch):
    notify = MagicMock(return_value=1)
    monkeypatch.setattr("app.services.telegram_notify.send_org_notification", notify)

    wf = make_workflow(
        db_session,
        test_org.id,
        [
            node("t", "trigger.manual"),
            node("cond", "flow.condition", {"left": "{{trigger.payload.n}}", "op": "lt", "right": "5"}),
            node("yes", "action.notify_telegram", {"message": "yes"}),
            node("no", "action.notify_telegram", {"message": "no"}),
        ],
        [edge("t", "cond"), edge("cond", "yes", "true"), edge("cond", "no", "false")],
    )
    run = await run_manual(db_session, wf, {"n": 9})

    assert run.status == WorkflowRunStatus.success
    notify.assert_called_once_with(db_session, test_org.id, "no", None)


async def test_wait_suspends_and_resumes(db_session, test_org, monkeypatch):
    notify = MagicMock(return_value=1)
    monkeypatch.setattr("app.services.telegram_notify.send_org_notification", notify)

    wf = make_workflow(
        db_session,
        test_org.id,
        [
            node("t", "trigger.manual"),
            node("w", "flow.wait", {"seconds": "3600"}),
            node("n", "action.notify_telegram", {"message": "after wait"}),
        ],
        [edge("t", "w"), edge("w", "n")],
    )
    run = workflow_engine.create_run(db_session, wf, "manual", {})
    db_session.commit()
    await workflow_engine.execute_run(db_session, run)
    assert run.status == WorkflowRunStatus.waiting
    notify.assert_not_called()

    # backdate the wake time and resume (fresh dicts so the JSONB column is flagged dirty)
    states = {k: dict(v) for k, v in run.node_states.items()}
    states["w"]["wake_at"] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
    run.node_states = states
    db_session.commit()
    resumed = await workflow_engine.resume_due_waiting_runs(db_session)
    db_session.refresh(run)
    assert resumed == 1
    assert run.status == WorkflowRunStatus.success
    notify.assert_called_once()


async def test_loop_runs_branch_per_item(db_session, test_org, monkeypatch):
    notify = MagicMock(return_value=1)
    monkeypatch.setattr("app.services.telegram_notify.send_org_notification", notify)

    wf = make_workflow(
        db_session,
        test_org.id,
        [
            node("t", "trigger.manual"),
            node("loop", "flow.loop", {"items": "{{trigger.payload.items}}"}),
            node("n", "action.notify_telegram", {"message": "Item {{item}} #{{index}}"}),
        ],
        [edge("t", "loop"), edge("loop", "n", "each")],
    )
    run = await run_manual(db_session, wf, {"items": ["alpha", "beta", "gamma"]})

    assert run.status == WorkflowRunStatus.success
    assert notify.call_count == 3
    sent = {call.args[2] for call in notify.call_args_list}
    assert sent == {"Item alpha #0", "Item beta #1", "Item gamma #2"}
    done = run.node_states["loop"]["outputs"]["done"]
    assert len(done) == 3


async def test_loop_empty_items_completes_with_no_output(db_session, test_org):
    wf = make_workflow(
        db_session,
        test_org.id,
        [
            node("t", "trigger.manual"),
            node("loop", "flow.loop", {"items": "{{trigger.payload.items}}"}),
        ],
        [edge("t", "loop")],
    )
    run = await run_manual(db_session, wf, {"items": []})
    assert run.status == WorkflowRunStatus.success
    assert run.node_states["loop"]["outputs"]["done"] == []


async def test_loop_missing_items_fails(db_session, test_org):
    wf = make_workflow(
        db_session,
        test_org.id,
        [
            node("t", "trigger.manual"),
            node("loop", "flow.loop", {"items": "{{trigger.payload.items}}"}),
        ],
        [edge("t", "loop")],
    )
    run = await run_manual(db_session, wf, {})
    assert run.status == WorkflowRunStatus.failed
    assert "empty items" in (run.node_states["loop"]["error"] or "").lower()


async def test_set_var_persists_between_nodes(db_session, test_org):
    wf = make_workflow(
        db_session,
        test_org.id,
        [
            node("t", "trigger.manual"),
            node("sv", "flow.set_var", {"assignments": [{"name": "a", "value": "1"}, {"name": "b", "value": "two"}]}),
        ],
        [edge("t", "sv")],
    )
    run = await run_manual(db_session, wf, {})
    assert run.status == WorkflowRunStatus.success
    assert run.variables == {"a": 1, "b": "two"}


# ── events ───────────────────────────────────────────────────────────────────


def test_publish_event_creates_pending_run(db_session, test_org):
    wf = make_workflow(
        db_session,
        test_org.id,
        [node("t", "trigger.event", {"event_type": workflow_events.PRINT_COMPLETED})],
        [],
    )
    created = workflow_events.publish_event(
        db_session, test_org.id, workflow_events.PRINT_COMPLETED, {"printer_name": "U1"}
    )
    assert created == 1
    run = db_session.query(WorkflowRun).filter(WorkflowRun.workflow_id == wf.id).one()
    assert run.status == WorkflowRunStatus.pending
    assert run.trigger_type == workflow_events.PRINT_COMPLETED
    assert run.trigger_payload == {"printer_name": "U1"}


def test_publish_event_respects_filter_and_enabled(db_session, test_org):
    make_workflow(
        db_session,
        test_org.id,
        [
            node(
                "t",
                "trigger.event",
                {"event_type": workflow_events.PRINT_FAILED, "filter": {"printer_name": "U1"}},
            )
        ],
        [],
        enabled=False,
    )
    assert workflow_events.publish_event(db_session, test_org.id, workflow_events.PRINT_FAILED, {"printer_name": "U1"}) == 0

    make_workflow(
        db_session,
        test_org.id,
        [
            node(
                "t2",
                "trigger.event",
                {"event_type": workflow_events.PRINT_FAILED, "filter": {"printer_name": "U1"}},
            )
        ],
        [],
    )
    assert workflow_events.publish_event(db_session, test_org.id, workflow_events.PRINT_FAILED, {"printer_name": "Other"}) == 0
    assert workflow_events.publish_event(db_session, test_org.id, workflow_events.PRINT_FAILED, {"printer_name": "U1"}) == 1


# ── http node ────────────────────────────────────────────────────────────────


async def test_http_request_success(db_session, test_org, monkeypatch):
    resp = MagicMock(status_code=200, ok=True, text='{"x": 1}')
    resp.json.return_value = {"x": 1}
    request_mock = MagicMock(return_value=resp)
    monkeypatch.setattr("app.services.workflow_engine.requests.request", request_mock)

    wf = make_workflow(
        db_session,
        test_org.id,
        [
            node("t", "trigger.manual"),
            node("h", "action.http_request", {"method": "POST", "url": "https://api.example.com/x", "body": {"n": "{{trigger.payload.n}}"}}),
        ],
        [edge("t", "h")],
    )
    run = await run_manual(db_session, wf, {"n": 4})

    assert run.status == WorkflowRunStatus.success
    assert run.node_states["h"]["outputs"]["out"]["status"] == 200
    assert request_mock.call_args.args[:2] == ("POST", "https://api.example.com/x")


async def test_http_request_blocks_internal_hosts(db_session, test_org):
    wf = make_workflow(
        db_session,
        test_org.id,
        [
            node("t", "trigger.manual"),
            node("h", "action.http_request", {"method": "GET", "url": "http://127.0.0.1:8000/api/printers"}),
        ],
        [edge("t", "h")],
    )
    run = await run_manual(db_session, wf, {})
    assert run.status == WorkflowRunStatus.failed
    assert run.node_states["h"]["status"] == "failed"


# ── send_print node ──────────────────────────────────────────────────────────


@pytest.fixture
def moonraker_printer(db_session, test_org):
    printer = Printer(
        organization_id=test_org.id,
        name="MR Test",
        kind=PrinterKind.other,
        moonraker_url="http://printer.local:7125",
        is_active=True,
    )
    db_session.add(printer)
    db_session.flush()
    return printer


@pytest.fixture
def gcode(db_session, test_org):
    f = GcodeFile(
        organization_id=test_org.id,
        stored_name="uuid-1.gcode",
        original_name="part.gcode",
        size_bytes=123,
    )
    db_session.add(f)
    db_session.commit()
    db_session.refresh(f)
    return f


async def test_send_print_dispatches_moonraker_job(db_session, test_org, monkeypatch, moonraker_printer, gcode):
    created = {}
    from app.models.gcode_file_output import GcodeFileOutput
    from app.models.warehouse import Product
    product = Product(organization_id=test_org.id, sku="FLOW-OUTPUT", name="Flow output", unit="pcs")
    db_session.add(product)
    db_session.flush()
    db_session.add(GcodeFileOutput(organization_id=test_org.id, gcode_file_id=gcode.id, product_id=product.id, qty_per_run=8))
    db_session.commit()

    def fake_create_cloud_job(db, **kwargs):
        created.update(kwargs)
        return SimpleNamespace(id=99, status=SimpleNamespace(value="queued"))

    monkeypatch.setattr("app.services.bambu_dispatch.create_cloud_job", fake_create_cloud_job)
    monkeypatch.setattr(
        "app.services.moonraker_dispatch.dispatch_moonraker_job",
        AsyncMock(return_value=SimpleNamespace(status=SimpleNamespace(value="queued"), status_reason=None)),
    )

    wf = make_workflow(
        db_session,
        test_org.id,
        [
            node("t", "trigger.manual"),
            node(
                "p",
                "action.send_print",
                {"printer_id": "{{trigger.payload.pid}}", "file_id": str(gcode.id)},
            ),
        ],
        [edge("t", "p")],
    )
    run = await run_manual(db_session, wf, {"pid": moonraker_printer.id})

    assert run.status == WorkflowRunStatus.success, run.node_states
    assert created["org_id"] == test_org.id
    assert created["printer_id"] == moonraker_printer.id
    assert created["gcode_file_id"] == gcode.id
    assert created["dispatch_mode"] == "moonraker"
    assert created["output_plan"]["items"][0]["product_id"] == product.id
    assert created["output_plan"]["items"][0]["planned_qty"] == 8
    assert created["idempotency_key"].startswith("workflow:")
    assert run.node_states["p"]["outputs"]["out"]["job_id"] == 99


async def test_send_print_fails_for_foreign_printer(db_session, test_org, monkeypatch, gcode):
    wf = make_workflow(
        db_session,
        test_org.id,
        [
            node("t", "trigger.manual"),
            node("p", "action.send_print", {"printer_id": "999999", "file_id": str(gcode.id)}),
        ],
        [edge("t", "p")],
    )
    run = await run_manual(db_session, wf, {})
    assert run.status == WorkflowRunStatus.failed
    assert "printer" in (run.node_states["p"]["error"] or "").lower()


# ── API ──────────────────────────────────────────────────────────────────────


def test_workflow_crud_and_validation(client, auth_headers, db_session, test_org):
    # invalid graph → 400
    bad = client.post(
        "/api/workflows",
        json={"name": "bad", "graph": {"nodes": [node("n", "action.notify_telegram", {"message": "x"})], "edges": []}},
        headers=auth_headers,
    )
    assert bad.status_code == 400

    created = client.post(
        "/api/workflows",
        json={"name": "Notify flow", "graph": {"nodes": [node("t", "trigger.manual")], "edges": []}},
        headers=auth_headers,
    )
    assert created.status_code == 201
    wf_id = created.json()["id"]

    assert client.get("/api/workflows", headers=auth_headers).status_code == 200
    assert client.get(f"/api/workflows/{wf_id}", headers=auth_headers).json()["name"] == "Notify flow"

    updated = client.put(f"/api/workflows/{wf_id}", json={"enabled": True}, headers=auth_headers)
    assert updated.json()["enabled"] is True
    assert updated.json()["version"] == 2

    assert client.delete(f"/api/workflows/{wf_id}", headers=auth_headers).status_code == 204
    assert client.get(f"/api/workflows/{wf_id}", headers=auth_headers).status_code == 404


def test_manual_run_and_stop_endpoints(client, auth_headers, db_session, test_org):
    created = client.post(
        "/api/workflows",
        json={
            "name": "Stoppable",
            "graph": {"nodes": [node("t", "trigger.manual"), node("w", "flow.wait", {"seconds": "60"})], "edges": [edge("t", "w")]},
        },
        headers=auth_headers,
    )
    wf_id = created.json()["id"]

    run_resp = client.post(f"/api/workflows/{wf_id}/run", json={"payload": {}}, headers=auth_headers)
    assert run_resp.status_code == 202
    run_id = run_resp.json()["id"]

    runs = client.get(f"/api/workflows/{wf_id}/runs", headers=auth_headers).json()
    assert [r["id"] for r in runs] == [run_id]

    stopped = client.post(f"/api/workflows/runs/{run_id}/stop", json={}, headers=auth_headers)
    assert stopped.status_code == 200
    assert stopped.json()["status"] == "stopped"


def test_webhook_trigger_creates_run(client, auth_headers, db_session, test_org):
    graph = {"nodes": [node("t", "trigger.webhook")], "edges": []}
    created = client.post(
        "/api/workflows",
        json={"name": "Hooked", "graph": graph, "enabled": True},
        headers=auth_headers,
    )
    assert created.status_code == 201
    body = created.json()
    wf_id = body["id"]
    token = body["graph"]["nodes"][0]["config"]["token"]

    ok = client.post(f"/api/workflows/hooks/whk-{wf_id}-{token}", json={"hello": "world"})
    assert ok.status_code == 202
    assert ok.json()["status"] == "pending"
    run = db_session.query(WorkflowRun).filter(WorkflowRun.workflow_id == wf_id).one()
    assert run.trigger_payload["body"] == {"hello": "world"}

    # wrong token / unknown workflow / disabled → 404
    assert client.post(f"/api/workflows/hooks/whk-{wf_id}-wrongtoken", json={}).status_code == 404
    assert client.post("/api/workflows/hooks/whk-999999-abcdef", json={}).status_code == 404


def test_webhook_disabled_workflow_404(client, auth_headers, db_session, test_org):
    created = client.post(
        "/api/workflows",
        json={"name": "Disabled hook", "graph": {"nodes": [node("t", "trigger.webhook")], "edges": []}},
        headers=auth_headers,
    )
    wf_id = created.json()["id"]
    token = created.json()["graph"]["nodes"][0]["config"]["token"]
    assert client.post(f"/api/workflows/hooks/whk-{wf_id}-{token}", json={}).status_code == 404


def test_order_created_event_starts_workflow(client, auth_headers, db_session, test_org):
    test_org.plan = OrgPlan.starter
    db_session.commit()

    wf = make_workflow(
        db_session,
        test_org.id,
        [node("t", "trigger.event", {"event_type": workflow_events.ORDER_CREATED})],
        [],
    )

    resp = client.post(
        "/api/warehouse/orders",
        json={"customer_name": "Web Client", "items": []},
        headers=auth_headers,
    )
    assert resp.status_code == 201
    run = (
        db_session.query(WorkflowRun)
        .filter(WorkflowRun.workflow_id == wf.id, WorkflowRun.trigger_type == workflow_events.ORDER_CREATED)
        .one()
    )
    assert run.trigger_payload["counterparty"] == "Web Client"


def test_catalog_endpoint(client, auth_headers):
    resp = client.get("/api/workflows/catalog", headers=auth_headers)
    assert resp.status_code == 200
    body = resp.json()
    types = {n["type"] for n in body["nodes"]}
    assert "trigger.event" in types
    assert "action.send_print" in types
    assert any(e["type"] == "print.completed" for e in body["events"])


def test_other_org_isolated(client, auth_headers, db_session, test_org):
    other_org_payload = {
        "name": "Hidden",
        "graph": {"nodes": [node("t", "trigger.manual")], "edges": []},
    }
    created = client.post("/api/workflows", json=other_org_payload, headers=auth_headers)
    wf_id = created.json()["id"]

    # second org
    from app.models.organization import Organization
    org2 = Organization(name="Other Farm", slug="other-farm")
    db_session.add(org2)
    db_session.commit()

    from app.core.security import create_access_token
    from app.models.user import User, UserRole
    user2 = User(
        organization_id=org2.id,
        email="admin2@other.com",
        password_hash="x",
        name="Other Admin",
        role=UserRole.admin,
        is_active=True,
    )
    db_session.add(user2)
    db_session.commit()
    token2 = create_access_token(subject=str(user2.id), role=user2.role.value, org_id=org2.id)

    resp = client.get(f"/api/workflows/{wf_id}", headers={"Authorization": f"Bearer {token2}"})
    assert resp.status_code == 404


# silence ruff about asyncio import used indirectly
_ = asyncio
