"""Unit tests for the safe expression resolver."""
from app.services.workflow_expressions import eval_expr, resolve, to_number


CTX = {
    "trigger": {"type": "print.completed", "payload": {"printer_name": "U1", "count": 3, "nested": {"a": 1}}},
    "vars": {"who": "world", "flag": True},
    "nodes": {"n1": {"name": "Notify", "output": {"sent": 2}}},
    "input": {"file_id": 7},
}


def test_full_match_returns_raw_value():
    assert resolve("{{trigger.payload.printer_name}}", CTX) == "U1"
    assert resolve("{{trigger.payload.count}}", CTX) == 3
    assert resolve("{{trigger.payload.nested}}", CTX) == {"a": 1}


def test_interpolation_inside_string():
    out = resolve("Printer {{trigger.payload.printer_name}} x{{trigger.payload.count}}!", CTX)
    assert out == "Printer U1 x3!"


def test_missing_path_resolves_to_none_or_empty():
    assert resolve("{{trigger.payload.missing}}", CTX) is None
    assert resolve("x={{trigger.payload.missing}}", CTX) == "x="
    assert resolve("{{vars.nope.deep}}", CTX) is None


def test_lists_and_dicts_recursion():
    out = resolve({"a": "{{vars.who}}", "list": ["{{input.file_id}}", "lit"]}, CTX)
    assert out == {"a": "world", "list": [7, "lit"]}


def test_node_output_access():
    assert resolve("{{nodes.n1.output.sent}}", CTX) == 2


def test_underscore_paths_rejected():
    assert resolve("{{vars.__class__}}", CTX) is None
    assert resolve("{{vars._private}}", CTX) is None


def test_list_index_navigation():
    assert resolve("{{items.1}}", {"items": ["a", "b"]}) == "b"


def test_eval_expr_now():
    value = eval_expr("now", {})
    assert "T" in value


def test_to_number():
    assert to_number("3.5") == 3.5
    assert to_number(2) == 2.0
    assert to_number(True) == 1.0
    assert to_number("abc") is None
    assert to_number(None) is None
