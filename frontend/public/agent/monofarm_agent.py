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
    python monofarm_agent.py --server https://api.monofarm.app --token YOUR_JWT_TOKEN
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

AGENT_VERSION = "0.4.8"
UPDATE_INTERVAL = 6 * 3600  # check every 6 hours

try:
    import httpx
    import websockets
    import websockets.exceptions
except ImportError:
    print("Missing dependencies. Run: pip install websockets httpx")
    sys.exit(1)

try:
    from telegram import Update
    from telegram.ext import Application, CommandHandler, ContextTypes, MessageHandler, filters as tg_filters
    _TG_AVAILABLE = True
except ImportError:
    _TG_AVAILABLE = False


log = logging.getLogger("monofarm-agent")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")

RECONNECT_DELAY = 5    # seconds between reconnect attempts
REQUEST_TIMEOUT = 10   # seconds per regular proxied request
STREAM_CHUNK    = 32768  # bytes per chunk for streaming

CONFIG_DIR  = Path.home() / ".monofarm-agent"
CONFIG_FILE = CONFIG_DIR / ".env"

# ── Telegram bot state (per-agent, started after receiving token from SaaS) ───

_tg_app: "Application | None" = None
_tg_token: str | None = None
_tg_lock = asyncio.Lock()
_tg_server: str = ""
_tg_jwt: str = ""


async def _tg_cmd_handler(update: "Update", _ctx: "ContextTypes.DEFAULT_TYPE") -> None:
    """Generic handler: forwards the command to SaaS and replies with the result."""
    if not update.message or not update.effective_chat:
        return
    chat_id = update.effective_chat.id
    text    = update.message.text or ""
    # Parse command and args (handles /start abc, /план, /статус)
    parts   = text.split()
    raw_cmd = parts[0].lstrip("/").split("@")[0].lower() if parts else ""
    args    = parts[1:] if len(parts) > 1 else []
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{_tg_server}/api/agent/tg-command",
                json={"command": raw_cmd, "chat_id": chat_id, "args": args},
                headers={"Authorization": f"Bearer {_tg_jwt}"},
            )
            resp.raise_for_status()
            data = resp.json()
            reply = data.get("text") or ""
            parse_mode = data.get("parse_mode")
    except Exception as exc:
        log.warning("tg-command %s failed: %s", raw_cmd, exc)
        reply = "Помилка звʼязку з сервером. Спробуй ще раз."
        parse_mode = None
    if reply:
        await update.message.reply_text(reply, parse_mode=parse_mode)


async def _tg_start(token: str) -> None:
    """Build and start the PTB Application, then report the bot username back to SaaS."""
    global _tg_app, _tg_token
    if not _TG_AVAILABLE:
        log.warning("python-telegram-bot not installed — Telegram bot disabled")
        return
    app = Application.builder().token(token).build()
    app.add_handler(CommandHandler("start", _tg_cmd_handler))
    app.add_handler(MessageHandler(tg_filters.Regex(r"^/план(@\w+)?(\s|$)"), _tg_cmd_handler))
    app.add_handler(MessageHandler(tg_filters.Regex(r"^/статус(@\w+)?(\s|$)"), _tg_cmd_handler))
    await app.initialize()
    me = await app.bot.get_me()
    await app.start()
    if app.updater:
        await app.updater.start_polling(drop_pending_updates=True)
    _tg_app   = app
    _tg_token = token
    log.info("Telegram bot @%s online", me.username)
    # Report username back to SaaS so it can cache it for deep-link generation
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                f"{_tg_server}/api/agent/tg-report-username",
                json={"username": me.username},
                headers={"Authorization": f"Bearer {_tg_jwt}"},
            )
    except Exception as exc:
        log.debug("Failed to report bot username to SaaS: %s", exc)


async def _tg_stop() -> None:
    global _tg_app, _tg_token
    if _tg_app is None:
        return
    app = _tg_app
    _tg_app   = None
    _tg_token = None
    try:
        if app.updater:
            await app.updater.stop()
        await app.stop()
        await app.shutdown()
    except Exception as exc:
        log.debug("Telegram bot stop error: %s", exc)
    log.info("Telegram bot stopped")


async def _tg_reconfigure(new_token: str | None) -> None:
    async with _tg_lock:
        if new_token == _tg_token:
            return
        await _tg_stop()
        if new_token:
            try:
                await _tg_start(new_token)
            except Exception as exc:
                log.error("Failed to start Telegram bot: %s", exc)


def _load_config() -> dict[str, str]:
    cfg = {"MONOFARM_SERVER": "https://api.monofarm.app", "MONOFARM_FRONTEND": "https://monofarm.app", "MONOFARM_TOKEN": ""}
    if CONFIG_FILE.exists():
        for line in CONFIG_FILE.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.startswith("#"):
                k, _, v = line.partition("=")
                cfg[k.strip()] = v.strip()
    return cfg


def _save_config(server: str, token: str) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(
        f"MONOFARM_SERVER={server}\nMONOFARM_TOKEN={token}\n", encoding="utf-8"
    )
    try:
        CONFIG_FILE.chmod(0o600)
    except Exception:
        pass


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


async def handle_discover_moonraker(ws, req: dict) -> None:
    """Scan the local /24 subnet for Moonraker instances (port 7125)."""
    import ipaddress

    req_id = req.get("id")
    results: list[dict] = []

    # Determine local IPs to derive subnets to scan
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
            # Confirm it's Moonraker
            try:
                async with httpx.AsyncClient(timeout=2.0) as client:
                    r = await client.get(f"http://{ip}:7125/printer/info")
                    if r.status_code == 200:
                        data = r.json().get("result", {})
                        return {"url": f"http://{ip}:7125", "name": data.get("hostname") or ip}
            except Exception:
                return {"url": f"http://{ip}:7125", "name": ip}
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
    results = [r for r in probed if r is not None]

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

        def _ftp_upload() -> None:
            ctx = _ssl.SSLContext(_ssl.PROTOCOL_TLS_CLIENT)
            ctx.check_hostname = False
            ctx.verify_mode    = _ssl.CERT_NONE
            ftp = ftplib.FTP_TLS(context=ctx)
            ftp.connect(ip, 990, timeout=15)
            ftp.login(user="bblp", passwd=access_code)
            ftp.prot_p()
            ftp.storbinary(f"STOR {filename}", _io.BytesIO(file_bytes))
            ftp.quit()

        # Run blocking FTP in a thread so asyncio event loop stays alive
        # (handles WS keepalive pings during upload)
        await asyncio.to_thread(_ftp_upload)

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


async def _pair_flow(server: str) -> str:
    """Open browser to monofarm Settings and wait for the user to click 'Connect Agent'.
    The frontend sends the JWT to our localhost callback; we save it and return it.
    """
    import socket as _sock
    import threading as _t
    import urllib.parse as _up
    import webbrowser as _wb
    from http.server import BaseHTTPRequestHandler, HTTPServer

    loop = asyncio.get_running_loop()
    token_fut: asyncio.Future[str] = loop.create_future()

    with _sock.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]

    class _H(BaseHTTPRequestHandler):
        def do_OPTIONS(self) -> None:
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.end_headers()

        def do_GET(self) -> None:
            qs  = _up.parse_qs(_up.urlparse(self.path).query)
            tok = qs.get("token", [""])[0]
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(b"ok")
            if tok and not token_fut.done():
                loop.call_soon_threadsafe(token_fut.set_result, tok)

        def log_message(self, *_) -> None:
            pass

    srv = HTTPServer(("127.0.0.1", port), _H)
    _t.Thread(target=srv.serve_forever, daemon=True).start()

    cfg      = _load_config()
    fe_url   = cfg.get("MONOFARM_FRONTEND") or server.replace(":8000", ":3000")
    pair_url = f"{fe_url}/settings?agent_pair={port}"
    log.info("Opening browser to pair agent: %s", pair_url)
    _wb.open(pair_url)
    log.info("Waiting for approval in browser (120s)…")

    try:
        token = await asyncio.wait_for(token_fut, timeout=120)
    except asyncio.TimeoutError:
        srv.shutdown()
        log.error("Pairing timed out. Run with --token to skip.")
        sys.exit(1)

    srv.shutdown()
    _save_config(server, token)
    log.info("Token saved to %s — future runs need no arguments.", CONFIG_FILE)
    return token


async def run(server: str, token: str) -> None:
    global _tg_server, _tg_jwt
    _tg_server = server
    _tg_jwt    = token

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

                # Fetch TG config on every connect (token may have changed while disconnected)
                try:
                    async with httpx.AsyncClient(timeout=10) as client:
                        r = await client.get(
                            f"{server}/api/agent/tg-config",
                            headers={"Authorization": f"Bearer {token}"},
                        )
                        if r.status_code == 200:
                            tg_cfg = r.json()
                            asyncio.create_task(_tg_reconfigure(tg_cfg.get("token") or None))
                except Exception as exc:
                    log.debug("Could not fetch tg-config: %s", exc)

                async for message in ws:
                    try:
                        req = json.loads(message)
                    except json.JSONDecodeError:
                        log.warning("Received invalid JSON from server")
                        continue

                    msg_type = req.get("type", "")
                    if msg_type == "TG_CONFIG":
                        asyncio.create_task(_tg_reconfigure(req.get("token") or None))
                        continue
                    if msg_type == "TG_SEND":
                        if _tg_app:
                            async def _send(r=req) -> None:
                                try:
                                    await _tg_app.bot.send_message(
                                        chat_id=r["chat_id"],
                                        text=r["text"],
                                        parse_mode=r.get("parse_mode"),
                                    )
                                except Exception as exc:
                                    log.warning("TG_SEND failed: %s", exc)
                            asyncio.create_task(_send())
                        else:
                            log.warning("TG_SEND received but bot not running")
                        continue

                    method = req.get("method", "GET").upper()
                    if method == "BAMBU_CAMERA":
                        asyncio.create_task(handle_bambu_camera(ws, req))
                    elif method == "FFMPEG_STREAM":
                        asyncio.create_task(handle_ffmpeg_stream(ws, req))
                    elif method == "DISCOVER_BAMBU":
                        asyncio.create_task(handle_discover_bambu(ws, req))
                    elif method == "DISCOVER_MOONRAKER":
                        asyncio.create_task(handle_discover_moonraker(ws, req))
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
  python monofarm_agent.py                                    # pair via browser (first run)
  python monofarm_agent.py --server http://192.168.1.10:8000 # custom server, pair via browser
  python monofarm_agent.py --token eyJ...                    # skip pairing, use token directly

On first run without --token the browser opens to monofarm Settings automatically.
Token is saved to ~/.monofarm-agent/.env — subsequent runs need no arguments.
        """,
    )
    parser.add_argument("--server", default=None,
                        help="monofarm server URL (default: from saved config or https://api.monofarm.app)")
    parser.add_argument("--token", default=None,
                        help="JWT token — omit to use saved config or pair via browser")
    args = parser.parse_args()

    cfg    = _load_config()
    server = args.server or cfg["MONOFARM_SERVER"]
    token  = args.token  or cfg["MONOFARM_TOKEN"]

    async def _run() -> None:
        nonlocal token
        if not token:
            token = await _pair_flow(server)
        await run(server, token)

    async def _run_with_cleanup() -> None:
        try:
            await _run()
        finally:
            await _tg_stop()

    try:
        asyncio.run(_run_with_cleanup())
    except KeyboardInterrupt:
        log.info("Agent stopped.")


if __name__ == "__main__":
    main()
