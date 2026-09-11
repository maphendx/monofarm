"""Redis advisory lock for scheduler leader election.

Only one worker process should run APScheduler at a time. Without Redis
(REDIS_URL unset) the process always considers itself leader — correct for
single-process local dev.
"""
import logging
import os
import socket

log = logging.getLogger(__name__)

LOCK_KEY = "monofarm:scheduler:leader"
LOCK_TTL = 30     # seconds — lock expires if worker dies
RENEW_INTERVAL = 10  # seconds between renewals


def _worker_id() -> str:
    return f"{socket.gethostname()}-{os.getpid()}"


def try_acquire() -> bool:
    """Try to become scheduler leader. Returns True if acquired (or no Redis)."""
    from app.services.cache import _r
    r = _r()
    if r is None:
        return True  # no Redis → always leader (dev)
    acquired = r.set(LOCK_KEY, _worker_id(), nx=True, ex=LOCK_TTL)
    if acquired:
        log.info("Scheduler leader lock acquired (%s)", _worker_id())
    else:
        holder = r.get(LOCK_KEY)
        log.info("Scheduler leader lock held by %s — this worker will skip scheduler", holder)
    return bool(acquired)


def renew() -> bool:
    """Renew lock if we still hold it. Returns False if lost."""
    from app.services.cache import _r
    r = _r()
    if r is None:
        return True
    wid = _worker_id()
    renewed = r.eval("""
        local current = redis.call('GET', KEYS[1])
        if current == ARGV[1] then
            redis.call('EXPIRE', KEYS[1], ARGV[2])
            return 1
        end
        if not current then
            return redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2]) and 1 or 0
        end
        return 0
    """, 1, LOCK_KEY, wid, LOCK_TTL)
    if renewed:
        return True
    log.warning("Scheduler leader lock lost")
    return False


def release() -> None:
    """Release lock on clean shutdown."""
    from app.services.cache import _r
    r = _r()
    if r is None:
        return
    wid = _worker_id()
    removed = r.eval("""
        if redis.call('GET', KEYS[1]) == ARGV[1] then
            return redis.call('DEL', KEYS[1])
        end
        return 0
    """, 1, LOCK_KEY, wid)
    if removed:
        log.info("Scheduler leader lock released")
