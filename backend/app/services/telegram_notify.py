"""Telegram notification helpers for printer alerts.

These helpers send direct bot API messages for event-driven alerts.
Command handling still runs through the local farm agent.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import socket
import ssl
import struct

import requests
from sqlalchemy.orm import Session

from app.models.printer import Printer, PrinterKind
from app.models.organization import Organization
from app.models.user import User
from app.services.encryption import decrypt

log = logging.getLogger(__name__)


def _linked_chat_ids(db: Session, org_id: int) -> list[int]:
    rows = (
        db.query(User.telegram_chat_id)
        .filter(
            User.organization_id == org_id,
            User.is_active.is_(True),
            User.telegram_chat_id.isnot(None),
        )
        .all()
    )
    return [int(row[0]) for row in rows if row and row[0] is not None]


def send_org_notification(db: Session, org_id: int, text: str) -> int:
    """Send a plain-text Telegram message to every linked active user in org."""
    org = db.get(Organization, org_id)
    if not org or not org.tg_bot_token:
        return 0

    try:
        token = decrypt(org.tg_bot_token)
    except Exception as exc:
        log.warning("Telegram alert skipped for org %s: token decrypt failed: %s", org_id, exc)
        return 0

    chat_ids = _linked_chat_ids(db, org_id)
    if not chat_ids:
        log.info("Telegram alert skipped for org %s: no linked users", org_id)
        return 0

    sent = 0
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload_base = {"text": text, "disable_web_page_preview": True}
    for chat_id in chat_ids:
        payload = {**payload_base, "chat_id": chat_id}
        try:
            resp = requests.post(url, json=payload, timeout=10)
            resp.raise_for_status()
            sent += 1
        except Exception as exc:
            log.warning("Telegram alert failed org=%s chat=%s: %s", org_id, chat_id, exc)
    return sent


def _telegram_send_photo(token: str, chat_id: int, photo: bytes, caption: str) -> bool:
    url = f"https://api.telegram.org/bot{token}/sendPhoto"
    files = {"photo": ("printer.jpg", photo, "image/jpeg")}
    data = {"chat_id": chat_id, "caption": caption}
    try:
        resp = requests.post(url, data=data, files=files, timeout=15)
        resp.raise_for_status()
        return True
    except Exception as exc:
        log.warning("Telegram photo alert failed chat=%s: %s", chat_id, exc)
        return False


def _read_exact(sock: socket.socket, size: int, timeout: float) -> bytes:
    sock.settimeout(timeout)
    buf = bytearray()
    while len(buf) < size:
        chunk = sock.recv(size - len(buf))
        if not chunk:
            raise ConnectionError("stream closed")
        buf.extend(chunk)
    return bytes(buf)


def _extract_jpeg_from_mjpeg_chunk(chunk: bytes) -> bytes | None:
    start = chunk.find(b"\xff\xd8")
    end = chunk.find(b"\xff\xd9", start + 2)
    if start == -1 or end == -1:
        return None
    return chunk[start : end + 2]


def _bambu_snapshot_bytes(dev_ip: str, access_code: str, timeout: float = 12.0) -> bytes | None:
    auth = bytearray(80)
    struct.pack_into("<I", auth, 0, 0x40)
    struct.pack_into("<I", auth, 4, 0x3000)
    auth[16:20] = b"bblp"
    pw = access_code.encode()
    auth[48:48 + len(pw)] = pw

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    try:
        with socket.create_connection((dev_ip, 6000), timeout=timeout) as sock:
            with ctx.wrap_socket(sock, server_hostname=dev_ip) as tls:
                tls.sendall(bytes(auth))
                header = _read_exact(tls, 16, timeout)
                size = struct.unpack("<I", header[0:4])[0]
                if size <= 0 or size > 10_000_000:
                    return None
                return _read_exact(tls, size, timeout)
    except Exception as exc:
        log.debug("Bambu snapshot failed %s: %s", dev_ip, exc)
        return None


def _moonraker_snapshot_bytes(moonraker_url: str, timeout: float = 8.0) -> bytes | None:
    from app.services import moonraker

    candidates: list[str] = []
    try:
        webcams = moonraker.get_webcams(moonraker_url)
    except Exception:
        webcams = []
    if webcams:
        base = moonraker._api_base(moonraker_url)  # noqa: SLF001
        for cam in webcams:
            snap = (cam.get("snapshot_url") or "").strip()
            if not snap:
                continue
            if snap.startswith("http"):
                candidates.append(snap)
            else:
                candidates.append(f"{base}{snap if snap.startswith('/') else '/' + snap}")
    candidates.extend([
        f"{moonraker._api_base(moonraker_url)}/webcam/?action=snapshot",  # noqa: SLF001
    ])

    for url in candidates:
        try:
            resp = requests.get(url, timeout=timeout)
            resp.raise_for_status()
            ctype = (resp.headers.get("content-type") or "").lower()
            if ctype.startswith("image/") and resp.content:
                return resp.content
        except Exception:
            continue
    return None


def _printer_snapshot(db: Session, org_id: int, printer_id: int) -> bytes | None:
    from app.services import tunnel as _tunnel

    printer = db.get(Printer, printer_id)
    if not printer or printer.organization_id != org_id:
        return None

    async def _from_tunnel() -> bytes | None:
        from app.services import moonraker

        if printer.kind == PrinterKind.bambu and printer.bambu_dev_ip and printer.bambu_access_code:
            if _tunnel.has_tunnel(org_id):
                try:
                    async for chunk in _tunnel.bambu_camera_stream(
                        org_id,
                        printer.bambu_dev_ip,
                        printer.bambu_access_code,
                        chunk_timeout=8.0,
                    ):
                        jpeg = _extract_jpeg_from_mjpeg_chunk(chunk)
                        if jpeg:
                            return jpeg
                except Exception as exc:
                    log.debug("Bambu tunnel snapshot failed printer=%s: %s", printer_id, exc)
            return None

        if printer.moonraker_url and _tunnel.has_tunnel(org_id):
            try:
                base = moonraker._api_base(printer.moonraker_url)  # noqa: SLF001
                webcams = []
                try:
                    resp = await _tunnel.proxy_request(org_id, "GET", f"{base}/server/webcams/list", timeout=8.0)
                    webcams = resp.get("body", {}).get("result", {}).get("webcams", [])
                except Exception:
                    webcams = []
                snapshot_url = ""
                if webcams:
                    snapshot_url = webcams[0].get("snapshot_url", "") or ""
                    if snapshot_url and not snapshot_url.startswith("http"):
                        snapshot_url = f"{base}{snapshot_url if snapshot_url.startswith('/') else '/' + snapshot_url}"
                if not snapshot_url:
                    snapshot_url = f"{base}/webcam/?action=snapshot"
                result = await _tunnel.proxy_request(org_id, "GET", snapshot_url, timeout=8.0)
                if result.get("binary"):
                    return base64.b64decode(result["binary"])
            except Exception as exc:
                log.debug("Moonraker tunnel snapshot failed printer=%s: %s", printer_id, exc)
        return None

    try:
        if _tunnel.has_tunnel(org_id):
            snap = asyncio.run(_from_tunnel())
            if snap:
                return snap
    except RuntimeError:
        log.debug("Snapshot capture skipped: running event loop")

    if printer.kind == PrinterKind.bambu:
        if printer.bambu_dev_ip and printer.bambu_access_code:
            try:
                return _bambu_snapshot_bytes(printer.bambu_dev_ip, printer.bambu_access_code)
            except Exception:
                return None
        return None

    if printer.moonraker_url:
        try:
            return _moonraker_snapshot_bytes(printer.moonraker_url)
        except Exception:
            return None

    return None


def send_print_event_notification(
    db: Session,
    org_id: int,
    *,
    event: str,
    printer_name: str,
    printer_id: int | None = None,
    file_name: str | None = None,
    reason: str | None = None,
    dedupe_key: str | None = None,
) -> int:
    """Send a printer lifecycle notification, suppressing duplicate deliveries."""
    from app.services.cache import cache_get, cache_set
    from datetime import datetime, timezone
    from app.core.config import settings

    key = f"tg:print-event:{org_id}:{dedupe_key or event}:{printer_name}:{file_name or '-'}"
    if cache_get(key):
        return 0

    if event == "started":
        title = "▶ Print started"
    elif event == "paused":
        title = "⏸ Print paused"
    elif event == "completed":
        title = "✅ Print completed"
    elif event == "failed":
        title = "🛑 Print failed"
    elif event == "cancelled":
        title = "⏹ Print cancelled"
    else:
        title = "🖨️ Print update"

    lines = [title, f"Printer: {printer_name}"]
    if file_name:
        lines.append(f"File: {file_name}")
    if reason:
        lines.append(f"Reason: {reason}")
    if settings.FARM_PUBLIC_URL:
        lines.append(f"{settings.FARM_PUBLIC_URL}/printers")

    text = "\n".join(lines)
    photo = _printer_snapshot(db, org_id, printer_id) if (printer_id is not None and event == "failed") else None

    if photo:
        org = db.get(Organization, org_id)
        if org and org.tg_bot_token:
            try:
                token = decrypt(org.tg_bot_token)
            except Exception as exc:
                log.warning("Telegram alert skipped for org %s: token decrypt failed: %s", org_id, exc)
                token = ""
            chat_ids = _linked_chat_ids(db, org_id)
            sent = 0
            if token and chat_ids:
                for chat_id in chat_ids:
                    if _telegram_send_photo(token, chat_id, photo, text):
                        sent += 1
            elif chat_ids:
                sent = send_org_notification(db, org_id, text)
        else:
            sent = 0
    else:
        sent = send_org_notification(db, org_id, text)

    if sent:
        cache_set(key, {"sent_at": datetime.now(timezone.utc).isoformat()}, 300)
    return sent
