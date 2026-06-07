"""Structured logging helpers for Bambu Cloud flows."""
from __future__ import annotations

import logging
from collections.abc import Mapping
from datetime import datetime

_SECRET_KEYS = {"token", "access_token", "refresh_token", "password", "email_code", "verification_code", "authorization"}


def log_event(logger: logging.Logger, level: int, event: str, **context: object) -> None:
    """Emit a grep-friendly structured event without leaking common secrets."""
    safe_context = _safe_context(context)
    message = event
    if safe_context:
        message = f"{event} " + " ".join(f"{key}={value}" for key, value in safe_context.items())
    logger.log(level, message, extra={"event": event, "context": safe_context})


def event_tags(**context: object) -> dict[str, str]:
    """Convert safe context into string metric tags."""
    return {key: str(value) for key, value in _safe_context(context).items()}


def _safe_context(context: Mapping[str, object]) -> dict[str, str]:
    safe: dict[str, str] = {}
    for key, value in context.items():
        if value is None:
            continue
        lower = key.lower()
        if any(secret in lower for secret in _SECRET_KEYS):
            safe[key] = "<redacted>"
            continue
        if isinstance(value, datetime):
            safe[key] = value.isoformat()
        else:
            safe[key] = str(value)
    return safe
