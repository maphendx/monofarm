"""Bambu LAN TLS, MQTT, camera, discovery, and FTPS support."""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import socket
import ssl
import sys
import tempfile
import threading
import time
from pathlib import Path

import httpx
import websockets
import websockets.exceptions

from transports.telegram import alert_should_fire as _alert_should_fire
from transports.telegram import classify_bambu_report
from transports.telegram import dispatch_alert as _dispatch_alert

log = logging.getLogger("monofarm-agent")
BAMBU_FTPS_CONNECT_TIMEOUT = 15
BAMBU_FTPS_IO_TIMEOUT = 120
BAMBU_FTPS_CONNECT_ATTEMPTS = 3
BAMBU_FTPS_RETRY_DELAY = 1.0
MQTT_SUCCESS_RC = 0
_bambu_lan_sub_tasks: dict[str, "asyncio.Task[None]"] = {}
_bambu_lan_sub_configs: dict[str, tuple[str, str]] = {}
_BAMBU_LAN_CONFIG_INTERVAL = 15
_bambu_lan_live_clients: dict[str, object] = {}
_BAMBU_PUSHALL_INTERVAL = 300
_bambu_tls_insecure: set[str] = set()
_bambu_tls_timeouts: dict[str, int] = {}


_BAMBU_CA_PEM = """-----BEGIN CERTIFICATE-----
MIIDZTCCAk2gAwIBAgIUV1FckwXElyek1onFnQ9kL7Bk4N8wDQYJKoZIhvcNAQEL
BQAwQjELMAkGA1UEBhMCQ04xIjAgBgNVBAoMGUJCTCBUZWNobm9sb2dpZXMgQ28u
LCBMdGQxDzANBgNVBAMMBkJCTCBDQTAeFw0yMjA0MDQwMzQyMTFaFw0zMjA0MDEw
MzQyMTFaMEIxCzAJBgNVBAYTAkNOMSIwIAYDVQQKDBlCQkwgVGVjaG5vbG9naWVz
IENvLiwgTHRkMQ8wDQYDVQQDDAZCQkwgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IB
DwAwggEKAoIBAQDL3pnDdxGOk5Z6vugiT4dpM0ju+3Xatxz09UY7mbj4tkIdby4H
oeEdiYSZjc5LJngJuCHwtEbBJt1BriRdSVrF6M9D2UaBDyamEo0dxwSaVxZiDVWC
eeCPdELpFZdEhSNTaT4O7zgvcnFsfHMa/0vMAkvE7i0qp3mjEzYLfz60axcDoJLk
p7n6xKXI+cJbA4IlToFjpSldPmC+ynOo7YAOsXt7AYKY6Glz0BwUVzSJxU+/+VFy
/QrmYGNwlrQtdREHeRi0SNK32x1+bOndfJP0sojuIrDjKsdCLye5CSZIvqnbowwW
1jRwZgTBR29Zp2nzCoxJYcU9TSQp/4KZuWNVAgMBAAGjUzBRMB0GA1UdDgQWBBSP
NEJo3GdOj8QinsV8SeWr3US+HjAfBgNVHSMEGDAWgBSPNEJo3GdOj8QinsV8SeWr
3US+HjAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQABlBIT5ZeG
fgcK1LOh1CN9sTzxMCLbtTPFF1NGGA13mApu6j1h5YELbSKcUqfXzMnVeAb06Htu
3CoCoe+wj7LONTFO++vBm2/if6Jt/DUw1CAEcNyqeh6ES0NX8LJRVSe0qdTxPJuA
BdOoo96iX89rRPoxeed1cpq5hZwbeka3+CJGV76itWp35Up5rmmUqrlyQOr/Wax6
itosIzG0MfhgUzU51A2P/hSnD3NDMXv+wUY/AvqgIL7u7fbDKnku1GzEKIkfH8hm
Rs6d8SCU89xyrwzQ0PR853irHas3WrHVqab3P+qNwR0YirL0Qk7Xt/q3O1griNg2
Blbjg3obpHo9
-----END CERTIFICATE-----
"""

def _bambu_ssl_context(ip: str) -> ssl.SSLContext:
    """TLS context for Bambu LAN services (self-signed/local certs)."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx

def _bambu_mark_tls_failure(ip: str, exc: Exception) -> None:
    """Demote a target to unverified TLS after an SSL error or repeated timeouts."""
    if ip in _bambu_tls_insecure:
        return
    if isinstance(exc, ssl.SSLError) or "SSL" in str(exc) or "certificate" in str(exc).lower():
        log.warning("Bambu TLS verify failed for %s — falling back to unverified", ip)
        _bambu_tls_insecure.add(ip)
        return
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError, RuntimeError)):
        _bambu_tls_timeouts[ip] = _bambu_tls_timeouts.get(ip, 0) + 1
        if _bambu_tls_timeouts[ip] >= 2:
            log.info("Bambu connect kept timing out for %s — retrying with unverified TLS", ip)
            _bambu_tls_insecure.add(ip)

def _connect_bambu_ftps_with_retry(ip: str, connect):
    """Retry only the FTPS control connection; never replay a partial upload."""
    for attempt in range(1, BAMBU_FTPS_CONNECT_ATTEMPTS + 1):
        try:
            return connect()
        except TimeoutError as exc:
            if attempt >= BAMBU_FTPS_CONNECT_ATTEMPTS:
                raise
            log.warning(
                "Bambu FTPS connect failed for %s (attempt %s/%s): %s; retrying",
                ip,
                attempt,
                BAMBU_FTPS_CONNECT_ATTEMPTS,
                exc,
            )
            time.sleep(BAMBU_FTPS_RETRY_DELAY)

    raise RuntimeError("Bambu FTPS retry loop exhausted")

def _mqtt_rc_value(rc) -> int:
    try:
        return int(rc)
    except Exception:
        return int(getattr(rc, "value", 0) or 0)

def ensure_bambu_mqtt_dependency() -> None:
    """Best-effort self-heal for agents auto-updated from pre-LAN-MQTT builds."""
    try:
        import paho.mqtt.client  # noqa: F401
        return
    except ImportError:
        pass

    try:
        import subprocess
        log.info("Installing paho-mqtt for Bambu LAN support…")
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "--quiet", "paho-mqtt"],
            check=False,
            timeout=60,
        )
    except Exception as exc:
        log.debug("paho-mqtt install skipped: %s", exc)

def _mqtt_connect_hint(rc: int) -> str:
    """Map a paho connect rc to an actionable message for the farm operator."""
    if rc in (4, 5):  # bad credentials / not authorized
        return (
            f"connect rc={rc}: принтер відхилив доступ — перевір LAN Access Code; "
            "на прошивці X1/P1 ≥01.07 або A1 ≥01.03 увімкни LAN Only Mode + Developer Mode на принтері"
        )
    return f"connect rc={rc}"

def _bambu_publish_via_live_client(dev_id: str, payload: dict) -> bool:
    """Queue a command through the persistent monitor connection (QoS 1)."""
    client = _bambu_lan_live_clients.get(dev_id)
    if client is None or not getattr(client, "is_connected", lambda: False)():
        return False
    info = client.publish(
        f"device/{dev_id}/request",
        json.dumps(payload, separators=(",", ":")),
        qos=1,
    )
    if info.rc != MQTT_SUCCESS_RC:
        raise RuntimeError(f"publish queue failed (rc={info.rc})")
    return True

def _bambu_mqtt_publish_blocking(dev_id: str, ip: str, access_code: str, payload: dict) -> None:
    """Publish one Bambu LAN MQTT command from a worker thread.

    Prefers the persistent monitor connection (printers limit concurrent MQTT
    clients); falls back to a one-shot connection when no monitor is running.
    """
    try:
        import paho.mqtt.client as mqtt
    except ImportError as exc:
        raise RuntimeError("paho-mqtt is required for Bambu LAN MQTT") from exc

    if _bambu_publish_via_live_client(dev_id, payload):
        return

    connected = threading.Event()
    errors: list[str] = []

    def _on_connect(client, userdata, flags, reason_code, properties=None):
        rc = _mqtt_rc_value(reason_code)
        if rc != 0:
            errors.append(_mqtt_connect_hint(rc))
        connected.set()

    client = mqtt.Client(
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
        protocol=mqtt.MQTTv311,
        client_id=f"monofarm-agent-cmd-{dev_id}",
    )
    client.username_pw_set("bblp", access_code)
    client.tls_set_context(_bambu_ssl_context(ip))
    client.on_connect = _on_connect

    try:
        try:
            client.connect(ip, 8883, 60)
        except ssl.SSLError as exc:
            _bambu_mark_tls_failure(ip, exc)
            client.tls_set_context(_bambu_ssl_context(ip))
            client.connect(ip, 8883, 60)
        client.loop_start()
        if not connected.wait(10):
            raise RuntimeError("connect timeout")
        if errors:
            raise RuntimeError(errors[-1])
        info = client.publish(
            f"device/{dev_id}/request",
            json.dumps(payload, separators=(",", ":")),
            qos=1,
        )
        info.wait_for_publish(timeout=10)
        if not info.is_published():
            raise RuntimeError("publish timeout")
    finally:
        try:
            client.loop_stop()
            client.disconnect()
        except Exception:
            pass

async def handle_bambu_mqtt(ws, req: dict) -> None:
    """Publish a Bambu LAN MQTT command on behalf of the cloud backend."""
    req_id = req.get("id")
    dev_id = (req.get("dev_id") or "").strip()
    ip = (req.get("ip") or "").strip()
    access_code = (req.get("access_code") or "").strip()
    payload = req.get("payload") or {}
    try:
        if not dev_id or not ip or not access_code or not isinstance(payload, dict):
            raise ValueError("missing dev_id/ip/access_code/payload")
        await asyncio.to_thread(_bambu_mqtt_publish_blocking, dev_id, ip, access_code, payload)
        result = {"id": req_id, "status": 200, "body": {"ok": True}, "error": None}
    except Exception as exc:
        log.warning("BAMBU_MQTT error %s@%s: %s", dev_id, ip, exc)
        result = {"id": req_id, "status": 502, "body": None, "error": str(exc)}
    try:
        await ws.send(json.dumps(result))
    except websockets.exceptions.ConnectionClosed as exc:
        log.warning("BAMBU_MQTT response dropped after cloud disconnect: %s", exc)

async def _bambu_lan_mqtt_loop(cloud_ws, printer: dict) -> None:
    """Maintain a direct LAN MQTT subscription and push reports to SaaS."""
    try:
        import paho.mqtt.client as mqtt
    except ImportError:
        log.warning("Bambu LAN monitor disabled: install paho-mqtt")
        return

    dev_id = (printer.get("dev_id") or "").strip()
    ip = (printer.get("ip") or "").strip()
    access_code = (printer.get("access_code") or "").strip()
    name = printer.get("name") or dev_id
    if not dev_id or not ip or not access_code:
        return

    pushall_msg = json.dumps(
        {"pushing": {"command": "pushall", "sequence_id": "0", "version": 1, "push_target": 1}},
        separators=(",", ":"),
    )

    while True:
        connected = asyncio.Event()
        connect_errors: list[str] = []
        loop = asyncio.get_running_loop()
        client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            protocol=mqtt.MQTTv311,
            client_id=f"monofarm-agent-lan-{dev_id}",
        )
        client.username_pw_set("bblp", access_code)
        client.tls_set_context(_bambu_ssl_context(ip))

        def _on_connect(client, userdata, flags, reason_code, properties=None):
            rc = _mqtt_rc_value(reason_code)
            if rc != 0:
                log.warning("BAMBU_LAN_SUB connect failed %s (%s): rc=%s", name, ip, rc)
                connect_errors.append(f"connect rc={rc}")
                loop.call_soon_threadsafe(connected.set)
                return
            log.info("BAMBU_LAN_SUB connected %s (%s)", name, ip)
            client.subscribe(f"device/{dev_id}/report")
            client.publish(f"device/{dev_id}/request", pushall_msg)
            _bambu_lan_live_clients[dev_id] = client
            loop.call_soon_threadsafe(connected.set)

        def _on_disconnect(client, userdata, disconnect_flags, reason_code, properties=None):
            rc = _mqtt_rc_value(reason_code)
            if rc != 0:
                log.warning("BAMBU_LAN_SUB disconnected %s (%s): rc=%s", name, ip, rc)

        def _on_message(client, userdata, msg):
            try:
                payload = json.loads(msg.payload)
            except Exception:
                return
            asyncio.run_coroutine_threadsafe(
                cloud_ws.send(json.dumps({
                    "type": "BAMBU_STATUS_PUSH",
                    "dev_id": dev_id,
                    "payload": payload,
                })),
                loop,
            )
            # Local failure/stop detection. Reports are deltas — merge first.
            pd = payload.get("print")
            if isinstance(pd, dict):
                _state, _etext, _ecode = classify_bambu_report(dev_id, pd)
                if _alert_should_fire(f"bambu:{dev_id}", _state, _ecode):
                    asyncio.run_coroutine_threadsafe(
                        _dispatch_alert(
                            name, _state, _etext, _ecode, "bambu",
                            {"ip": ip, "access_code": access_code},
                        ),
                        loop,
                    )

        client.on_connect = _on_connect
        client.on_disconnect = _on_disconnect
        client.on_message = _on_message

        try:
            client.connect_async(ip, 8883, 60)
            client.loop_start()
            await asyncio.wait_for(connected.wait(), timeout=12)
            if connect_errors:
                raise RuntimeError(connect_errors[-1])
            _bambu_tls_timeouts.pop(ip, None)
            while True:
                # P1/A1 send delta reports only — a throttled pushall keeps the
                # merged server-side state from drifting (spec: max 1 per 5 min).
                await asyncio.sleep(_BAMBU_PUSHALL_INTERVAL)
                if client.is_connected():
                    client.publish(f"device/{dev_id}/request", pushall_msg)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            _bambu_mark_tls_failure(ip, exc)
            log.warning("BAMBU_LAN_SUB error %s (%s): %s — retrying", name, ip, exc)
        finally:
            if _bambu_lan_live_clients.get(dev_id) is client:
                _bambu_lan_live_clients.pop(dev_id, None)
            try:
                client.loop_stop()
                client.disconnect()
            except Exception:
                pass
        await asyncio.sleep(5)

async def _sync_bambu_lan_subscriptions(cloud_ws, printers: list[dict]) -> None:
    wanted: dict[str, dict] = {
        p["dev_id"]: p
        for p in printers
        if p.get("dev_id") and p.get("ip") and p.get("access_code")
    }

    for dev_id in list(_bambu_lan_sub_tasks):
        if dev_id not in wanted:
            _bambu_lan_sub_tasks.pop(dev_id).cancel()
            _bambu_lan_sub_configs.pop(dev_id, None)

    for dev_id, printer in wanted.items():
        cfg = (printer["ip"], printer["access_code"])
        task = _bambu_lan_sub_tasks.get(dev_id)
        if task is not None and not task.done() and _bambu_lan_sub_configs.get(dev_id) == cfg:
            continue
        if task is not None:
            task.cancel()
        _bambu_lan_sub_configs[dev_id] = cfg
        _bambu_lan_sub_tasks[dev_id] = asyncio.create_task(_bambu_lan_mqtt_loop(cloud_ws, printer))

def _cancel_all_bambu_lan_subscriptions() -> None:
    for task in list(_bambu_lan_sub_tasks.values()):
        task.cancel()
    _bambu_lan_sub_tasks.clear()
    _bambu_lan_sub_configs.clear()

async def _bambu_lan_config_loop(cloud_ws, server: str, token: str) -> None:
    headers = {"Authorization": f"Bearer {token}"}
    last_discover = 0.0
    while True:
        try:
            now = asyncio.get_running_loop().time()
            async with httpx.AsyncClient(timeout=10) as client:
                if now - last_discover >= 60:
                    try:
                        await client.get(f"{server}/api/printers/bambu-discover", headers=headers)
                        last_discover = now
                    except Exception as exc:
                        log.debug("Bambu LAN discovery refresh failed: %s", exc)
                resp = await client.get(f"{server}/api/agent/bambu-lan-config", headers=headers)
            if resp.status_code == 200:
                printers = (resp.json() or {}).get("printers") or []
                await _sync_bambu_lan_subscriptions(cloud_ws, printers)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.debug("Bambu LAN config refresh failed: %s", exc)
        await asyncio.sleep(_BAMBU_LAN_CONFIG_INTERVAL)

async def _bambu_grab_frame(ip: str, access_code: str, timeout: float = 12.0) -> bytes | None:
    """Grab a single JPEG frame from a Bambu camera (binary TLS protocol, :6000)."""
    import struct as _struct

    auth = bytearray(80)
    _struct.pack_into("<I", auth, 0, 0x40)
    _struct.pack_into("<I", auth, 4, 0x3000)
    auth[16:20] = b"bblp"
    pw = access_code.encode()
    auth[48:48 + len(pw)] = pw

    writer = None
    try:
        async def _open():
            return await asyncio.open_connection(
                ip, 6000, ssl=_bambu_ssl_context(ip), server_hostname=ip,
            )
        try:
            reader, writer = await asyncio.wait_for(_open(), timeout=timeout)
        except ssl.SSLError as exc:
            _bambu_mark_tls_failure(ip, exc)
            reader, writer = await asyncio.wait_for(_open(), timeout=timeout)
        writer.write(bytes(auth))
        await writer.drain()

        async def read_exact(n: int) -> bytes:
            buf = b""
            while len(buf) < n:
                chunk = await asyncio.wait_for(reader.read(n - len(buf)), timeout=timeout)
                if not chunk:
                    raise ConnectionError("stream closed")
                buf += chunk
            return buf

        header = await read_exact(16)
        size = _struct.unpack("<I", header[0:4])[0]
        if size == 0 or size > 10_000_000:
            return None
        return await read_exact(size)
    except Exception as exc:
        log.debug("bambu frame grab failed %s: %s", ip, exc)
        return None
    finally:
        if writer:
            try:
                writer.close()
            except Exception:
                pass

def _parse_bambu_ssdp(data: bytes, sender_ip: str) -> dict | None:
    """Parse one Bambu SSDP NOTIFY/M-SEARCH response into a device dict."""
    try:
        text = data.decode("utf-8", errors="ignore")
    except Exception:
        return None
    if "bambulab" not in text.lower() and "USN" not in text:
        return None
    headers: dict[str, str] = {}
    for line in text.split("\r\n")[1:]:
        if ":" in line:
            key, _, value = line.partition(":")
            headers[key.strip().lower()] = value.strip()
    serial = headers.get("usn", "")
    if not serial:
        return None
    ip = headers.get("location", "") or sender_ip
    # Location can be a bare IP or a URL — normalize to the host part
    if "//" in ip:
        ip = ip.split("//", 1)[1].split("/", 1)[0].split(":", 1)[0]
    return {
        "dev_id": serial,
        "ip": ip or sender_ip,
        "name": headers.get("devname.bambu.com", ""),
        "model": headers.get("devmodel.bambu.com", ""),
    }

def _bambu_ssdp_scan(timeout: float = 4.0) -> list[dict]:
    """Discover Bambu printers via SSDP (what Bambu Studio and SimplyPrint use).

    Passive: printers broadcast NOTIFY to UDP :2021 every few seconds in LAN mode.
    Active: M-SEARCH to 239.255.255.250:1990 — printers unicast-reply to us.
    """
    import time

    results: dict[str, dict] = {}
    msearch = (
        "M-SEARCH * HTTP/1.1\r\n"
        "HOST: 239.255.255.250:1990\r\n"
        'MAN: "ssdp:discover"\r\n'
        "MX: 3\r\n"
        "ST: urn:bambulab-com:device:3dprinter:1\r\n"
        "\r\n"
    ).encode()

    sockets: list[socket.socket] = []
    try:
        tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        tx.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        tx.bind(("", 0))
        tx.settimeout(0.3)
        for target in ("239.255.255.250", "255.255.255.255"):
            for port in (1990, 2021):
                try:
                    tx.sendto(msearch, (target, port))
                except Exception:
                    pass
        sockets.append(tx)

        try:
            rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            rx.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            if hasattr(socket, "SO_REUSEPORT"):  # share :2021 with Bambu Studio
                rx.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
            rx.bind(("", 2021))
            try:
                mreq = socket.inet_aton("239.255.255.250") + socket.inet_aton("0.0.0.0")
                rx.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
            except Exception:
                pass
            rx.settimeout(0.3)
            sockets.append(rx)
        except Exception as e:
            log.debug("SSDP passive listen unavailable (%s) — active scan only", e)

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for sock in sockets:
                try:
                    data, addr = sock.recvfrom(8192)
                except (socket.timeout, BlockingIOError):
                    continue
                except Exception:
                    continue
                device = _parse_bambu_ssdp(data, addr[0])
                if device:
                    results[device["dev_id"]] = device
    finally:
        for sock in sockets:
            try:
                sock.close()
            except Exception:
                pass
    return list(results.values())

async def handle_discover_bambu(ws, req: dict) -> None:
    """Run Bambu SSDP discovery on the agent machine (local farm network)."""
    req_id = req.get("id")
    try:
        devices = await asyncio.to_thread(_bambu_ssdp_scan, 4.0)
    except Exception as e:
        log.warning("Bambu discover error: %s", e)
        devices = []

    await ws.send(json.dumps({
        "id": req_id,
        "status": 200,
        "body": {"devices": devices},
        "error": None,
    }))

async def handle_bambu_camera(ws, req: dict) -> None:
    """Stream Bambu A1/P1 camera via native binary TLS protocol on port 6000.

    Protocol: github.com/Doridian/OpenBambuAPI/blob/main/video.md
    Uses asyncio streams (non-blocking) so the WebSocket loop stays responsive.
    """
    import struct as _struct
    req_id      = req.get("id")
    ip          = (req.get("ip") or "").strip()
    access_code = (req.get("access_code") or "").strip()
    port        = 6000

    auth = bytearray(80)
    _struct.pack_into('<I', auth,  0, 0x40)
    _struct.pack_into('<I', auth,  4, 0x3000)
    auth[16:20] = b'bblp'
    pw = access_code.encode()
    auth[48:48+len(pw)] = pw

    log.info("BAMBU_CAMERA: connecting to %s:%s", ip, port)
    await ws.send(json.dumps({"id": req_id, "type": "stream_start", "status": 200,
                              "content_type": "multipart/x-mixed-replace; boundary=frame"}))
    reader = writer = None
    try:
        try:
            reader, writer = await asyncio.open_connection(
                ip, port, ssl=_bambu_ssl_context(ip), server_hostname=ip,
            )
        except ssl.SSLError as exc:
            _bambu_mark_tls_failure(ip, exc)
            reader, writer = await asyncio.open_connection(
                ip, port, ssl=_bambu_ssl_context(ip), server_hostname=ip,
            )
        log.info("BAMBU_CAMERA: TLS connected, sending auth")
        writer.write(bytes(auth))
        await writer.drain()

        async def read_exact(n: int) -> bytes:
            buf = b""
            while len(buf) < n:
                chunk = await asyncio.wait_for(reader.read(n - len(buf)), timeout=30)
                if not chunk:
                    raise ConnectionError("Stream closed")
                buf += chunk
            return buf

        while True:
            header       = await read_exact(16)
            payload_size = _struct.unpack('<I', header[0:4])[0]
            if payload_size == 0 or payload_size > 10_000_000:
                continue  # skip invalid frames
            jpeg        = await read_exact(payload_size)
            mjpeg_chunk = b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpeg + b"\r\n"
            await ws.send(json.dumps({
                "id": req_id, "type": "chunk",
                "data": base64.b64encode(mjpeg_chunk).decode(),
            }))
    except Exception as e:
        log.warning("Bambu camera error %s: %s", ip, e)
    finally:
        if writer:
            try:
                writer.close()
            except Exception:
                pass
        try:
            await ws.send(json.dumps({"id": req_id, "type": "stream_end"}))
        except Exception:
            pass

async def handle_bambu_upload(ws, req: dict) -> None:
    """Upload a .3mf file to a Bambu printer via LAN FTPS (:990).

    File source: either `url` (presigned R2 — agent downloads directly, preferred
    to avoid +33% base64 overhead) or `data_b64` (fallback for local-disk backends).

    Uploads into `cache/` by default. A1/A1 mini project_file jobs must be
    uploaded to the SD root and launched as file:///sdcard/<name>, so the
    backend can request `target_dir=sdcard`. Returns the path actually used so
    the backend can build the matching `project_file` URL.
    """
    import ftplib
    import ssl as _ssl
    import time

    class _ImplicitFTP_TLS(ftplib.FTP_TLS):
        """Bambu printers serve IMPLICIT FTPS on :990 — the socket must be TLS
        from the first byte. Stdlib FTP_TLS does EXPLICIT AUTH-TLS (connects in
        plaintext, waits for a "220" greeting), which hangs until timeout against
        :990. Wrapping the socket on assignment makes the command channel
        implicit; prot_p() still covers the data channel via the base class."""
        @property
        def sock(self):
            return self._sock

        @sock.setter
        def sock(self, value):
            if value is not None and not isinstance(value, _ssl.SSLSocket):
                value = self.context.wrap_socket(value)
            self._sock = value

        def storbinary(self, cmd, fp, blocksize=8192, callback=None, rest=None):
            # Bambu firmware never sends a TLS close_notify on the data channel,
            # so stdlib's conn.unwrap() after the transfer blocks until timeout.
            # The 226 on the command channel (voidresp) already confirms the
            # upload, so send the bytes and skip the unwrap.
            self.voidcmd("TYPE I")
            conn = self.transfercmd(cmd, rest)
            try:
                while buf := fp.read(blocksize):
                    conn.sendall(buf)
                    if callback:
                        callback(buf)
                if isinstance(conn, _ssl.SSLSocket):
                    try:
                        conn.settimeout(0.5)
                        conn.unwrap()
                    except Exception:
                        pass
            finally:
                conn.close()
            return self.voidresp()

    req_id      = req.get("id")
    ip          = (req.get("ip") or "").strip()
    access_code = (req.get("access_code") or "").strip()
    filename    = req.get("filename", "model.3mf")
    target_dir  = (req.get("target_dir") or "cache").strip().lower()
    url         = req.get("url")
    data_b64    = req.get("data_b64", "")
    temp_path: Path | None = None
    progress = {"phase": "downloading", "sent": 0, "total": 0}
    progress_task: asyncio.Task | None = None

    async def _report_progress() -> None:
        last: tuple[str, int, int] | None = None
        last_sent_at = 0.0
        while True:
            current = (progress["phase"], progress["sent"], progress["total"])
            now = time.monotonic()
            if current != last or now - last_sent_at >= 5.0:
                try:
                    await ws.send(json.dumps({
                        "id": req_id,
                        "type": "upload_progress",
                        "phase": current[0],
                        "sent": current[1],
                        "total": current[2],
                        "heartbeat": current == last,
                    }))
                    last = current
                    last_sent_at = now
                except Exception:
                    return
            await asyncio.sleep(1.0)

    try:
        with tempfile.NamedTemporaryFile(suffix=".3mf", delete=False) as tmp:
            temp_path = Path(tmp.name)
        progress_task = asyncio.create_task(_report_progress())

        if url:
            async with httpx.AsyncClient(timeout=httpx.Timeout(180, connect=30), verify=False) as client:  # noqa: S501
                async with client.stream("GET", url) as resp:
                    resp.raise_for_status()
                    progress["total"] = int(resp.headers.get("content-length") or 0)
                    with temp_path.open("wb") as file_obj:
                        async for chunk in resp.aiter_bytes(1024 * 1024):
                            file_obj.write(chunk)
                            progress["sent"] += len(chunk)
        else:
            file_bytes = base64.b64decode(data_b64)
            progress["total"] = len(file_bytes)
            temp_path.write_bytes(file_bytes)
        progress["phase"] = "uploading"
        progress["sent"] = 0

        def _ftp_connect() -> "ftplib.FTP_TLS":
            ftp = _ImplicitFTP_TLS(context=_bambu_ssl_context(ip))
            try:
                ftp.connect(ip, 990, timeout=BAMBU_FTPS_CONNECT_TIMEOUT)
                ftp.login(user="bblp", passwd=access_code)
            except Exception:
                try:
                    ftp.close()
                except Exception:
                    pass
                raise
            # ftplib reuses self.timeout for every data connection: keep the
            # short timeout for the TCP+TLS handshake, then relax it so an SD
            # write stall mid-transfer doesn't kill the upload
            # ("The write operation timed out").
            ftp.timeout = BAMBU_FTPS_IO_TIMEOUT
            ftp.sock.settimeout(BAMBU_FTPS_IO_TIMEOUT)
            return ftp

        def _ftp_upload() -> str:
            ftp = _connect_bambu_ftps_with_retry(ip, _ftp_connect)
            ftp.prot_p()
            remote_path = filename
            if target_dir != "sdcard":
                try:
                    try:
                        ftp.cwd("cache")
                    except ftplib.error_perm:
                        ftp.mkd("cache")
                        ftp.cwd("cache")
                    remote_path = f"cache/{filename}"
                except ftplib.all_errors:
                    pass  # old firmware without cache dir: upload to SD root
            with temp_path.open("rb") as file_obj:
                ftp.storbinary(
                    f"STOR {filename}",
                    file_obj,
                    blocksize=64 * 1024,
                    callback=lambda chunk: progress.__setitem__("sent", progress["sent"] + len(chunk)),
                )
            try:
                ftp.quit()
            except ftplib.all_errors:
                pass
            return remote_path

        # Run blocking FTP in a thread so asyncio event loop stays alive
        # (handles WS keepalive pings during upload)
        remote_path = await asyncio.to_thread(_ftp_upload)
        progress["sent"] = progress["total"]
        try:
            await ws.send(json.dumps({
                "id": req_id,
                "type": "upload_progress",
                "phase": "uploading",
                "sent": progress["sent"],
                "total": progress["total"],
            }))
        except Exception:
            pass

        result = {
            "id": req_id, "status": 200,
            "body": {"filename": filename, "path": remote_path}, "error": None,
        }
    except Exception as e:
        log.warning("BAMBU_UPLOAD error %s: %s", ip, e)
        result = {"id": req_id, "status": 502, "body": None, "error": str(e)}
    finally:
        if progress_task:
            progress_task.cancel()
            try:
                await progress_task
            except asyncio.CancelledError:
                pass
        if temp_path:
            temp_path.unlink(missing_ok=True)

    await ws.send(json.dumps(result))
