"""Safe expression resolver for workflow node configs.

An expression is ``{{ path.to.value }}`` resolved against the run context —
plain dot navigation over dicts/lists, no eval, no attribute access on
objects (underscore-leading keys are rejected). A full-string expression
returns the raw value (dict, number, …); interpolations inside a longer
string are JSON-serialised (or "" for None).
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any

_EXPR_RE = re.compile(r"\{\{\s*(.+?)\s*\}\}")
_MAX_DEPTH = 32


def _navigate(expr: str, ctx: dict[str, Any]) -> Any:
    cur: Any = ctx
    for token in expr.split("."):
        token = token.strip()
        if not token or token.startswith("_") or token.startswith("$"):
            return None
        if token == "now":
            return datetime.now(timezone.utc).isoformat()
        if isinstance(cur, dict):
            cur = cur.get(token)
        elif isinstance(cur, (list, tuple)):
            try:
                cur = cur[int(token)]
            except (ValueError, IndexError):
                return None
        else:
            return None
    return cur


def _stringify(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, default=str)
    return str(value)


def eval_expr(expr: str, ctx: dict[str, Any]) -> Any:
    """Resolve one bare expression body (no braces) against ctx."""
    return _navigate(expr, ctx)


def resolve(value: Any, ctx: dict[str, Any], depth: int = 0) -> Any:
    """Recursively resolve expressions inside strings / dicts / lists."""
    if depth > _MAX_DEPTH:
        return value
    if isinstance(value, str):
        match = _EXPR_RE.fullmatch(value.strip())
        if match:
            return _navigate(match.group(1), ctx)
        if "{{" in value:
            return _EXPR_RE.sub(
                lambda m: _stringify(_navigate(m.group(1), ctx)),
                value,
            )
        return value
    if isinstance(value, dict):
        return {k: resolve(v, ctx, depth + 1) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve(v, ctx, depth + 1) for v in value]
    return value


def to_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip().replace(",", "."))
        except ValueError:
            return None
    return None
