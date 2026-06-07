"""Minimal metrics facade.

No external backend is wired in Phase 8. Call sites use this tiny interface so
Prometheus/StatsD/etc. can be attached later without changing Bambu services.
"""
from __future__ import annotations

import logging
from collections.abc import Mapping

log = logging.getLogger(__name__)


def increment(name: str, value: int = 1, *, tags: Mapping[str, object] | None = None) -> None:
    """Record a counter increment.

    The default implementation is intentionally no-op except for debug logs.
    """
    log.debug("metric.increment name=%s value=%s tags=%s", name, value, _clean_tags(tags))


def timing(name: str, value_ms: float, *, tags: Mapping[str, object] | None = None) -> None:
    """Record a duration in milliseconds."""
    log.debug("metric.timing name=%s value_ms=%.3f tags=%s", name, value_ms, _clean_tags(tags))


def _clean_tags(tags: Mapping[str, object] | None) -> dict[str, str]:
    return {str(k): str(v) for k, v in (tags or {}).items() if v is not None}
