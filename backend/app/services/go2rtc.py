"""go2rtc sidecar helpers.

go2rtc runs on the same machine as the agent (farm PC / Pi) and handles
Bambu Lab cameras using its native Bambu protocol support:

  X1/H2D  → rtsps://bblp:CODE@IP:322/streaming/live/1  (RTSPS, needs LAN Liveview)
  A1/P1   → bambu://CODE@IP?channel=1                  (proprietary TLS+JPEG, port 6000)

Architecture:
  Browser ← FastAPI ← agent tunnel ← go2rtc (farm PC) ← Bambu printer
"""
import logging

import httpx

from app.core.config import settings

log = logging.getLogger(__name__)


def is_available() -> bool:
    return bool(settings.GO2RTC_URL)


def stream_name(dev_id: str) -> str:
    return f"bambu_{dev_id}"


def _stream_url(access_code: str, ip: str, model: str = "") -> str:
    """Return the correct go2rtc stream URL based on printer model.

    X1/H2D → rtsps on port 322 (requires LAN Liveview)
    A1/P1  → bambu:// native protocol on port 6000 (no LAN mode needed)
    """
    model_lower = (model or "").lower()
    if any(x in model_lower for x in ("x1", "h2d")):
        return f"rtsps://bblp:{access_code}@{ip}:322/streaming/live/1"
    # A1, P1 and everything else → go2rtc native Bambu protocol
    return f"bambu://{access_code}@{ip}?channel=1"


async def register_stream(dev_id: str, access_code: str, ip: str, model: str = "") -> bool:
    """Register (or update) a Bambu stream in go2rtc. Returns True on success."""
    if not is_available():
        return False
    url = _stream_url(access_code, ip, model)
    name = stream_name(dev_id)
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.put(
                f"{settings.GO2RTC_URL}/api/streams",
                params={"src": url, "name": name},
            )
            return r.status_code < 300
    except Exception as exc:
        log.warning("go2rtc register_stream failed: %s", exc)
        return False


def mjpeg_url(dev_id: str) -> str:
    return f"{settings.GO2RTC_URL}/api/stream.mjpeg?src={stream_name(dev_id)}"


async def stream_exists(dev_id: str) -> bool:
    """Check if go2rtc already has this stream registered."""
    if not is_available():
        return False
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            r = await client.get(f"{settings.GO2RTC_URL}/api/streams")
            if r.status_code == 200:
                return stream_name(dev_id) in r.json()
    except Exception:
        pass
    return False
