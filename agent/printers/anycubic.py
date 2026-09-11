"""Anycubic LAN MQTT monitoring and commands."""
from __future__ import annotations

import asyncio
import json
import logging
import ssl
import time
import uuid

import httpx
import websockets
import websockets.exceptions

log = logging.getLogger("monofarm-agent")
_anycubic_sub_tasks: dict[str, "asyncio.Task[None]"] = {}
_anycubic_sub_configs: dict[str, str] = {}
_ANYCUBIC_CONFIG_INTERVAL = 15
_ANYCUBIC_STATUS_POLL_INTERVAL = 10
_anycubic_live_clients: dict[str, object] = {}


def _anycubic_poll_requests(
    model_id: str,
    dev_id: str,
    *,
    timestamp_ms: int | None = None,
) -> list[tuple[str, str]]:
    from anycubic_local import const as ac_const

    timestamp = int(time.time() * 1000) if timestamp_ms is None else timestamp_ms
    return [
        (
            ac_const.query_topic(model_id, dev_id, msg_type),
            json.dumps({
                "type": msg_type,
                "action": action,
                "timestamp": timestamp,
                "msgid": str(uuid.uuid4()),
                "data": None,
            }),
        )
        for msg_type, action in (("info", "query"), ("multiColorBox", "getInfo"))
    ]

async def handle_anycubic_command(ws, req: dict) -> None:
    """Publish an Anycubic LAN MQTT command on behalf of the cloud backend."""
    from anycubic_local import commands as anycubic_commands

    req_id = req.get("id")
    dev_id = (req.get("dev_id") or "").strip()
    model_id = (req.get("model_id") or "").strip()
    command = req.get("command") or ""
    try:
        client = _anycubic_live_clients.get(dev_id)
        if client is None or not client.is_connected():
            raise RuntimeError("printer not connected to LAN monitor")
        topic, payload = anycubic_commands.build(
            model_id, dev_id, command,
            value=req.get("value"), on=req.get("on"), brightness=req.get("brightness"),
            ts=int(time.time() * 1000),
        )
        client.publish(topic, json.dumps(payload))
        result = {"id": req_id, "status": 200, "body": {"ok": True}, "error": None}
    except Exception as exc:
        log.warning("ANYCUBIC_MQTT error %s: %s", dev_id, exc)
        result = {"id": req_id, "status": 502, "body": None, "error": str(exc)}
    try:
        await ws.send(json.dumps(result))
    except websockets.exceptions.ConnectionClosed as exc:
        log.warning("ANYCUBIC_MQTT response dropped after cloud disconnect: %s", exc)

async def _anycubic_lan_loop(cloud_ws, printer: dict, server: str, token: str) -> None:
    """Handshake + maintain a LAN MQTT subscription for one Anycubic printer; push reports to SaaS."""
    from anycubic_local import const as ac_const
    from anycubic_local import handshake as ac_handshake

    try:
        import paho.mqtt.client as mqtt
    except ImportError:
        log.warning("Anycubic LAN monitor disabled: install paho-mqtt")
        return

    printer_id = printer.get("id")
    ip = (printer.get("ip") or "").strip()
    name = printer.get("name") or ip
    if not ip:
        return

    while True:
        try:
            hs = await asyncio.to_thread(ac_handshake.do_handshake, ip)
        except Exception as exc:
            log.warning("ANYCUBIC_SUB handshake failed %s (%s): %s", name, ip, exc)
            await asyncio.sleep(15)
            continue

        if hs.device_id != printer.get("dev_id") or hs.model_id != printer.get("model_id"):
            try:
                async with httpx.AsyncClient(timeout=10) as client:
                    await client.post(
                        f"{server}/api/agent/anycubic-discovered",
                        headers={"Authorization": f"Bearer {token}"},
                        json={"printer_id": printer_id, "dev_id": hs.device_id,
                              "model_id": hs.model_id, "model_name": hs.model_name},
                    )
                printer = {**printer, "dev_id": hs.device_id, "model_id": hs.model_id}
            except Exception as exc:
                log.debug("anycubic-discovered report failed: %s", exc)

        dev_id = hs.device_id
        connected = asyncio.Event()
        loop = asyncio.get_running_loop()
        client = mqtt.Client(client_id=f"monofarm-agent-{dev_id}",
                              callback_api_version=mqtt.CallbackAPIVersion.VERSION2)
        client.username_pw_set(hs.username, hs.password)
        client.tls_set(cert_reqs=ssl.CERT_NONE)
        client.tls_insecure_set(True)

        def _on_connect(client, userdata, flags, rc, properties=None):
            if rc != 0:
                log.warning("ANYCUBIC_SUB connect failed %s (%s): rc=%s", name, ip, rc)
                loop.call_soon_threadsafe(connected.set)
                return
            log.info("ANYCUBIC_SUB connected %s (%s)", name, ip)
            client.subscribe(f"{ac_const.report_prefix(hs.model_id, dev_id)}/#")
            loop.call_soon_threadsafe(connected.set)

        def _on_message(client, userdata, message):
            try:
                obj = json.loads(message.payload)
            except Exception:
                return
            if obj.get("action") == "query" and obj.get("data") is None and "state" not in obj:
                return  # our own echoed query
            msg_type = obj.get("type")
            data = obj.get("data")
            if data is None:
                return
            push_type = {"info": "ANYCUBIC_STATUS_PUSH", "multiColorBox": "ANYCUBIC_ACE_PUSH"}.get(msg_type)
            if push_type is None:
                return
            asyncio.run_coroutine_threadsafe(
                cloud_ws.send(json.dumps({"type": push_type, "dev_id": dev_id, "payload": data})),
                loop,
            )

        client.on_connect = _on_connect
        client.on_message = _on_message

        try:
            client.connect_async(hs.broker_host, hs.broker_port, keepalive=60)
            client.loop_start()
            await asyncio.wait_for(connected.wait(), timeout=12)
            if not client.is_connected():
                raise RuntimeError("MQTT connection rejected")
            _anycubic_live_clients[dev_id] = client
            while True:
                if not client.is_connected():
                    raise RuntimeError("MQTT connection lost")
                for topic, body in _anycubic_poll_requests(hs.model_id, dev_id):
                    client.publish(topic, body)
                await asyncio.sleep(_ANYCUBIC_STATUS_POLL_INTERVAL)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning("ANYCUBIC_SUB error %s (%s): %s — retrying", name, ip, exc)
        finally:
            if _anycubic_live_clients.get(dev_id) is client:
                _anycubic_live_clients.pop(dev_id, None)
            try:
                client.loop_stop()
                client.disconnect()
            except Exception:
                pass
        await asyncio.sleep(5)

async def _sync_anycubic_subscriptions(cloud_ws, printers: list[dict], server: str, token: str) -> None:
    wanted: dict[str, dict] = {p["ip"]: p for p in printers if p.get("ip")}

    for ip in list(_anycubic_sub_tasks):
        if ip not in wanted:
            _anycubic_sub_tasks.pop(ip).cancel()
            _anycubic_sub_configs.pop(ip, None)

    for ip, printer in wanted.items():
        cfg = f"{printer.get('dev_id')}:{printer.get('model_id')}"
        task = _anycubic_sub_tasks.get(ip)
        if task is not None and not task.done() and _anycubic_sub_configs.get(ip) == cfg:
            continue
        if task is not None:
            task.cancel()
        _anycubic_sub_configs[ip] = cfg
        _anycubic_sub_tasks[ip] = asyncio.create_task(_anycubic_lan_loop(cloud_ws, printer, server, token))

def _cancel_all_anycubic_subscriptions() -> None:
    for task in list(_anycubic_sub_tasks.values()):
        task.cancel()
    _anycubic_sub_tasks.clear()
    _anycubic_sub_configs.clear()

async def _anycubic_config_loop(cloud_ws, server: str, token: str) -> None:
    headers = {"Authorization": f"Bearer {token}"}
    while True:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(f"{server}/api/agent/anycubic-lan-config", headers=headers)
            if resp.status_code == 200:
                printers = (resp.json() or {}).get("printers") or []
                await _sync_anycubic_subscriptions(cloud_ws, printers, server, token)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.debug("Anycubic LAN config refresh failed: %s", exc)
        await asyncio.sleep(_ANYCUBIC_CONFIG_INTERVAL)
