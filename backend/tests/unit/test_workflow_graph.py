"""Unit tests for workflow graph validation."""
from app.services.workflow_nodes import assign_webhook_secrets, validate_graph


def node(key, type_, config=None):
    return {"key": key, "type": type_, "config": config or {}, "name": key, "position": {"x": 0, "y": 0}}


def edge(src, dst, port=None):
    out = {"source": src, "target": dst}
    if port:
        out["source_port"] = port
    return out


def test_valid_simple_graph():
    graph = {
        "nodes": [node("t", "trigger.manual"), node("n", "action.notify_telegram", {"message": "hi"})],
        "edges": [edge("t", "n")],
    }
    assert validate_graph(graph) == []


def test_missing_trigger_rejected():
    graph = {"nodes": [node("n", "action.notify_telegram", {"message": "hi"})], "edges": []}
    errors = validate_graph(graph)
    assert any("trigger" in e for e in errors)


def test_unknown_node_type_rejected():
    graph = {"nodes": [node("t", "trigger.manual"), node("x", "nope.type")], "edges": [edge("t", "x")]}
    errors = validate_graph(graph)
    assert any("unknown node type" in e for e in errors)


def test_cycle_rejected():
    graph = {
        "nodes": [
            node("t", "trigger.manual"),
            node("a", "flow.condition", {"left": "1", "op": "eq", "right": "1"}),
            node("b", "flow.set_var", {"assignments": [{"name": "x", "value": "1"}]}),
        ],
        "edges": [edge("t", "a"), edge("a", "b", "true"), edge("b", "a")],
    }
    errors = validate_graph(graph)
    assert any("cycle" in e for e in errors)


def test_duplicate_key_rejected():
    graph = {
        "nodes": [node("t", "trigger.manual"), node("t", "trigger.manual")],
        "edges": [],
    }
    errors = validate_graph(graph)
    assert any("duplicate" in e for e in errors)


def test_edge_to_missing_node_rejected():
    graph = {"nodes": [node("t", "trigger.manual")], "edges": [edge("t", "ghost")]}
    errors = validate_graph(graph)
    assert any("missing node" in e for e in errors)


def test_missing_required_config_rejected():
    graph = {"nodes": [node("t", "trigger.manual"), node("n", "action.notify_telegram")], "edges": [edge("t", "n")]}
    errors = validate_graph(graph)
    assert any("required" in e for e in errors)


def test_bad_cron_rejected():
    graph = {
        "nodes": [node("t", "trigger.cron", {"cron": "not a cron"})],
        "edges": [],
    }
    errors = validate_graph(graph)
    assert any("cron" in e for e in errors)


def test_unknown_event_rejected():
    graph = {
        "nodes": [node("t", "trigger.event", {"event_type": "totally.bogus"})],
        "edges": [],
    }
    errors = validate_graph(graph)
    assert any("unknown event" in e for e in errors)


def test_unknown_port_rejected():
    graph = {
        "nodes": [node("t", "trigger.manual"), node("n", "action.notify_telegram", {"message": "hi"})],
        "edges": [edge("t", "n", "sideport")],
    }
    errors = validate_graph(graph)
    assert any("port" in e for e in errors)


def test_webhook_secrets_assigned():
    graph = {"nodes": [node("t", "trigger.webhook")], "edges": []}
    updated = assign_webhook_secrets(graph)
    token = updated["nodes"][0]["config"]["token"]
    assert isinstance(token, str) and len(token) == 24
    # idempotent
    assert assign_webhook_secrets(updated)["nodes"][0]["config"]["token"] == token
