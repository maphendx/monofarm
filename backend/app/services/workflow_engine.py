"""Resumable workflow graph executor.

Semantics
---------
- A run executes the graph in topological order, one node at a time.
- A node is *ready* when every incoming edge comes from a terminal node and at
  least one edge is active (its source succeeded and produced that output port).
- Untaken branch ports propagate as inactive edges; at run finalization any
  still-pending nodes are marked ``skipped`` (n8n-like branch semantics).
- ``flow.wait`` suspends the whole run (status ``waiting``); the scheduler
  resumes due runs, which continue from the downstream nodes.
- ``flow.loop`` re-executes its ``each``-branch per item in a sub-frame;
  branch results are aggregated on the ``done`` port. Waits inside loops are
  not supported and fail the node.
- Node failures stop the run (status ``failed``); downstream is skipped.
- Every node transition is committed, so crashed workers resume (the run is
  re-executed; node handlers must tolerate re-invocation — dispatch nodes use
  idempotency keys).
- A run can be aborted: the engine re-reads ``run.status`` between nodes and
  stops cleanly when another session set it to ``stopped``.
"""
from __future__ import annotations

import asyncio
import copy
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

import requests
from sqlalchemy.orm import Session

from app.models.workflow import Workflow, WorkflowRun, WorkflowRunStatus
from app.services.workflow_expressions import resolve, to_number
from app.services.workflow_nodes import TRIGGER_TYPES

log = logging.getLogger(__name__)

MAX_HTTP_BODY = 20_000
MAX_LOOP_ITEMS = 200
MAX_WAIT_SECONDS = 30 * 24 * 3600
PERSISTED_LOOP_ITERATIONS = 10

TERMINAL_NODE_STATUSES = {"success", "failed", "skipped"}


@dataclass
class NodeResult:
    status: str  # "success" | "waiting"
    outputs: dict[str, Any] = field(default_factory=dict)
    wake_at: datetime | None = None


class NodeFailure(Exception):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime | None = None) -> str:
    return (dt or _now()).isoformat()


def _safe_json(value: Any, limit: int = MAX_HTTP_BODY) -> Any:
    """JSON-round-trip a payload; oversize values are replaced by a marker."""
    try:
        dump = json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return {"_unserializable": True}
    if len(dump) > limit:
        return {"_truncated": True, "preview": dump[:limit]}
    return json.loads(dump)


def create_run(
    db: Session,
    workflow: Workflow,
    trigger_type: str,
    payload: dict[str, Any] | None,
    fired_node_key: str | None = None,
) -> WorkflowRun:
    """Persist a pending run with its graph snapshot and initial node states."""
    graph = workflow.graph or {}
    fired_node_key = fired_node_key or _pick_trigger_key(graph, trigger_type)
    states: dict[str, Any] = {}
    for node in graph.get("nodes", []):
        key = node.get("key")
        if not key:
            continue
        if node.get("type") in TRIGGER_TYPES:
            if key == fired_node_key:
                states[key] = {
                    "status": "success",
                    "outputs": {"out": _safe_json(payload or {})},
                    "started_at": _iso(),
                    "finished_at": _iso(),
                }
            else:
                states[key] = {"status": "skipped"}
        else:
            states[key] = {"status": "pending"}
    run = WorkflowRun(
        organization_id=workflow.organization_id,
        workflow_id=workflow.id,
        status=WorkflowRunStatus.pending,
        trigger_type=trigger_type,
        trigger_payload=_safe_json(payload or {}),
        graph_snapshot=copy.deepcopy(graph),
        variables={},
        node_states=states,
    )
    db.add(run)
    db.flush()
    return run


def _pick_trigger_key(graph: dict[str, Any], trigger_type: str) -> str | None:
    """Resolve which trigger node fires for a run of ``trigger_type``."""
    fallback: str | None = None
    manual: str | None = None
    event: str | None = None
    for node in graph.get("nodes", []):
        if node.get("type") not in TRIGGER_TYPES:
            continue
        key = node.get("key")
        if node["type"] == "trigger.event" and (node.get("config") or {}).get("event_type") == trigger_type:
            event = key
        elif node["type"] == "trigger.manual":
            manual = key
        if fallback is None:
            fallback = key
    if trigger_type == "manual":
        return manual or fallback
    return event or fallback


# ── executor ─────────────────────────────────────────────────────────────────


class _Executor:
    def __init__(
        self,
        db: Session,
        run: WorkflowRun,
        *,
        states: dict[str, Any] | None = None,
        scope: set[str] | None = None,
        extra_ctx: dict[str, Any] | None = None,
        is_subframe: bool = False,
    ):
        self.db = db
        self.run = run
        self.is_subframe = is_subframe
        graph = run.graph_snapshot or {}
        self.nodes: dict[str, dict[str, Any]] = {
            n["key"]: n for n in graph.get("nodes", []) if n.get("key")
        }
        self.edges: list[dict[str, Any]] = graph.get("edges", [])
        self.states = states if states is not None else (run.node_states or {})
        self.scope = scope
        self.extra_ctx = extra_ctx or {}
        self.frame_error: str | None = None

    # ── context ──

    def _node_ctx(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for key, node in self.nodes.items():
            st = self.states.get(key)
            if not st or st.get("status") != "success":
                continue
            outputs = st.get("outputs") or {}
            single = outputs.get("out") if len(outputs) == 1 and "out" in outputs else outputs
            out[key] = {"name": node.get("name") or node.get("type"), "output": single}
        return out

    def _ctx(self, inputs: Any) -> dict[str, Any]:
        ctx: dict[str, Any] = {
            "trigger": {"type": self.run.trigger_type, "payload": self.run.trigger_payload},
            "vars": self.run.variables,
            "nodes": self._node_ctx(),
            "input": inputs,
        }
        ctx.update(self.extra_ctx)
        return ctx

    def _gather_inputs(self, key: str) -> Any:
        payloads: list[tuple[str, Any]] = []
        for edge in self.edges:
            if edge.get("target") != key:
                continue
            src_key = edge.get("source")
            src = self.states.get(src_key)
            if not src or src.get("status") != "success":
                continue
            port = edge.get("source_port") or "out"
            outputs = src.get("outputs") or {}
            if port in outputs:
                payloads.append((src_key, outputs[port]))
        if not payloads:
            return None
        if len(payloads) == 1:
            return payloads[0][1]
        return {src: payload for src, payload in payloads}

    # ── readiness ──

    def _frame_nodes(self) -> list[str]:
        keys = list(self.nodes.keys())
        if self.scope is None:
            return keys
        return [k for k in keys if k in self.scope]

    def _ready_nodes(self) -> list[str]:
        ready: list[str] = []
        for key in self._frame_nodes():
            node = self.nodes[key]
            if node.get("type") in TRIGGER_TYPES:
                continue
            st = self.states.get(key)
            if not st or st.get("status") != "pending":
                continue
            active = 0
            resolved = True
            for edge in self.edges:
                if edge.get("target") != key:
                    continue
                src = self.states.get(edge.get("source"))
                if src is None:
                    # Sub-frames only carry states for their scope: edges from
                    # outside the branch (other than the loop entry) count as
                    # resolved-inactive.
                    continue
                if src.get("status") not in TERMINAL_NODE_STATUSES:
                    resolved = False
                    break
                if src["status"] == "success" and (edge.get("source_port") or "out") in (src.get("outputs") or {}):
                    active += 1
            if resolved and active > 0:
                ready.append(key)
        return ready

    def _skip_downstream(self, key: str) -> None:
        queue = [key]
        seen = {key}
        while queue:
            cur = queue.pop()
            for edge in self.edges:
                if edge.get("source") != cur:
                    continue
                dst = edge.get("target")
                if dst in seen or dst not in self.nodes:
                    continue
                if self.scope is not None and dst not in self.scope:
                    continue
                seen.add(dst)
                st = self.states.setdefault(dst, {"status": "pending"})
                if st.get("status") == "pending":
                    st["status"] = "skipped"
                queue.append(dst)

    # ── main loop ──

    async def execute(self) -> WorkflowRunStatus:
        if not self.is_subframe:
            if self.run.status in (WorkflowRunStatus.pending, WorkflowRunStatus.waiting):
                self.run.status = WorkflowRunStatus.running
                self.run.started_at = self.run.started_at or _now()
            self.run.node_states = dict(self.states)
            self.db.commit()
            self.states = self.run.node_states or self.states

        while True:
            if not self.is_subframe and self._aborted():
                self.run.finished_at = self.run.finished_at or _now()
                self.db.commit()
                return self.run.status

            progressed = False
            for key in self._ready_nodes():
                progressed = True
                outcome = await self._process(key)
                if not self.is_subframe:
                    self.run.node_states = dict(self.states)
                    self.db.commit()
                if outcome == "waiting":
                    if self.is_subframe:
                        self.frame_error = "Очікування всередині циклу не підтримується / wait inside a loop is not supported"
                        raise NodeFailure(self.frame_error)
                    self.run.status = WorkflowRunStatus.waiting
                    self.db.commit()
                    return self.run.status
                if outcome == "failed":
                    if self.is_subframe:
                        raise NodeFailure(self.frame_error or "Помилка у гілці циклу / loop branch failed")
                    self.run.status = WorkflowRunStatus.failed
                    self.run.finished_at = _now()
                    self.db.commit()
                    return self.run.status
            if not progressed:
                break

        if not self.is_subframe:
            self._finalize()
            self.db.commit()
        return self.run.status

    def _aborted(self) -> bool:
        if self.run.status == WorkflowRunStatus.stopped:
            return True
        self.db.refresh(self.run)  # pick up stop requests from API sessions
        return self.run.status == WorkflowRunStatus.stopped

    def _finalize(self) -> None:
        for st in self.states.values():
            if st.get("status") == "pending":
                st["status"] = "skipped"
        self.run.node_states = dict(self.states)
        self.run.status = WorkflowRunStatus.success
        self.run.finished_at = _now()

    # ── node processing ──

    async def _process(self, key: str) -> str:
        node = self.nodes[key]
        st = self.states.setdefault(key, {"status": "pending"})
        st["status"] = "running"
        st["started_at"] = _iso()
        st.pop("error", None)

        inputs = self._gather_inputs(key)
        ctx = self._ctx(inputs)
        config = resolve(node.get("config") or {}, ctx)

        handler = HANDLERS.get(node.get("type", ""))
        if handler is None:
            st.update({"status": "failed", "error": f"Немає обробника / no handler: {node.get('type')}"})
            self._skip_downstream(key)
            self.frame_error = st["error"]
            return "failed"

        try:
            result = await handler(self, node, config, inputs)
        except NodeFailure as exc:
            log.info("workflow node failed: run=%s node=%s: %s", self.run.id, key, exc)
            st.update({"status": "failed", "error": str(exc)[:2000], "finished_at": _iso()})
            self._skip_downstream(key)
            self.frame_error = st["error"]
            return "failed"
        except Exception as exc:  # noqa: BLE001 — node isolation: report, don't crash the loop
            log.exception("workflow node failed: run=%s node=%s", self.run.id, key)
            st.update({"status": "failed", "error": str(exc)[:2000], "finished_at": _iso()})
            self._skip_downstream(key)
            self.frame_error = st["error"]
            return "failed"

        st["finished_at"] = _iso()
        if result.status == "waiting":
            st["status"] = "waiting"
            st["wake_at"] = _iso(result.wake_at)
            st["input"] = _safe_json(inputs)
            return "waiting"

        st["status"] = "success"
        st["outputs"] = _safe_json(result.outputs) or {}
        return "success"

    # ── loop support ──

    def branch_set(self, loop_key: str, port: str) -> set[str]:
        scope: set[str] = set()
        queue: list[str] = []
        for edge in self.edges:
            if edge.get("source") == loop_key and (edge.get("source_port") or "out") == port:
                dst = edge.get("target")
                if dst and dst in self.nodes and dst != loop_key:
                    scope.add(dst)
                    queue.append(dst)
        while queue:
            cur = queue.pop()
            for edge in self.edges:
                if edge.get("source") != cur:
                    continue
                dst = edge.get("target")
                if dst and dst in self.nodes and dst != loop_key and dst not in scope:
                    scope.add(dst)
                    queue.append(dst)
        return scope


# ── node handlers ────────────────────────────────────────────────────────────


def _num(value: Any) -> float | None:
    return to_number(value)


async def _h_condition(ex: _Executor, node, config, inputs) -> NodeResult:
    left = config.get("left")
    right = config.get("right")
    op = config.get("op") or "eq"

    def _as_list(value: Any) -> list[Any]:
        if isinstance(value, list):
            return value
        if isinstance(value, str):
            try:
                parsed = json.loads(value)
                return parsed if isinstance(parsed, list) else [value]
            except ValueError:
                return [value]
        return [value]

    result = False
    ln, rn = _num(left), _num(right)
    if op == "exists":
        result = left is not None
    elif op == "is_empty":
        result = left in (None, "", [], {}) or (isinstance(left, str) and not left.strip())
    elif op == "truthy":
        result = bool(left)
    elif op in ("gt", "gte", "lt", "lte"):
        if ln is not None and rn is not None:
            result = ln > rn if op == "gt" else ln >= rn if op == "gte" else ln < rn if op == "lt" else ln <= rn
        else:
            ls, rs = str(left or ""), str(right or "")
            result = ls > rs if op == "gt" else ls >= rs if op == "gte" else ls < rs if op == "lt" else ls <= rs
    elif op == "contains":
        if isinstance(left, list):
            result = right in left
        else:
            result = str(right or "") in str(left or "")
    elif op == "in":
        result = left in _as_list(right)
    elif op == "neq":
        result = (ln != rn) if (ln is not None and rn is not None) else (left != right)
    else:  # eq
        result = (ln == rn) if (ln is not None and rn is not None) else (left == right)

    return NodeResult("success", {"true": inputs} if result else {"false": inputs})


async def _h_wait(ex: _Executor, node, config, inputs) -> NodeResult:
    wake: datetime | None = None
    seconds = _num(config.get("seconds"))
    until_raw = config.get("until")
    if isinstance(until_raw, str) and until_raw.strip():
        try:
            wake = datetime.fromisoformat(str(until_raw).replace("Z", "+00:00"))
            if wake.tzinfo is None:
                wake = wake.replace(tzinfo=timezone.utc)
        except ValueError:
            wake = None
    if wake is None:
        if not seconds or seconds <= 0:
            raise NodeFailure("Вкажіть seconds або until / provide seconds or until")
        wake = _now() + timedelta(seconds=min(seconds, MAX_WAIT_SECONDS))
    if wake > _now() + timedelta(seconds=MAX_WAIT_SECONDS):
        wake = _now() + timedelta(seconds=MAX_WAIT_SECONDS)
    if wake <= _now():
        return NodeResult("success", {"out": inputs})
    return NodeResult("waiting", {"out": inputs}, wake_at=wake)


async def _h_set_var(ex: _Executor, node, config, inputs) -> NodeResult:
    def _coerce_scalar(value: Any) -> Any:
        # Plain literals get JSON-scalar semantics: "1" → 1, "true" → true.
        if isinstance(value, str) and "{{" not in value:
            try:
                parsed = json.loads(value)
                if parsed is None or isinstance(parsed, (bool, int, float)):
                    return parsed
            except ValueError:
                pass
        return value

    assignments = config.get("assignments") or []
    if not isinstance(assignments, list):
        raise NodeFailure("assignments має бути масивом / assignments must be an array")
    ctx = ex._ctx(inputs)
    # Reassign (never mutate in place) so SQLAlchemy flags the JSONB column dirty.
    variables = dict(ex.run.variables)
    for item in assignments:
        if not isinstance(item, dict) or not str(item.get("name") or "").strip():
            continue
        name = str(item["name"]).strip()
        variables[name] = _coerce_scalar(resolve(item.get("value"), ctx))
    ex.run.variables = variables
    return NodeResult("success", {"out": inputs})


async def _h_loop(ex: _Executor, node, config, inputs) -> NodeResult:
    items = config.get("items")
    if items is None or items == "":
        raise NodeFailure("Порожній масив / empty items array")
    if not isinstance(items, list):
        items = [items]
    items = items[:MAX_LOOP_ITEMS]

    branch = ex.branch_set(node["key"], "each")
    done: list[Any] = []
    for index, item in enumerate(items):
        # Sub-frame: loop node presents itself as succeeded on the "each" port
        # so branch entry nodes become ready with the item as their input.
        sub_states: dict[str, Any] = {
            node["key"]: {"status": "success", "outputs": {"each": _safe_json(item)}},
        }
        for child_key in branch:
            sub_states[child_key] = {"status": "pending"}
        sub = _Executor(
            ex.db,
            ex.run,
            states=sub_states,
            scope=branch,
            extra_ctx={"item": _safe_json(item), "index": index},
            is_subframe=True,
        )
        try:
            await sub.execute()
        except NodeFailure as exc:
            raise NodeFailure(f"Цикл, елемент #{index + 1}: {exc}") from exc
        # collect leaf outputs (branch nodes without outgoing in-branch edges)
        for child_key in branch:
            outgoing_in_branch = any(
                e.get("source") == child_key and e.get("target") in branch for e in ex.edges
            )
            if outgoing_in_branch:
                continue
            st = sub.states.get(child_key)
            if st and st.get("status") == "success":
                done.extend((st.get("outputs") or {}).values())
        if index < PERSISTED_LOOP_ITERATIONS:
            for child_key in branch:
                ex.states[f"{node['key']}#{index}:{child_key}"] = sub.states.get(child_key) or {"status": "skipped"}
    return NodeResult("success", {"done": done})


async def _h_notify_telegram(ex: _Executor, node, config, inputs) -> NodeResult:
    from app.services import telegram_notify

    message = str(config.get("message") or "").strip()
    if not message:
        raise NodeFailure("Порожнє повідомлення / empty message")
    chat_raw = config.get("chat_id")
    chat_ids: list[int] | None = None
    chat_num = _num(chat_raw) if chat_raw not in (None, "") else None
    if chat_num is not None:
        chat_ids = [int(chat_num)]
    sent = await asyncio.to_thread(
        telegram_notify.send_org_notification, ex.db, ex.run.organization_id, message, chat_ids
    )
    return NodeResult("success", {"out": {"sent": sent}})


_BLOCKED_HOSTS = ("localhost", "127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "[::1]")


def _assert_url_allowed(url: str) -> None:
    """Reject loopback / private / link-local targets (basic SSRF guard)."""
    from urllib.parse import urlparse
    from ipaddress import ip_address, ip_network

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise NodeFailure("Підтримуються лише http/https / only http/https URLs allowed")
    host = parsed.hostname or ""
    if not host:
        raise NodeFailure("Некоректний URL / invalid URL")
    lowered = host.lower()
    if lowered in ("localhost",) or lowered.endswith(".localhost") or lowered == "::1":
        raise NodeFailure(f"Внутрішні адреси заборонені / internal hosts are not allowed: {host}")
    try:
        ip = ip_address(lowered)
    except ValueError:
        return
    for blocked in _BLOCKED_HOSTS[1:]:
        try:
            if ip in ip_network(blocked):
                raise NodeFailure(f"Внутрішні адреси заборонені / internal hosts are not allowed: {host}")
        except ValueError:
            continue


async def _h_http(ex: _Executor, node, config, inputs) -> NodeResult:
    url = str(config.get("url") or "").strip()
    if not url:
        raise NodeFailure("Порожній URL / empty URL")
    _assert_url_allowed(url)
    method = str(config.get("method") or "GET").upper()
    timeout = min(max(_num(config.get("timeout_sec")) or 30, 1), 120)
    headers = {str(k): str(v) for k, v in (config.get("headers") or {}).items() if k and v is not None}
    body = config.get("body")

    kwargs: dict[str, Any] = {"headers": headers, "timeout": timeout}
    if body not in (None, "") and method not in ("GET", "HEAD"):
        if isinstance(body, (dict, list)):
            kwargs["json"] = body
            headers.setdefault("Content-Type", "application/json")
        else:
            kwargs["data"] = str(body)
            headers.setdefault("Content-Type", "text/plain")

    def _do() -> dict[str, Any]:
        resp = requests.request(method, url, **kwargs)
        parsed: Any = None
        try:
            parsed = resp.json()
        except ValueError:
            parsed = None
        text = resp.text[:MAX_HTTP_BODY]
        return {"status": resp.status_code, "ok": resp.ok, "body": text, "json": _safe_json(parsed)}

    result = await asyncio.to_thread(_do)
    return NodeResult("success", {"out": result})


async def _h_send_print(ex: _Executor, node, config, inputs) -> NodeResult:
    """Queue a print via the standard dispatch (same path as files.send_to_printer)."""
    from app.models.gcode_file import GcodeFile
    from app.models.printer import Printer, PrinterKind
    from app.services import bambu_dispatch, file_outputs
    from app.services.bambu_lan_dispatch import dispatch_lan_job, has_agent_tunnel
    from app.services.moonraker_dispatch import dispatch_moonraker_job

    printer_id = _num(config.get("printer_id"))
    file_id = _num(config.get("file_id"))
    if printer_id is None:
        raise NodeFailure("Не вказано printer_id / printer_id is required")
    printer = (
        ex.db.query(Printer)
        .filter(
            Printer.id == int(printer_id),
            Printer.organization_id == ex.run.organization_id,
            Printer.is_active.is_(True),
        )
        .first()
    )
    if printer is None:
        raise NodeFailure("Принтер не знайдено / printer not found")

    file_id = file_id or (inputs.get("file_id") if isinstance(inputs, dict) else None)
    file_num = _num(file_id)
    if file_num is None:
        raise NodeFailure("Не вказано file_id / file_id is required")
    gcode = (
        ex.db.query(GcodeFile)
        .filter(GcodeFile.id == int(file_num), GcodeFile.organization_id == ex.run.organization_id)
        .first()
    )
    if gcode is None:
        raise NodeFailure("Файл не знайдено / file not found")

    org_id = ex.run.organization_id
    run_id = ex.run.id
    output_plan = file_outputs.build_output_plan(ex.db, org_id, gcode.id)
    if printer.kind == PrinterKind.bambu:
        from app.services.bambu_mapping import build_ams_mapping

        ams_mapping, _use_ams_detected, _details = build_ams_mapping(gcode.filament_meta, printer)
        use_lan = bool(printer.bambu_lan_mode)
        if use_lan and not has_agent_tunnel(org_id):
            raise NodeFailure("Немає agent-тунелю для LAN-режиму / no agent tunnel for LAN mode")
        job = bambu_dispatch.create_cloud_job(
            ex.db,
            org_id=org_id,
            printer_id=printer.id,
            printer_bambu_dev_id=printer.bambu_dev_id,
            gcode_file_id=gcode.id,
            file_name=gcode.original_name,
            dispatch_mode="lan" if use_lan else "cloud",
            idempotency_key=f"workflow:{run_id}:{node['key']}",
            output_plan=output_plan,
            request_payload={
                "source": "workflow",
                "workflow_run_id": run_id,
                "ams_mapping": ams_mapping,
                "use_ams": bool(printer.bambu_has_ams) if printer.bambu_has_ams is not None else None,
            },
        )
        job_id = job.id
        ex.db.commit()  # persist the job before side-effectful dispatch
        result = (
            await dispatch_lan_job(job_id)
            if use_lan
            else await asyncio.to_thread(bambu_dispatch.dispatch_cloud_job, job_id)
        )
    else:
        if not printer.moonraker_url:
            raise NodeFailure("Принтер не має Moonraker URL / printer has no Moonraker URL")
        job = bambu_dispatch.create_cloud_job(
            ex.db,
            org_id=org_id,
            printer_id=printer.id,
            printer_bambu_dev_id=None,
            gcode_file_id=gcode.id,
            file_name=gcode.original_name,
            dispatch_mode="moonraker",
            idempotency_key=f"workflow:{run_id}:{node['key']}",
            output_plan=output_plan,
            request_payload={"source": "workflow", "workflow_run_id": run_id},
        )
        job_id = job.id
        ex.db.commit()
        result = await dispatch_moonraker_job(job_id)

    status_value = result.status.value if result is not None and getattr(result, "status", None) else "queued"
    reason = getattr(result, "status_reason", None) if result is not None else None
    return NodeResult("success", {"out": {"job_id": job_id, "status": status_value, "reason": reason}})


HANDLERS: dict[str, Any] = {
    "flow.condition": _h_condition,
    "flow.wait": _h_wait,
    "flow.set_var": _h_set_var,
    "flow.loop": _h_loop,
    "action.notify_telegram": _h_notify_telegram,
    "action.http_request": _h_http,
    "action.send_print": _h_send_print,
}


# ── run-level entry points ───────────────────────────────────────────────────


async def execute_run(db: Session, run: WorkflowRun) -> WorkflowRun:
    """Execute (or continue) a run. The run row must belong to this session."""
    executor = _Executor(db, run)
    if not run.node_states:
        run.node_states = executor.states
    await executor.execute()
    return run


async def resume_run(db: Session, run: WorkflowRun) -> WorkflowRun:
    """Resume a waiting run whose due nodes have reached their wake time."""
    now = _now()
    states = {k: dict(v) for k, v in (run.node_states or {}).items()}
    resumed = False
    for st in states.values():
        if st.get("status") != "waiting":
            continue
        raw = st.get("wake_at")
        if not raw:
            continue
        try:
            wake = datetime.fromisoformat(str(raw))
        except ValueError:
            continue
        if wake.tzinfo is None:
            wake = wake.replace(tzinfo=timezone.utc)
        if wake <= now:
            st["status"] = "success"
            st["outputs"] = {"out": st.get("input")}
            st["finished_at"] = _iso()
            resumed = True
    if not resumed:
        return run
    run.node_states = states
    return await execute_run(db, run)


def _iter_due_waiting(states: dict[str, Any], now: datetime) -> bool:
    for st in states.values():
        if st.get("status") != "waiting":
            continue
        raw = st.get("wake_at")
        if not raw:
            continue
        try:
            wake = datetime.fromisoformat(str(raw))
        except ValueError:
            continue
        if wake.tzinfo is None:
            wake = wake.replace(tzinfo=timezone.utc)
        if wake <= now:
            return True
    return False


async def resume_due_waiting_runs(db: Session, limit: int = 50) -> int:
    """Resume every due waiting run. Returns the count of resumed runs."""
    now = _now()
    runs = (
        db.query(WorkflowRun)
        .filter(WorkflowRun.status == WorkflowRunStatus.waiting)
        .order_by(WorkflowRun.id)
        .limit(limit)
        .all()
    )
    resumed = 0
    for run in runs:
        if _iter_due_waiting(run.node_states or {}, now):
            await resume_run(db, run)
            resumed += 1
    return resumed
