"""Moonraker subscriptions, snapshots, and upload handling."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import urllib.parse as _urlparse_mod

import httpx
import websockets
import websockets.exceptions

from core.state import runtime_state
from transports.telegram import alert_should_fire as _alert_should_fire
from transports.telegram import classify_moonraker as _classify_moonraker
from transports.telegram import dispatch_alert as _dispatch_alert

log = logging.getLogger("monofarm-agent")
MOONRAKER_UPLOAD_HEARTBEAT_INTERVAL = 5.0
_moonraker_upload_buffers = runtime_state.upload_buffers
_moonraker_sub_tasks: dict[str, "asyncio.Task[None]"] = {}
_moonraker_names: dict[str, str] = {}
_MOONRAKER_OBJECTS = {
    "print_stats": None,
    "display_status": None,
    "virtual_sdcard": None,
    "extruder": None,
    "heater_bed": None,
    "print_task_config": None,
}


async def _moonraker_grab_snapshot(moonraker_url: str, timeout: float = 8.0) -> bytes | None:
    """Grab a still JPEG from a Moonraker printer's webcam (best-effort)."""
    parsed = _urlparse_mod.urlparse(moonraker_url)
    host = parsed.hostname or "localhost"
    base = f"{parsed.scheme or 'http'}://{host}:{parsed.port or 7125}"

    candidates: list[str] = []
    try:
        async with httpx.AsyncClient(timeout=timeout, verify=False) as client:  # noqa: S501
            r = await client.get(f"{base}/server/webcams/list")
            if r.status_code == 200:
                for cam in ((r.json().get("result") or {}).get("webcams") or []):
                    snap = (cam.get("snapshot_url") or "").strip()
                    if not snap:
                        continue
                    if snap.startswith("http"):
                        candidates.append(snap)
                    else:
                        candidates.append(f"http://{host}{snap if snap.startswith('/') else '/' + snap}")
    except Exception:
        pass
    candidates += [f"http://{host}/webcam/?action=snapshot", f"http://{host}:8080/?action=snapshot"]

    async with httpx.AsyncClient(timeout=timeout, verify=False) as client:  # noqa: S501
        for url in candidates:
            try:
                r = await client.get(url)
            except Exception:
                continue
            if r.status_code == 200 and r.content and r.headers.get("content-type", "").startswith("image"):
                return r.content
    return None

async def _u1_camera_keepalive(mr_ws, moonraker_url: str) -> None:
    """Keep the stock U1 camera monitor updating its JPEG file.

    Stock U1 firmware stops refreshing /server/files/camera/monitor.jpg when
    nothing has recently asked it to start the LAN camera monitor. Reusing the
    already-open Moonraker websocket avoids another connection per printer.
    """
    payload = json.dumps({
        "jsonrpc": "2.0",
        "method": "camera.start_monitor",
        "params": {"domain": "lan", "interval": 0},
        # Stock U1 Moonraker converts req_id to int before dispatching camera
        # commands; a string id is rejected with HTTP/WebSocket error 400.
        "id": 9001,
    })
    while True:
        try:
            await mr_ws.send(payload)
        except Exception:
            return
        await asyncio.sleep(10)

async def _moonraker_ws_loop(cloud_ws, moonraker_url: str, printer_kind: str | None = None) -> None:
    """Maintain a persistent Moonraker WS subscription and push STATUS_PUSH to cloud.

    Moonraker sends the full state in the subscribe response, then incremental
    diffs via notify_status_update. We merge diffs into a full-state dict and
    always forward the complete snapshot so the backend can parse it directly.
    """
    import urllib.parse as _urlparse

    parsed = _urlparse.urlparse(moonraker_url)
    host = parsed.hostname or "localhost"
    port = parsed.port or 7125
    ws_url = f"ws://{host}:{port}/websocket"

    subscribe_msg = json.dumps({
        "jsonrpc": "2.0",
        "method": "printer.objects.subscribe",
        "params": {"objects": _MOONRAKER_OBJECTS},
        "id": 1,
    })

    while True:
        full_state: dict = {}
        try:
            async with websockets.connect(
                ws_url, ping_interval=20, ping_timeout=10, open_timeout=10
            ) as mr_ws:
                log.info("MOONRAKER_SUBSCRIBE: connected %s", ws_url)
                camera_task = (
                    asyncio.create_task(_u1_camera_keepalive(mr_ws, moonraker_url))
                    if printer_kind == "snapmaker_u1" else None
                )
                await mr_ws.send(subscribe_msg)
                try:
                    async for message in mr_ws:
                        try:
                            data = json.loads(message)
                        except Exception:
                            continue

                        # Subscribe result — Moonraker returns full current state
                        if data.get("id") == 1 and "result" in data:
                            full_state = (data["result"] or {}).get("status") or {}

                        # Incremental diff — merge into accumulated full state
                        elif data.get("method") == "notify_status_update":
                            params = data.get("params", [])
                            if params and isinstance(params[0], dict):
                                for key, val in params[0].items():
                                    existing = full_state.get(key)
                                    if isinstance(existing, dict) and isinstance(val, dict):
                                        full_state[key] = {**existing, **val}
                                    else:
                                        full_state[key] = val
                        else:
                            continue

                        if not full_state:
                            continue
                        try:
                            await cloud_ws.send(json.dumps({
                                "type": "STATUS_PUSH",
                                "url": moonraker_url,
                                "status": full_state,
                            }))
                        except Exception as e:
                            log.debug("STATUS_PUSH send failed, stopping loop: %s", e)
                            return  # cloud WS gone — task will be cancelled on reconnect

                        # Local failure/stop detection (off the forwarding path).
                        _state, _etext, _ecode = _classify_moonraker(full_state.get("print_stats") or {})
                        if _alert_should_fire(f"mr:{moonraker_url}", _state, _ecode):
                            asyncio.create_task(_dispatch_alert(
                                _moonraker_names.get(moonraker_url) or host or moonraker_url,
                                _state, _etext, _ecode, "moonraker",
                                {"moonraker_url": moonraker_url},
                            ))
                finally:
                    if camera_task:
                        camera_task.cancel()
                        await asyncio.gather(camera_task, return_exceptions=True)

        except asyncio.CancelledError:
            log.debug("MOONRAKER_SUBSCRIBE: task cancelled for %s", moonraker_url)
            return
        except (OSError, websockets.exceptions.WebSocketException) as e:
            log.debug("MOONRAKER_SUBSCRIBE: %s disconnected (%s) — retrying in 5s", moonraker_url, e)
        except Exception as e:
            log.warning("MOONRAKER_SUBSCRIBE: unexpected error for %s: %s — retrying", moonraker_url, e)

        await asyncio.sleep(5)

async def handle_moonraker_subscribe(cloud_ws, req: dict) -> None:
    """Start (or restart) a Moonraker WS subscription for the given printer URL."""
    req_id = req.get("id")
    url = req.get("url", "").rstrip("/")
    if not url:
        await cloud_ws.send(json.dumps({
            "id": req_id, "status": 400, "body": None, "error": "missing url",
        }))
        return

    name = (req.get("name") or "").strip()
    if name:
        _moonraker_names[url] = name

    existing = _moonraker_sub_tasks.pop(url, None)
    if existing and not existing.done():
        existing.cancel()

    task = asyncio.create_task(_moonraker_ws_loop(cloud_ws, url, req.get("kind")))
    _moonraker_sub_tasks[url] = task

    await cloud_ws.send(json.dumps({
        "id": req_id, "status": 200, "body": {"ok": True}, "error": None,
    }))

def _cancel_all_subscriptions() -> None:
    for task in list(_moonraker_sub_tasks.values()):
        task.cancel()
    _moonraker_sub_tasks.clear()

def apply_moonraker_print_options(file_bytes: bytes, options: dict) -> bytes:
    """Apply U1 print options after the Agent downloads the file directly."""
    import re

    content = file_bytes.decode("utf-8", errors="ignore")
    out = content
    if options.get("auto_bed_leveling") is False:
        out = re.sub(
            r"^(BED_MESH_CALIBRATE\b.*)$",
            r"; SKIPPED \1",
            out,
            flags=re.MULTILINE,
        )
    if options.get("timelapse") is False:
        out = re.sub(
            r"^(TIMELAPSE_(?:START|TAKE_FRAME)\b.*)$",
            r"; SKIPPED \1",
            out,
            flags=re.MULTILINE,
        )
    if options.get("ai_detection") is False:
        out = re.sub(
            r"^((?:DEFECT_DETECTION_(?:START|DETECT(?:_BED)?)|DETECT_BED_PLATE)\b.*)$",
            r"; SKIPPED \1",
            out,
            flags=re.MULTILINE,
        )

    raw_used_slots = options.get("used_slots")
    used_slots = (
        {int(slot) for slot in raw_used_slots}
        if raw_used_slots is not None
        else None
    )
    raw_calibrate_slots = options.get("calibrate_slots")
    calibrate_slots = (
        {int(slot) for slot in raw_calibrate_slots}
        if raw_calibrate_slots is not None
        else None
    )
    if used_slots is not None:
        out = re.sub(
            r"^SM_PRINT_(?:EXTRUDER_PREHEAT|AUTO_FEED)\s+EXTRUDER=(\d+).*$",
            lambda match: (
                match.group(0)
                if int(match.group(1)) in used_slots
                else "; SKIPPED " + match.group(0)
            ),
            out,
            flags=re.MULTILINE,
        )

    effective_slots: set[int] | None = None
    if calibrate_slots is not None and used_slots is not None:
        effective_slots = calibrate_slots & used_slots
    elif calibrate_slots is not None:
        effective_slots = calibrate_slots
    elif used_slots is not None:
        effective_slots = used_slots
    if effective_slots is not None:
        out = re.sub(
            r"^SM_PRINT_FLOW_CALIBRATE\s+EXTRUDER=(\d+).*$",
            lambda match: (
                match.group(0)
                if int(match.group(1)) in effective_slots
                else "; SKIPPED " + match.group(0)
            ),
            out,
            flags=re.MULTILINE,
        )
    return file_bytes if out == content else out.encode("utf-8")

async def handle_moonraker_upload(ws, req: dict) -> None:
    """Upload a gcode/3mf file to Moonraker via multipart POST.

    Cloud backend sends bytes as base64; agent does the actual LAN upload.
    """
    import time

    req_id      = req.get("id")
    url         = req.get("url", "")         # bare Moonraker base URL
    filename    = req.get("filename", "file.gcode")
    data_b64    = req.get("data_b64", "")
    data_bytes  = req.get("_data_bytes")
    download_url = req.get("download_url", "")
    start_print = req.get("start_print", False)
    upload_timeout = max(300.0, min(3600.0, float(req.get("upload_timeout", 300.0))))

    try:
        if isinstance(data_bytes, bytes):
            file_bytes = data_bytes
        elif download_url:
            # Cloud sent a presigned URL — pull the file directly (much faster
            # than base64 chunks through the tunnel). Heartbeat progress keeps
            # the cloud stall-guard alive during a slow download.
            parts: list[bytes] = []
            last_beat = time.monotonic()
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(upload_timeout, connect=30.0)
            ) as dl:
                async with dl.stream("GET", download_url) as resp_dl:
                    resp_dl.raise_for_status()
                    total_dl = int(resp_dl.headers.get("content-length") or 0)
                    async for part in resp_dl.aiter_bytes(1024 * 1024):
                        parts.append(part)
                        now = time.monotonic()
                        if now - last_beat >= 2.0:
                            await ws.send(json.dumps({
                                "id": req_id,
                                "type": "upload_progress",
                                "sent": 0,
                                "total": total_dl,
                            }))
                            last_beat = now
            file_bytes = b"".join(parts)
        else:
            file_bytes = base64.b64decode(data_b64)
        print_options = req.get("print_options")
        if isinstance(print_options, dict):
            file_bytes = apply_moonraker_print_options(file_bytes, print_options)
        boundary = "----monofarm-upload-" + hashlib.sha256(req_id.encode()).hexdigest()[:16]
        prefix = (
            f"--{boundary}\r\n"
            "Content-Disposition: form-data; name=\"root\"\r\n\r\n"
            "gcodes\r\n"
            f"--{boundary}\r\n"
            "Content-Disposition: form-data; name=\"print\"\r\n\r\n"
            f"{'true' if start_print else 'false'}\r\n"
            f"--{boundary}\r\n"
            f"Content-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n"
            "Content-Type: application/octet-stream\r\n\r\n"
        ).encode()
        suffix = f"\r\n--{boundary}--\r\n".encode()
        total = len(prefix) + len(file_bytes) + len(suffix)
        chunk_size = 256 * 1024
        upload_sent = 0

        async def upload_heartbeat() -> None:
            while True:
                await asyncio.sleep(MOONRAKER_UPLOAD_HEARTBEAT_INTERVAL)
                await ws.send(json.dumps({
                    "id": req_id,
                    "type": "upload_progress",
                    "sent": upload_sent,
                    "total": len(file_bytes),
                    "heartbeat": True,
                }))

        async def multipart_body():
            nonlocal upload_sent
            yield prefix
            sent = 0
            last_report = -1
            # Report on time as well as percent: the cloud stall-guard needs a
            # heartbeat even when 5% of a big file takes minutes on slow WiFi.
            last_report_at = time.monotonic()
            for offset in range(0, len(file_bytes), chunk_size):
                chunk = file_bytes[offset:offset + chunk_size]
                sent += len(chunk)
                upload_sent = sent
                progress = round(sent * 100 / max(len(file_bytes), 1))
                now = time.monotonic()
                if progress == 100 or progress - last_report >= 5 or now - last_report_at >= 2.0:
                    await ws.send(json.dumps({
                        "id": req_id,
                        "type": "upload_progress",
                        "sent": sent,
                        "total": len(file_bytes),
                    }))
                    last_report = progress
                    last_report_at = now
                yield chunk
            yield suffix

        heartbeat_task = asyncio.create_task(upload_heartbeat())
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(upload_timeout, connect=30.0, pool=30.0),
                verify=False,
            ) as client:  # noqa: S501
                resp = await client.post(
                    f"{url}/server/files/upload",
                    content=multipart_body(),
                    headers={
                        "Content-Type": f"multipart/form-data; boundary={boundary}",
                        "Content-Length": str(total),
                    },
                )
        finally:
            heartbeat_task.cancel()
            try:
                await heartbeat_task
            except asyncio.CancelledError:
                pass
        result = {
            "id": req_id,
            "status": resp.status_code,
            "body": resp.json() if resp.content else {},
            "error": None if resp.status_code < 400 else resp.text,
        }
    except Exception as e:
        log.warning("MOONRAKER_UPLOAD error %s: %s", url, e)
        result = {"id": req_id, "status": 502, "body": None, "error": str(e)}

    try:
        await ws.send(json.dumps(result))
    except websockets.exceptions.ConnectionClosed as exc:
        log.warning("MOONRAKER_UPLOAD response dropped after cloud disconnect: %s", exc)

async def handle_moonraker_upload_chunk(ws, req: dict) -> None:
    """Collect a chunked cloud upload and start the LAN upload on the final chunk."""
    req_id = req.get("id")
    if not req_id:
        return
    state = _moonraker_upload_buffers.get(req_id)
    if state is None:
        await ws.send(json.dumps({"id": req_id, "status": 400, "error": "upload metadata missing"}))
        return

    try:
        offset = int(req.get("offset", -1))
        data = base64.b64decode(req.get("data_b64", ""))
        expected = int(state["next_offset"])
        if offset != expected:
            raise ValueError(f"unexpected upload chunk offset {offset}, expected {expected}")
        state["data"].extend(data)
        state["next_offset"] = expected + len(data)
        if not req.get("final"):
            return
        if state["next_offset"] != int(state["total_bytes"]):
            raise ValueError("incomplete upload")
        upload_req = dict(state["meta"])
        upload_req["_data_bytes"] = bytes(state["data"])
        _moonraker_upload_buffers.pop(req_id, None)
        asyncio.create_task(handle_moonraker_upload(ws, upload_req))
    except Exception as e:
        _moonraker_upload_buffers.pop(req_id, None)
        log.warning("MOONRAKER_UPLOAD chunk error: %s", e)
        await ws.send(json.dumps({"id": req_id, "status": 400, "error": str(e)}))
