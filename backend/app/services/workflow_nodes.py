"""Workflow node catalog + graph validation.

This module is the single source of truth shared by the backend (validation,
execution dispatch) and the frontend editor (palette, config panel, ports).
Keep specs declarative — handlers live in ``workflow_engine``.
"""
from __future__ import annotations

import secrets
from typing import Any

from apscheduler.triggers.cron import CronTrigger

TRIGGER_TYPES = ("trigger.event", "trigger.cron", "trigger.webhook", "trigger.manual")

# Events the CRM publishes (services.workflow_events). ``payload`` documents the
# shape for expression autocomplete; extra keys may appear.
EVENT_TYPES: list[dict[str, Any]] = [
    {
        "type": "print.completed",
        "title": {"uk": "Друк завершено", "en": "Print completed"},
        "payload": ["history_id", "printer_id", "printer_name", "file_name", "duration_minutes", "filament_g", "source"],
    },
    {
        "type": "print.failed",
        "title": {"uk": "Друк завершився помилкою", "en": "Print failed"},
        "payload": ["history_id", "printer_id", "printer_name", "file_name", "result", "source"],
    },
    {
        "type": "print.cancelled",
        "title": {"uk": "Друк скасовано", "en": "Print cancelled"},
        "payload": ["history_id", "printer_id", "printer_name", "file_name", "result", "source"],
    },
    {
        "type": "printer.state_changed",
        "title": {"uk": "Змінився стан принтера", "en": "Printer state changed"},
        "payload": ["printer_id", "printer_name", "previous_state", "state", "error_msg"],
    },
    {
        "type": "order.created",
        "title": {"uk": "Створено замовлення", "en": "Order created"},
        "payload": ["order_id", "number", "source", "status", "total", "items_count", "counterparty"],
    },
    {
        "type": "order.shipped",
        "title": {"uk": "Замовлення відправлено", "en": "Order shipped"},
        "payload": ["order_id", "number", "status", "total"],
    },
    {
        "type": "filament.low",
        "title": {"uk": "Філамент закінчується", "en": "Filament low"},
        "payload": ["filament_id", "name", "material", "color", "grams_remaining", "min_grams"],
    },
]

EVENT_TYPE_VALUES = tuple(e["type"] for e in EVENT_TYPES)

_CONDITION_OPS = (
    "eq",
    "neq",
    "gt",
    "gte",
    "lt",
    "lte",
    "contains",
    "in",
    "exists",
    "is_empty",
    "truthy",
)

CONDITION_OPS = ("eq", "neq", "gt", "gte", "lt", "lte", "contains", "in", "exists", "is_empty", "truthy")


def _t(uk: str, en: str) -> dict[str, str]:
    return {"uk": uk, "en": en}


def _f(
    key: str,
    label_uk: str,
    label_en: str,
    type_: str,
    *,
    required: bool = False,
    options: list[dict[str, str]] | None = None,
    placeholder: str | None = None,
    hint: dict[str, str] | None = None,
) -> dict[str, Any]:
    spec: dict[str, Any] = {"key": key, "type": type_, "label": _t(label_uk, label_en), "required": required}
    if options:
        spec["options"] = options
    if placeholder:
        spec["placeholder"] = placeholder
    if hint:
        spec["hint"] = hint
    return spec


def _opt(value: str, uk: str, en: str) -> dict[str, str]:
    return {"value": value, "label": _t(uk, en)}


CATALOG: list[dict[str, Any]] = [
    {
        "type": "trigger.event",
        "category": "trigger",
        "icon": "⚡",
        "title": _t("Подія", "Event"),
        "description": _t("Запускає воркфлоу, коли CRM публікує подію", "Starts the workflow when the CRM publishes an event"),
        "outputs": [{"name": "out", "title": _t("Далі", "Then")}],
        "config": [
            {
                "key": "event_type",
                "type": "select",
                "label": _t("Подія", "Event"),
                "required": True,
                "options": [{"value": e["type"], "label": e["title"]} for e in EVENT_TYPES],
            },
            {
                "key": "filter",
                "type": "keyvalue",
                "label": _t("Фільтр (опційно)", "Filter (optional)"),
                "hint": _t("Усі пари ключ=значення мають збігтися з payload події", "Every key=value pair must match the event payload"),
            },
        ],
    },
    {
        "type": "trigger.cron",
        "category": "trigger",
        "icon": "🕒",
        "title": _t("Розклад", "Schedule"),
        "description": _t("Запускає воркфлоу за розкладом (cron, 5 полів)", "Starts the workflow on a schedule (cron, 5 fields)"),
        "outputs": [{"name": "out", "title": _t("Далі", "Then")}],
        "config": [
            _f("cron", "Cron-вираз", "Cron expression", "text", required=True, placeholder="0 9 * * *"),
        ],
    },
    {
        "type": "trigger.webhook",
        "category": "trigger",
        "icon": "🌐",
        "title": _t("Webhook", "Webhook"),
        "description": _t("Запускає воркфлоу POST-запитом на унікальну адресу", "Starts the workflow via a POST request to a unique URL"),
        "outputs": [{"name": "out", "title": _t("Далі", "Then")}],
        "config": [
            _f("token", "Токен", "Token", "text", hint=_t("Генерується автоматично", "Generated automatically")),
        ],
    },
    {
        "type": "trigger.manual",
        "category": "trigger",
        "icon": "▶️",
        "title": _t("Ручний запуск", "Manual start"),
        "description": _t("Точка входу для запуску кнопкою або з API", "Entry point for button runs or API runs"),
        "outputs": [{"name": "out", "title": _t("Далі", "Then")}],
        "config": [],
    },
    {
        "type": "flow.condition",
        "category": "flow",
        "icon": "⑃",
        "title": _t("Умова", "Condition"),
        "description": _t("Розгалужує потік за порівнянням значень", "Branches the flow on a comparison"),
        "outputs": [{"name": "true", "title": _t("Так", "True")}, {"name": "false", "title": _t("Ні", "False")}],
        "config": [
            _f("left", "Лівий операнд", "Left operand", "text", required=True, placeholder="{{trigger.payload.order_id}}"),
            {
                "key": "op",
                "type": "select",
                "label": _t("Операція", "Operator"),
                "required": True,
                "options": [
                    _opt("eq", "дорівнює", "equals"),
                    _opt("neq", "не дорівнює", "not equals"),
                    _opt("gt", "більше", "greater than"),
                    _opt("gte", "більше або рівно", "greater or equal"),
                    _opt("lt", "менше", "less than"),
                    _opt("lte", "менше або рівно", "less or equal"),
                    _opt("contains", "містить", "contains"),
                    _opt("in", "входить у (JSON-масив)", "in (JSON array)"),
                    _opt("exists", "існує", "exists"),
                    _opt("is_empty", "порожнє", "is empty"),
                    _opt("truthy", "істинне", "truthy"),
                ],
            },
            _f("right", "Правий операнд", "Right operand", "text", placeholder="100"),
        ],
    },
    {
        "type": "flow.wait",
        "category": "flow",
        "icon": "⏸",
        "title": _t("Зачекати", "Wait"),
        "description": _t("Призупиняє виконання на заданий час", "Suspends execution for a period"),
        "outputs": [{"name": "out", "title": _t("Далі", "Then")}],
        "config": [
            _f("seconds", "Секунди (вираз)", "Seconds (expression)", "text", required=True, placeholder="3600"),
            _f(
                "until",
                "Або до часу (ISO, вираз)",
                "Or until (ISO, expression)",
                "text",
                placeholder="{{trigger.payload.wake_at}}",
            ),
        ],
    },
    {
        "type": "flow.set_var",
        "category": "flow",
        "icon": "𝑥",
        "title": _t("Змінні", "Variables"),
        "description": _t("Зберігає значення у змінні рану", "Stores values into run variables"),
        "outputs": [{"name": "out", "title": _t("Далі", "Then")}],
        "config": [
            _f("assignments", "Присвоєння", "Assignments", "assignments", required=True),
        ],
    },
    {
        "type": "flow.loop",
        "category": "flow",
        "icon": "🔁",
        "title": _t("Цикл по елементах", "Loop over items"),
        "description": _t(
            "Виконує гілку для кожного елемента масиву; у гілці доступні {{item}} і {{index}}",
            "Runs the branch for each item of an array; {{item}} and {{index}} are available inside",
        ),
        "outputs": [{"name": "each", "title": _t("На кожен", "Each")}, {"name": "done", "title": _t("Після циклу", "Done")}],
        "config": [
            _f("items", "Масив елементів", "Items array", "text", required=True, placeholder="{{trigger.payload.body.items}}"),
        ],
    },
    {
        "type": "action.notify_telegram",
        "category": "action",
        "icon": "📣",
        "title": _t("Telegram", "Telegram"),
        "description": _t("Повідомлення в Telegram організації", "Message to the organization's Telegram"),
        "outputs": [{"name": "out", "title": _t("Далі", "Then")}],
        "config": [
            _f("message", "Повідомлення", "Message", "textarea", required=True),
            _f("chat_id", "chat_id (порожньо = всім", "chat_id (empty = everyone)", "text"),
        ],
    },
    {
        "type": "action.http_request",
        "category": "action",
        "icon": "🌍",
        "title": _t("HTTP-запит", "HTTP request"),
        "description": _t("Викликає зовнішній API", "Calls an external API"),
        "outputs": [{"name": "out", "title": _t("Далі", "Then")}],
        "config": [
            {
                "key": "method",
                "type": "select",
                "label": _t("Метод", "Method"),
                "required": True,
                "options": [_opt("GET", "GET", "GET"), _opt("POST", "POST", "POST"), _opt("PUT", "PUT", "PUT"), _opt("PATCH", "PATCH", "PATCH"), _opt("DELETE", "DELETE", "DELETE")],
            },
            _f("url", "URL", "URL", "text", required=True, placeholder="https://api.example.com/…"),
            _f("headers", "Заголовки", "Headers", "keyvalue"),
            _f("body", "Тіло запиту", "Body", "textarea"),
            _f("timeout_sec", "Таймаут, с", "Timeout, s", "number"),
        ],
    },
    {
        "type": "action.send_print",
        "category": "action",
        "icon": "🖨",
        "title": _t("Надіслати на друк", "Send to print"),
        "description": _t("Створює задачу друку на принтері через штатну чергу", "Queues a print job on a printer via the standard dispatch"),
        "outputs": [{"name": "out", "title": _t("Далі", "Then")}],
        "config": [
            _f("file_id", "ID файлу (вираз)", "File ID (expression)", "text", placeholder="{{trigger.payload.file_id}}"),
            _f("printer_id", "ID принтера (вираз)", "Printer ID (expression)", "text", required=True, placeholder="1"),
        ],
    },
]

CATALOG_BY_TYPE = {n["type"]: n for n in CATALOG}

OUTPUT_PORTS: dict[str, list[str]] = {
    n["type"]: [p["name"] for p in n["outputs"]] for n in CATALOG
}


def _required_keys(spec: dict[str, Any]) -> list[str]:
    return [c["key"] for c in spec["config"] if c.get("required")]


def _validate_cron(expr: str) -> str | None:
    try:
        CronTrigger.from_crontab(expr)
    except (ValueError, TypeError):
        return "Некоректний cron-вираз / invalid cron expression"
    return None


def assign_webhook_secrets(graph: dict[str, Any]) -> dict[str, Any]:
    """Fill missing webhook trigger tokens in place and return the graph."""
    nodes = graph.get("nodes") or []
    for node in nodes:
        if node.get("type") == "trigger.webhook":
            config = node.setdefault("config", {})
            if not config.get("token"):
                config["token"] = secrets.token_hex(12)
    return graph


def validate_graph(graph: Any) -> list[str]:
    """Return a list of human-readable errors; empty list means valid."""
    errors: list[str] = []
    if not isinstance(graph, dict):
        return ["Граф має бути об'єктом / Graph must be an object"]
    nodes = graph.get("nodes")
    edges = graph.get("edges")
    if not isinstance(nodes, list):
        return ["graph.nodes має бути масивом / graph.nodes must be an array"]
    if not isinstance(edges, list):
        return ["graph.edges має бути масивом / graph.edges must be an array"]

    keys: list[str] = []
    types: dict[str, str] = {}
    has_trigger = False
    for node in nodes:
        if not isinstance(node, dict):
            errors.append("Нода має бути об'єктом / node must be an object")
            return errors
        key = node.get("key")
        ntype = node.get("type")
        if not key or not isinstance(key, str):
            errors.append("Нода без ключа / node without key")
            return errors
        if key in keys:
            errors.append(f"Дублікат ключа ноди / duplicate node key: {key}")
            return errors
        keys.append(key)
        if ntype not in CATALOG_BY_TYPE:
            errors.append(f"Невідомий тип ноди / unknown node type: {ntype} ({key})")
            return errors
        types[key] = ntype
        if ntype in TRIGGER_TYPES:
            has_trigger = True
        config = node.get("config") or {}
        if not isinstance(config, dict):
            errors.append(f"Некоректний конфіг ноди / invalid config: {key}")
            return errors
        for req in _required_keys(CATALOG_BY_TYPE[ntype]):
            value = config.get(req)
            if value is None or (isinstance(value, str) and not value.strip()) or (
                req == "assignments" and not isinstance(value, list)
            ):
                errors.append(f"Порожнє обов'язкове поле «{req}» у ноді {key} / missing required field")
        if ntype == "trigger.cron" and config.get("cron"):
            if err := _validate_cron(str(config["cron"])):
                errors.append(f"{key}: {err}")
        if ntype == "trigger.event" and config.get("event_type") and config["event_type"] not in EVENT_TYPE_VALUES:
            errors.append(f"{key}: невідома подія / unknown event: {config['event_type']}")

    if not has_trigger:
        errors.append("Потрібна хоча б одна нода-тригер / at least one trigger node required")

    seen_edges: set[tuple[str, str, str]] = set()
    for edge in edges:
        if not isinstance(edge, dict):
            errors.append("Ребро має бути об'єктом / edge must be an object")
            return errors
        src = edge.get("source")
        dst = edge.get("target")
        if src not in types or dst not in types:
            errors.append(f"Ребро вказує на неіснуючу ноду / edge references missing node: {src} → {dst}")
            return errors
        if src == dst:
            errors.append(f"Ребро саме в себе / self edge: {src}")
            continue
        port = edge.get("source_port") or "out"
        if port not in OUTPUT_PORTS[types[src]]:
            errors.append(f"Невідомий порт «{port}» у ноди {src} / unknown output port")
            continue
        rec = (src, port, dst)
        if rec in seen_edges:
            errors.append(f"Дублікат ребра / duplicate edge: {src}:{port} → {dst}")
            continue
        seen_edges.add(rec)

    # Cycle check (Kahn)
    indeg = {k: 0 for k in keys}
    adjacency: dict[str, list[str]] = {k: [] for k in keys}
    for src, _port, dst in seen_edges:
        adjacency[src].append(dst)
        indeg[dst] += 1
    queue = [k for k, d in indeg.items() if d == 0]
    visited = 0
    while queue:
        cur = queue.pop()
        visited += 1
        for nxt in adjacency[cur]:
            indeg[nxt] -= 1
            if indeg[nxt] == 0:
                queue.append(nxt)
    if visited != len(keys):
        errors.append("Граф містить цикл / graph contains a cycle")

    return errors


def webhook_token(workflow_id: int, secret: str) -> str:
    return f"whk-{workflow_id}-{secret}"


def telegram_rule_events(graph: dict) -> set[str]:
    """Notification rules with a reachable Telegram action, including branches.

    Conditions/custom recipients cannot be proven disjoint here: treat them as
    possible overlap and require choosing a notification owner explicitly.
    """
    nodes = {node.get("key"): node for node in graph.get("nodes", [])}
    outgoing: dict[str, list[str]] = {}
    for edge in graph.get("edges", []):
        outgoing.setdefault(edge.get("source"), []).append(edge.get("target"))
    events = set()
    for key, node in nodes.items():
        event = (node.get("config") or {}).get("event_type")
        if node.get("type") != "trigger.event" or event not in {"print.failed", "filament.low"}:
            continue
        pending, visited = [key], set()
        while pending:
            current = pending.pop()
            if current in visited:
                continue
            visited.add(current)
            if nodes.get(current, {}).get("type") == "action.notify_telegram":
                events.add(event)
                break
            pending.extend(outgoing.get(current, []))
    return events
