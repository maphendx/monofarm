#!/usr/bin/env python3
"""monofarm-agent — local network tunnel for Moonraker printers and cameras.

Runs on a Raspberry Pi or any PC on the same network as your printers.
Makes an outbound WebSocket connection to monofarm cloud so the server
can reach local Moonraker instances and camera streams without port forwarding.

Wire protocol:
  Regular:  Server→Agent  {"id":"…","method":"GET","url":"…","body":null}
            Agent→Server  {"id":"…","status":200,"body":{…},"error":null}

  Streaming: Server→Agent  {"id":"…","method":"STREAM","url":"…"}
             Agent→Server  {"id":"…","type":"stream_start","status":200}
             Agent→Server  {"id":"…","type":"chunk","data":"<base64>"}  (repeated)
             Agent→Server  {"id":"…","type":"stream_end"}

Usage:
    python monofarm_agent.py --server https://monofarm.app --token YOUR_JWT_TOKEN
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import socket
import ssl
import logging
import sys
from pathlib import Path

AGENT_VERSION = "0.4.5"
UPDATE_INTERVAL = 6 * 3600  # check every 6 hours

try:
    import httpx
    import websockets
    import websockets.exceptions
except ImportError:
    print("Missing dependencies. Run: pip install websockets httpx")
    sys.exit(1)


log = logging.getLogger("monofarm-agent")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")

RECONNECT_DELAY = 5    # seconds between reconnect attempts
REQUEST_TIMEOUT = 10   # seconds per regular proxied request
STREAM_CHUNK    = 32768  # bytes per chunk for streaming


async def check_for_update(server: str) -> None:
    """Download and apply a new agent version, then restart via os.execv."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{server}/api/agent/version")
            if resp.status_code != 200:
                return
            remote = resp.json().get("version", "")
            if not remote or remote == AGENT_VERSION:
                return
            log.info("Update available: %s → %s. Downloading…", AGENT_VERSION, remote)
            src_resp = await client.get(f"{server}/agent/monofarm_agent.py")
            src_resp.raise_for_status()
            script = Path(__file__).resolve()
            script.write_bytes(src_resp.content)
            log.info("Updated to %s. Restarting…", remote)
            os.execv(sys.executable, [sys.executable] + sys.argv)
    except Exception as e:
        log.debug("Update check skipped: %s", e)


async def _update_loop(server: str) -> None:
    while True:
        await asyncio.sleep(UPDATE_INTERVAL)
        await check_for_update(server)


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


async def handle_discover_bambu(ws, req: dict) -> None:
    """Run Bambu UDP discovery on the agent machine (local farm network)."""
    import json as _json
    import socket
    import time

    req_id  = req.get("id")
    port    = 2021
    timeout = 3.0
    results: dict[str, dict] = {}

    try:
        msg  = _json.dumps({"command": "get_version"}).encode()
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("", 0))
        sock.settimeout(0.2)
        for target in ["255.255.255.255"]:
            try:
                sock.sendto(msg, (target, port))
            except Exception:
                pass
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                data, addr = sock.recvfrom(4096)
                payload = _json.loads(data)
                dev_id = payload.get("dev_id") or payload.get("sn") or ""
                if dev_id:
                    results[dev_id] = {
                        "dev_id": dev_id,
                        "ip": addr[0],
                        "name": payload.get("dev_name") or payload.get("name") or "",
                        "model": payload.get("dev_product_name") or payload.get("machine_type") or "",
                    }
            except socket.timeout:
                continue
            except Exception:
                continue
        sock.close()
    except Exception as e:
        log.warning("Bambu discover error: %s", e)

    await ws.send(_json.dumps({
        "id": req_id,
        "status": 200,
        "body": {"devices": list(results.values())},
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


async def handle_bambu_camera(ws, req: dict) -> None:
    """Stream Bambu A1/P1 camera via native binary TLS protocol on port 6000.

    Protocol: github.com/Doridian/OpenBambuAPI/blob/main/video.md
    Uses asyncio streams (non-blocking) so the WebSocket loop stays responsive.
    """
    import struct as _struct
    req_id      = req.get("id")
    ip          = req.get("ip", "")
    access_code = req.get("access_code", "")
    port        = 6000

    ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ssl_ctx.check_hostname = False
    ssl_ctx.verify_mode    = ssl.CERT_NONE

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
        reader, writer = await asyncio.open_connection(ip, port, ssl=ssl_ctx, server_hostname=ip)
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


async def handle_bambu_upload(ws, req: dict) -> None:
    """Upload a .3mf file to a Bambu printer via LAN FTPS (:990).

    File source: either `url` (presigned R2 — agent downloads directly, preferred
    to avoid +33% base64 overhead) or `data_b64` (fallback for local-disk backends).
    """
    import ftplib
    import io as _io
    import ssl as _ssl

    req_id      = req.get("id")
    ip          = req.get("ip", "")
    access_code = req.get("access_code", "")
    filename    = req.get("filename", "model.3mf")
    url         = req.get("url")
    data_b64    = req.get("data_b64", "")

    try:
        if url:
            async with httpx.AsyncClient(timeout=120, verify=False) as client:  # noqa: S501
                resp = await client.get(url)
                resp.raise_for_status()
                file_bytes = resp.content
        else:
            file_bytes = base64.b64decode(data_b64)

        ctx = _ssl.SSLContext(_ssl.PROTOCOL_TLS_CLIENT)
        ctx.check_hostname = False
        ctx.verify_mode    = _ssl.CERT_NONE

        ftp = ftplib.FTP_TLS(context=ctx)
        ftp.connect(ip, 990, timeout=60)
        ftp.login(user="bblp", passwd=access_code)
        ftp.prot_p()

        ftp.storbinary(f"STOR {filename}", _io.BytesIO(file_bytes))
        ftp.quit()

        result = {"id": req_id, "status": 200, "body": {"filename": filename}, "error": None}
    except Exception as e:
        log.warning("BAMBU_UPLOAD error %s: %s", ip, e)
        result = {"id": req_id, "status": 502, "body": None, "error": str(e)}

    await ws.send(json.dumps(result))


async def handle_moonraker_upload(ws, req: dict) -> None:
    """Upload a gcode/3mf file to Moonraker via multipart POST.

    Cloud backend sends bytes as base64; agent does the actual LAN upload.
    """
    req_id      = req.get("id")
    url         = req.get("url", "")         # bare Moonraker base URL
    filename    = req.get("filename", "file.gcode")
    data_b64    = req.get("data_b64", "")
    start_print = req.get("start_print", False)

    try:
        file_bytes = base64.b64decode(data_b64)

        import io as _io
        async with httpx.AsyncClient(timeout=120, verify=False) as client:  # noqa: S501
            resp = await client.post(
                f"{url}/server/files/upload",
                files={"file": (filename, _io.BytesIO(file_bytes), "application/octet-stream")},
                data={"root": "gcodes", "print": "true" if start_print else "false"},
            )
        result = {
            "id": req_id,
            "status": resp.status_code,
            "body": resp.json() if resp.content else {},
            "error": None if resp.status_code < 400 else resp.text,
        }
    except Exception as e:
        log.warning("MOONRAKER_UPLOAD error %s: %s", url, e)
        result = {"id": req_id, "status": 502, "body": None, "error": str(e)}

    await ws.send(json.dumps(result))


async def run(server: str, token: str) -> None:
    ws_url = (
        server.replace("https://", "wss://").replace("http://", "ws://")
        + f"/api/agent/connect?token={token}"
    )
    log.info("monofarm-agent v%s connecting to %s …", AGENT_VERSION, server)
    await check_for_update(server)
    asyncio.create_task(_update_loop(server))

    while True:
        try:
            async with websockets.connect(
                ws_url,
                ping_interval=20,
                ping_timeout=10,
                open_timeout=15,
                max_size=None,  # allow large messages (base64 chunks)
            ) as ws:
                log.info("Connected to monofarm cloud ✓  (waiting for requests…)")
                async for message in ws:
                    try:
                        req = json.loads(message)
                    except json.JSONDecodeError:
                        log.warning("Received invalid JSON from server")
                        continue

                    method = req.get("method", "GET").upper()
                    if method == "BAMBU_CAMERA":
                        asyncio.create_task(handle_bambu_camera(ws, req))
                    elif method == "FFMPEG_STREAM":
                        asyncio.create_task(handle_ffmpeg_stream(ws, req))
                    elif method == "DISCOVER_BAMBU":
                        asyncio.create_task(handle_discover_bambu(ws, req))
                    elif method == "BAMBU_UPLOAD":
                        asyncio.create_task(handle_bambu_upload(ws, req))
                    elif method == "MOONRAKER_UPLOAD":
                        asyncio.create_task(handle_moonraker_upload(ws, req))
                    elif method == "STREAM":
                        asyncio.create_task(handle_stream(ws, req))
                    else:
                        asyncio.create_task(handle_request(ws, req))

        except websockets.exceptions.InvalidStatusCode as e:
            if e.status_code in (4001, 4002):
                log.error("Authentication failed (code %s). Check your --token.", e.status_code)
                sys.exit(1)
            log.warning("Server rejected connection (%s). Retrying in %ss…", e.status_code, RECONNECT_DELAY)
        except (OSError, websockets.exceptions.WebSocketException) as e:
            log.warning("Disconnected: %s. Retrying in %ss…", e, RECONNECT_DELAY)
        except Exception as e:
            log.exception("Unexpected error: %s", e)

        await asyncio.sleep(RECONNECT_DELAY)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="monofarm local agent — tunnels Moonraker and camera access to the cloud",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python monofarm_agent.py --token eyJ...
  python monofarm_agent.py --server https://my.monofarm.app --token eyJ...

Get your token in monofarm → Settings → Agent Connection.
        """,
    )
    parser.add_argument("--server", default="https://monofarm.app",
                        help="monofarm server URL (default: https://monofarm.app)")
    parser.add_argument("--token", required=True,
                        help="Your monofarm JWT token (from Settings → Agent Connection)")
    args = parser.parse_args()

    try:
        asyncio.run(run(args.server, args.token))
    except KeyboardInterrupt:
        log.info("Agent stopped.")


if __name__ == "__main__":
    main()
