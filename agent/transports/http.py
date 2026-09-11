"""Generic HTTP proxying, discovery, and media streaming."""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import socket

import httpx

log = logging.getLogger("monofarm-agent")
REQUEST_TIMEOUT = 10
STREAM_CHUNK = 32768


async def handle_request(ws, req: dict) -> None:
    """Proxy a single HTTP request/response."""
    req_id = req.get("id")
    url    = req.get("url", "")
    method = req.get("method", "GET").upper()
    body   = req.get("body")

    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT, verify=False) as client:  # noqa: S501
            resp = await client.request(method, url, json=body)
            content_type = resp.headers.get("content-type", "")
            if "json" in content_type or resp.content.startswith(b"{") or resp.content.startswith(b"["):
                try:
                    resp_body = resp.json()
                    result = {"id": req_id, "status": resp.status_code, "body": resp_body, "error": None}
                except Exception:
                    result = {"id": req_id, "status": resp.status_code, "body": {"raw": resp.text}, "error": None}
            else:
                # Binary response (e.g. JPEG image) — base64 encode
                result = {
                    "id": req_id,
                    "status": resp.status_code,
                    "body": None,
                    "binary": base64.b64encode(resp.content).decode(),
                    "content_type": content_type,
                    "error": None,
                }
    except httpx.TimeoutException:
        log.warning("Timeout proxying %s %s", method, url)
        result = {"id": req_id, "status": 504, "body": None, "error": "timeout"}
    except Exception as e:
        log.warning("Error proxying %s %s: %s", method, url, e)
        result = {"id": req_id, "status": 502, "body": None, "error": str(e)}

    await ws.send(json.dumps(result))

async def _discover_via_mdns() -> list[dict]:
    """Try mDNS/Zeroconf for _moonraker._tcp.local. services (2s window).

    Returns [] if zeroconf is not installed or no devices respond.
    """
    try:
        import zeroconf as _zc
    except ImportError:
        return []

    found: dict[str, dict] = {}

    class _Listener:
        def add_service(self, zc: "_zc.Zeroconf", type_: str, name: str) -> None:
            info = zc.get_service_info(type_, name)
            if not info:
                return
            for addr in info.parsed_addresses():
                port = info.port or 7125
                url = f"http://{addr}:{port}"
                hostname = (info.server or "").rstrip(".")
                found[url] = {"url": url, "name": hostname or addr}

        def remove_service(self, *_) -> None:
            pass

        def update_service(self, *_) -> None:
            pass

    def _scan() -> list[dict]:
        import time
        zc = _zc.Zeroconf()
        listener = _Listener()
        _zc.ServiceBrowser(zc, "_moonraker._tcp.local.", listener)
        time.sleep(2.0)
        zc.close()
        return list(found.values())

    try:
        return await asyncio.wait_for(asyncio.to_thread(_scan), timeout=5.0)
    except Exception:
        return []

async def handle_discover_moonraker(ws, req: dict) -> None:
    """Scan the local network for Moonraker instances.

    Strategy: mDNS first (fast, ~2s), then /24 TCP port scan for any host
    not already found via mDNS. Results are merged and deduplicated.
    """
    import ipaddress

    req_id = req.get("id")

    # ── Step 1: mDNS (zeroconf) ───────────────────────────────────────────────
    mdns_results = await _discover_via_mdns()
    mdns_urls = {r["url"].rstrip("/") for r in mdns_results}
    results: list[dict] = list(mdns_results)

    # ── Step 2: /24 TCP scan ──────────────────────────────────────────────────
    subnets: set[str] = set()
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None):
            addr = info[4][0]
            if addr.startswith("192.168.") or addr.startswith("10.") or addr.startswith("172."):
                net = ipaddress.IPv4Network(f"{addr}/24", strict=False)
                subnets.add(str(net))
    except Exception:
        pass
    if not subnets:
        subnets.add("192.168.1.0/24")

    async def _probe(ip: str) -> dict | None:
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(ip, 7125), timeout=0.3
            )
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
            url = f"http://{ip}:7125"
            if url.rstrip("/") in mdns_urls:
                return None  # already found via mDNS
            try:
                async with httpx.AsyncClient(timeout=2.0) as client:
                    r = await client.get(f"{url}/printer/info")
                    if r.status_code == 200:
                        data = r.json().get("result", {})
                        return {"url": url, "name": data.get("hostname") or ip}
            except Exception:
                return {"url": url, "name": ip}
        except Exception:
            return None

    tasks = []
    for subnet in subnets:
        try:
            net = ipaddress.IPv4Network(subnet)
            for host in net.hosts():
                tasks.append(_probe(str(host)))
        except Exception:
            pass

    probed = await asyncio.gather(*tasks)
    for r in probed:
        if r is not None:
            results.append(r)

    import json as _json
    await ws.send(_json.dumps({
        "id": req_id,
        "status": 200,
        "body": {"devices": results},
        "error": None,
    }))

async def handle_stream(ws, req: dict) -> None:
    """Proxy a streaming HTTP response (e.g. MJPEG from go2rtc) chunk by chunk."""
    req_id = req.get("id")
    url    = req.get("url", "")

    try:
        async with httpx.AsyncClient(timeout=None, verify=False) as client:  # noqa: S501
            async with client.stream("GET", url) as resp:
                await ws.send(json.dumps({
                    "id": req_id,
                    "type": "stream_start",
                    "status": resp.status_code,
                    "content_type": resp.headers.get("content-type", ""),
                }))
                async for chunk in resp.aiter_bytes(STREAM_CHUNK):
                    await ws.send(json.dumps({
                        "id": req_id,
                        "type": "chunk",
                        "data": base64.b64encode(chunk).decode(),
                    }))
    except Exception as e:
        log.warning("Stream error %s: %s", url, e)
    finally:
        try:
            await ws.send(json.dumps({"id": req_id, "type": "stream_end"}))
        except Exception:
            pass

async def handle_ffmpeg_stream(ws, req: dict) -> None:
    """Stream Bambu RTSPS camera via local FFmpeg — same approach as SimplyPrint Pi hub.

    Runs FFmpeg on the agent machine (farm PC / Pi), which is on the same LAN
    as the printer. Sends MJPEG frames back as base64 chunks.
    """
    import shutil
    req_id = req.get("id")
    rtsps_url = req.get("url", "")

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        await ws.send(json.dumps({
            "id": req_id, "type": "stream_end",
            "error": "ffmpeg not found on agent machine",
        }))
        return

    cmd = [
        ffmpeg, "-loglevel", "quiet",
        "-rtsp_transport", "tcp", "-tls_verify", "0",
        "-i", rtsps_url,
        "-vf", "fps=5",
        "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "3",
        "pipe:1",
    ]

    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await ws.send(json.dumps({
            "id": req_id, "type": "stream_start",
            "status": 200, "content_type": "multipart/x-mixed-replace; boundary=frame",
        }))
        buf = b""
        while True:
            chunk = await proc.stdout.read(65536)
            if not chunk:
                break
            buf += chunk
            # Extract complete JPEG frames
            while True:
                start = buf.find(b"\xff\xd8")
                if start < 0:
                    break
                end = buf.find(b"\xff\xd9", start + 2)
                if end < 0:
                    break
                frame = buf[start:end + 2]
                buf = buf[end + 2:]
                mjpeg_chunk = (
                    b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + frame + b"\r\n"
                )
                await ws.send(json.dumps({
                    "id": req_id, "type": "chunk",
                    "data": base64.b64encode(mjpeg_chunk).decode(),
                }))
    except Exception as e:
        log.warning("FFmpeg stream error: %s", e)
    finally:
        if proc:
            try:
                proc.kill()
                await proc.wait()
            except Exception:
                pass
        try:
            await ws.send(json.dumps({"id": req_id, "type": "stream_end"}))
        except Exception:
            pass
