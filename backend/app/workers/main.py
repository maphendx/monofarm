"""Monofarm background worker.

Runs Telegram bot, APScheduler, Bambu MQTT, and Redis command relay
in a single asyncio process — separate from the FastAPI web workers.

Usage:
    python -m app.workers.main

Docker:
    command: python -m app.workers.main
    environment:
      INLINE_WORKERS: "false"
"""
from __future__ import annotations

import asyncio
import json
import logging
import signal
import threading

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logging.getLogger("apscheduler").setLevel(logging.WARNING)

log = logging.getLogger("monofarm.worker")


def _redis_cmd_relay() -> None:
    """Background thread: forward Bambu commands from Redis pub/sub → MQTT.

    Web workers publish to 'bambu:cmd' when they have no local MQTT client.
    This thread picks them up and publishes to the real MQTT broker.
    Reconnects automatically on connection drops.
    """
    import time as _time
    import redis as _lib
    from app.core.config import settings
    from app.services.bambu import _mqtt_clients, _subscriptions

    if not settings.REDIS_URL:
        log.warning("Redis not configured — Bambu command relay disabled")
        return

    backoff = 1
    while True:
        try:
            r = _lib.from_url(
                settings.REDIS_URL,
                decode_responses=True,
                socket_timeout=None,
                socket_keepalive=True,
                health_check_interval=30,
            )
            pubsub = r.pubsub()
            pubsub.subscribe("bambu:cmd")
            log.info("Redis cmd relay: subscribed to bambu:cmd")
            backoff = 1

            for message in pubsub.listen():
                if message["type"] != "message":
                    continue
                try:
                    cmd = json.loads(message["data"])
                    topic: str = cmd["topic"]
                    payload: str = cmd["payload"]
                    qos: int = int(cmd.get("qos", 0))
                    dev_id = topic.split("/")[1] if "/" in topic else ""
                    org_id = cmd.get("org_id")
                    if type(org_id) is not int or (org_id, dev_id) not in _subscriptions:
                        continue
                    if topic != f"device/{dev_id}/request":
                        continue
                    client = _mqtt_clients.get(org_id)
                    if client is not None:
                        client.publish(topic, payload, qos=qos)
                        log.debug("Redis cmd relay: forwarded cmd to %s", topic)
                    else:
                        log.warning("Redis cmd relay: no MQTT client for dev_id=%s (org_id=%s)", dev_id, org_id)
                except Exception as e:
                    log.warning("Redis cmd relay error: %s", e)
        except Exception as e:
            log.warning("Redis cmd relay: connection lost (%s), reconnecting in %ds", e, backoff)
            _time.sleep(backoff)
            backoff = min(backoff * 2, 30)


async def _refresh_bambu_subscriptions() -> None:
    """Subscribe new Bambu devices and refresh full state for existing ones."""
    from app.core.db import SessionLocal
    from app.models.organization import Organization
    from app.services import bambu
    from app.services.bambu import _subscriptions

    try:
        with SessionLocal() as db:
            orgs = db.query(Organization).all()
        for org in orgs:
            devices = await asyncio.to_thread(bambu.list_devices, org.id)
            for d in devices:
                dev_id = d.get("dev_id", "")
                if dev_id and (org.id, dev_id) not in _subscriptions:
                    log.info("Worker: new Bambu device discovered, subscribing: %s", dev_id)
                    bambu.subscribe_device(dev_id, org.id)
                elif dev_id:
                    bambu.request_full_status(dev_id, org_id=org.id)
    except Exception:
        log.exception("Bambu subscription refresh failed")


async def _renew_loop(stop: asyncio.Event) -> None:
    """Periodically renew scheduler leader lock; stop on loss."""
    from app.core import leader
    from app.services import scheduler as sched
    while not stop.is_set():
        await asyncio.sleep(leader.RENEW_INTERVAL)
        if not leader.renew():
            log.warning("Lost scheduler leadership — shutting down scheduler")
            sched.shutdown()
            return


async def main() -> None:
    from app.services import bambu, scheduler
    from app.core import leader
    from app.core.db import SessionLocal
    from app.models.organization import Organization
    import app.models.tag  # noqa: F401 — register Tag mapper before Printer is used

    from app.services import tunnel
    await tunnel.start_router()

    # Redis command relay (runs in daemon thread — dies with the process)
    threading.Thread(target=_redis_cmd_relay, daemon=True, name="redis-cmd-relay").start()

    # APScheduler — only on the leader worker
    is_leader = leader.try_acquire()
    if not is_leader:
        # Stale lock from a previous deploy — wait for it to expire and retry once
        log.info("Leader lock held by another worker — waiting %ds for expiry...", leader.LOCK_TTL + 2)
        await asyncio.sleep(leader.LOCK_TTL + 2)
        is_leader = leader.try_acquire()
    if is_leader:
        try:
            scheduler.start()
            log.info("Scheduler started (leader)")
        except Exception:
            log.exception("Scheduler failed to start")

    # Bambu MQTT for all orgs
    try:
        with SessionLocal() as db:
            orgs = db.query(Organization).all()
        for org in orgs:
            await bambu.init(org)
        log.info("Bambu MQTT started for %d org(s)", len(orgs))
    except Exception:
        log.exception("Bambu MQTT failed to start")

    # P1/A1 MQTT reports are deltas. Refresh full state every 5 minutes so AMS
    # colors stay current without anyone opening the printer in Bambu Handy.
    from apscheduler.triggers.interval import IntervalTrigger
    from app.services.scheduler import _scheduler
    if _scheduler is not None:
        _scheduler.add_job(
            _refresh_bambu_subscriptions,
            IntervalTrigger(seconds=bambu.BAMBU_FULL_REFRESH_INTERVAL_SECONDS),
            id="bambu_subscription_refresh",
            replace_existing=True,
        )

    log.info("monofarm worker ready (leader=%s)", is_leader)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)

    # Start renew loop only if we're leader
    renew_task = asyncio.create_task(_renew_loop(stop)) if is_leader else None

    await stop.wait()
    if renew_task:
        renew_task.cancel()

    log.info("Worker shutting down…")
    await tunnel.stop_router()
    if is_leader:
        scheduler.shutdown()
        leader.release()
    try:
        await bambu.shutdown()
    except Exception:
        log.exception("Bambu MQTT shutdown error")
    log.info("Worker stopped")


if __name__ == "__main__":
    asyncio.run(main())
