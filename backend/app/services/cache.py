"""Shared key-value cache: Redis when REDIS_URL is set, in-process dict fallback.

Thread-safe. Works from sync code (moonraker.py, bambu MQTT callbacks) and
async code alike — both use the sync redis client, which is fine for short ops.
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any

log = logging.getLogger(__name__)

_mem: dict[str, tuple[float, Any]] = {}  # key → (expires_at_wall, value)
_redis = None
_initialized = False


def _r():
    global _redis, _initialized
    if _initialized:
        return _redis
    _initialized = True
    try:
        from app.core.config import settings
        if settings.REDIS_URL:
            import redis as _lib
            client = _lib.from_url(settings.REDIS_URL, decode_responses=True)
            client.ping()
            _redis = client
            log.info("cache: connected to Redis (%s)", settings.REDIS_URL)
    except Exception as e:
        log.warning("cache: Redis unavailable, using in-memory fallback: %s", e)
        _redis = None
    return _redis


def cache_set(key: str, value: Any, ttl: int) -> None:
    r = _r()
    if r is not None:
        try:
            r.setex(key, ttl, json.dumps(value, default=str))
            return
        except Exception as e:
            log.debug("cache_set redis error: %s", e)
    _mem[key] = (time.time() + ttl, value)


def cache_get(key: str) -> Any | None:
    r = _r()
    if r is not None:
        try:
            raw = r.get(key)
            return json.loads(raw) if raw is not None else None
        except Exception as e:
            log.debug("cache_get redis error: %s", e)
    entry = _mem.get(key)
    if entry and entry[0] > time.time():
        return entry[1]
    _mem.pop(key, None)
    return None


def cache_delete(key: str) -> None:
    r = _r()
    if r is not None:
        try:
            r.delete(key)
            return
        except Exception as e:
            log.debug("cache_delete redis error: %s", e)
    _mem.pop(key, None)
