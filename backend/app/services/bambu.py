"""Bambu Lab Cloud API + MQTT + LAN FTPS client.

Cloud HTTP (sync `requests`): login, token refresh, list_devices.
MQTT singleton (paho-mqtt, background thread): live status + print commands.
FTPS (ftplib.FTP_TLS): upload .3mf to printer over LAN.

Call sync helpers from async FastAPI via `asyncio.to_thread`.
"""
from __future__ import annotations

import ftplib
import json
import logging
import ssl
import threading
import time
from pathlib import Path
from typing import Any

import requests

from app.core.config import settings

log = logging.getLogger(__name__)

CLOUD_TIMEOUT = 15
FTPS_TIMEOUT = 30
MQTT_KEEPALIVE = 60
STATUS_CACHE_TTL = 30.0  # keep last MQTT report for up to 30s

_REGION_HOSTS: dict[str, dict[str, str]] = {
    "us": {"api": "https://api.bambulab.com", "mqtt": "us.mqtt.bambulab.com"},
    "eu": {"api": "https://api.bambulab.com", "mqtt": "us.mqtt.bambulab.com"},
    "cn": {"api": "https://api.bambulab.cn", "mqtt": "cn.mqtt.bambulab.com"},
}

_GCODE_STATE_MAP: dict[str, str] = {
    "IDLE": "idle",
    "RUNNING": "printing",
    "PREPARE": "printing",
    "PAUSE": "paused",
    "FINISH": "operational",
    "FAILED": "error",
    "SLICING": "printing",
}


class BambuError(Exception):
    """Raised when a Bambu API/MQTT/FTP operation fails."""


# ── Module-level state ────────────────────────────────────────────────────────

_access_token: str = ""
_user_id: str = ""
_region: str = ""
_mqtt_client: Any = None  # paho.mqtt.client.Client
_mqtt_lock = threading.Lock()
_seq_counter = 0
_seq_lock = threading.Lock()

# dev_id → {ts: float, data: dict}  — latest MQTT report per printer
_state_cache: dict[str, dict[str, Any]] = {}
# dev_id → list[dict]  — AMS tray data extracted from MQTT reports
_ams_cache: dict[str, list[dict]] = {}


def _next_seq() -> str:
    global _seq_counter
    with _seq_lock:
        _seq_counter += 1
        return str(_seq_counter)


def _is_configured() -> bool:
    return bool(
        (settings.BAMBU_EMAIL and settings.BAMBU_PASSWORD)
        or settings.BAMBU_REFRESH_TOKEN
    )


def _api_base() -> str:
    r = _region or settings.BAMBU_REGION or "us"
    return _REGION_HOSTS.get(r, _REGION_HOSTS["us"])["api"]


def _mqtt_host() -> str:
    r = _region or settings.BAMBU_REGION or "us"
    return _REGION_HOSTS.get(r, _REGION_HOSTS["us"])["mqtt"]


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {_access_token}",
        "Content-Type": "application/json",
    }


# ── Cloud HTTP (sync) ────────────────────────────────────────────────────────


def login() -> str:
    """Authenticate with Bambu Cloud.  Returns access_token.

    Tries refresh_token first (no 2FA needed), then email+password.
    """
    global _access_token, _user_id, _region

    if settings.BAMBU_REFRESH_TOKEN:
        return refresh_token(settings.BAMBU_REFRESH_TOKEN)

    if not (settings.BAMBU_EMAIL and settings.BAMBU_PASSWORD):
        raise BambuError("BAMBU_EMAIL+BAMBU_PASSWORD або BAMBU_REFRESH_TOKEN не задано")

    base = _api_base()
    try:
        resp = requests.post(
            f"{base}/v1/user-service/user/login",
            json={
                "account": settings.BAMBU_EMAIL,
                "password": settings.BAMBU_PASSWORD,
                "apiError": "",
            },
            timeout=CLOUD_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException as e:
        raise BambuError(f"Bambu login failed: {e}") from e

    if not data.get("success") and data.get("loginType") == "verifyCode":
        raise BambuError(
            "Bambu потребує код верифікації (2FA). "
            "Вимкніть 2FA для фермового акаунта, або використайте BAMBU_REFRESH_TOKEN "
            "з конфігу Bambu Studio (~/.config/BambuStudio/cloud_user_info.json)."
        )
    if not data.get("accessToken"):
        raise BambuError(f"Bambu login failed: {data}")

    _access_token = data["accessToken"]
    _extract_user_id(_access_token)
    log.info("Bambu Cloud: logged in as user_id=%s", _user_id)
    return _access_token


def refresh_token(token: str) -> str:
    """Use a refresh_token to get a fresh access_token."""
    global _access_token, _user_id, _region

    base = _api_base()
    try:
        resp = requests.post(
            f"{base}/v1/user-service/user/refreshtoken",
            json={"refreshToken": token},
            timeout=CLOUD_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException as e:
        raise BambuError(f"Bambu token refresh failed: {e}") from e

    access = data.get("accessToken") or data.get("token")
    if not access:
        raise BambuError(f"Bambu token refresh: no token in response: {data}")

    _access_token = access
    _extract_user_id(_access_token)
    log.info("Bambu Cloud: token refreshed, user_id=%s", _user_id)
    return _access_token


def _extract_user_id(token: str) -> None:
    """Decode user_id from JWT payload (no verification — just parsing)."""
    global _user_id
    import base64

    try:
        payload_b64 = token.split(".")[1]
        padding = 4 - len(payload_b64) % 4
        if padding != 4:
            payload_b64 += "=" * padding
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
        _user_id = str(payload.get("user_id") or payload.get("uid") or payload.get("sub") or "")
    except Exception:
        log.warning("Could not extract user_id from Bambu JWT")
        _user_id = ""


def list_devices() -> list[dict]:
    """Get all printers bound to the Bambu Cloud account.

    Returns list of dicts with keys: dev_id, name, online, dev_model_name,
    dev_product_name, dev_access_code.
    """
    if not _access_token:
        return []
    base = _api_base()
    try:
        resp = requests.get(
            f"{base}/v1/iot-service/api/user/bind",
            headers=_headers(),
            timeout=CLOUD_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException as e:
        log.warning("Bambu list_devices failed: %s", e)
        return []

    devices = data.get("devices") or []
    return [
        {
            "dev_id": d.get("dev_id", ""),
            "name": d.get("name", ""),
            "online": bool(d.get("online")),
            "dev_model_name": d.get("dev_model_name", ""),
            "dev_product_name": d.get("dev_product_name", ""),
            "dev_access_code": d.get("dev_access_code", ""),
        }
        for d in devices
        if d.get("dev_id")
    ]


def do_token_refresh() -> None:
    """Periodic refresh called by APScheduler.  Silently ignores failures."""
    if not _is_configured():
        return
    try:
        if settings.BAMBU_REFRESH_TOKEN:
            refresh_token(settings.BAMBU_REFRESH_TOKEN)
        else:
            login()
    except BambuError:
        log.exception("Bambu periodic token refresh failed")


# ── MQTT ──────────────────────────────────────────────────────────────────────


def _on_connect(client: Any, userdata: Any, flags: Any, rc: int, properties: Any = None) -> None:
    if rc != 0:
        log.warning("Bambu MQTT connect failed: rc=%s", rc)
        return
    log.info("Bambu MQTT connected")
    # Subscribe to reports for all known devices
    for dev_id in list(_state_cache.keys()):
        topic = f"device/{dev_id}/report"
        client.subscribe(topic)
        log.debug("Bambu MQTT subscribed: %s", topic)


def _on_message(client: Any, userdata: Any, msg: Any) -> None:
    try:
        payload = json.loads(msg.payload)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return

    parts = msg.topic.split("/")
    if len(parts) < 2:
        return
    dev_id = parts[1]

    print_data = payload.get("print", {})
    if not print_data:
        return

    raw_state = print_data.get("gcode_state", "")
    state = _GCODE_STATE_MAP.get(raw_state, raw_state.lower() or "unknown")

    progress_pct = print_data.get("mc_percent")
    remaining_min = print_data.get("mc_remaining_time")
    if isinstance(remaining_min, (int, float)) and remaining_min > 0:
        eta_minutes = int(remaining_min)
    else:
        eta_minutes = None

    _state_cache[dev_id] = {
        "ts": time.monotonic(),
        "state": state,
        "raw_state": raw_state,
        "progress_pct": int(progress_pct) if progress_pct is not None else None,
        "eta_minutes": eta_minutes,
        "filename": print_data.get("subtask_name") or print_data.get("gcode_file") or None,
        "nozzle_temp": print_data.get("nozzle_temper"),
        "nozzle_target": print_data.get("nozzle_target_temper"),
        "bed_temp": print_data.get("bed_temper"),
        "bed_target": print_data.get("bed_target_temper"),
        "layer_num": print_data.get("layer_num"),
        "total_layers": print_data.get("total_layer_num"),
    }

    # Parse AMS tray data
    ams_data = print_data.get("ams")
    if isinstance(ams_data, dict):
        _parse_ams(dev_id, ams_data, print_data.get("vt_tray"))


def _parse_ams(dev_id: str, ams_data: dict, vt_tray: dict | None) -> None:
    """Extract AMS tray info into loaded_filaments-compatible format."""
    trays: list[dict] = []
    ams_units = ams_data.get("ams") or []
    for unit in ams_units:
        unit_id = int(unit.get("id", 0))
        for tray in unit.get("tray") or []:
            tray_id = int(tray.get("id", 0))
            slot = unit_id * 4 + tray_id
            color_hex = tray.get("tray_color", "")
            if len(color_hex) >= 6:
                css_color = f"#{color_hex[:6]}"
            else:
                css_color = "#888888"
            trays.append({
                "slot": slot,
                "color": css_color,
                "type": tray.get("tray_type") or "PLA",
                "color_name": None,
                "brand": None,
                "filament_id": None,
            })

    if vt_tray and isinstance(vt_tray, dict) and vt_tray.get("tray_type"):
        vt_color = vt_tray.get("tray_color", "")
        css = f"#{vt_color[:6]}" if len(vt_color) >= 6 else "#888888"
        trays.append({
            "slot": 254,
            "color": css,
            "type": vt_tray.get("tray_type") or "PLA",
            "color_name": "External",
            "brand": None,
            "filament_id": None,
        })

    if trays:
        _ams_cache[dev_id] = trays


def subscribe_device(dev_id: str) -> None:
    """Subscribe to MQTT reports for a device (idempotent)."""
    if dev_id not in _state_cache:
        _state_cache[dev_id] = {"ts": 0, "state": "unknown"}
    if _mqtt_client is not None:
        topic = f"device/{dev_id}/report"
        _mqtt_client.subscribe(topic)
        # Request full status dump
        _publish(dev_id, {"pushing": {"command": "pushall"}})


def get_cached_state(dev_id: str) -> dict:
    """Return cached MQTT state for a device, or offline placeholder."""
    entry = _state_cache.get(dev_id)
    if not entry or time.monotonic() - entry.get("ts", 0) > STATUS_CACHE_TTL:
        return {"state": "offline"}
    return entry


def get_ams_filaments(dev_id: str) -> list[dict]:
    """Return cached AMS tray data for a device."""
    return _ams_cache.get(dev_id, [])


# ── MQTT commands ─────────────────────────────────────────────────────────────


def _publish(dev_id: str, payload: dict) -> None:
    if _mqtt_client is None:
        raise BambuError("Bambu MQTT не підключений")
    topic = f"device/{dev_id}/request"
    _mqtt_client.publish(topic, json.dumps(payload))


def pause_print(dev_id: str) -> None:
    _publish(dev_id, {
        "print": {"command": "pause", "sequence_id": _next_seq()},
    })


def resume_print(dev_id: str) -> None:
    _publish(dev_id, {
        "print": {"command": "resume", "sequence_id": _next_seq()},
    })


def stop_print(dev_id: str) -> None:
    _publish(dev_id, {
        "print": {"command": "stop", "sequence_id": _next_seq()},
    })


def start_print(
    dev_id: str,
    ftp_filename: str,
    subtask_name: str,
    ams_mapping: list[int] | None = None,
    use_ams: bool = True,
) -> None:
    """Send MQTT command to start printing a file already uploaded via FTPS."""
    cmd: dict[str, Any] = {
        "print": {
            "command": "project_file",
            "sequence_id": _next_seq(),
            "param": "Metadata/plate_1.gcode",
            "subtask_name": subtask_name,
            "url": f"ftp://{ftp_filename}",
            "use_ams": use_ams,
        },
    }
    if ams_mapping is not None:
        cmd["print"]["ams_mapping"] = ams_mapping
    _publish(dev_id, cmd)


# ── FTPS upload (LAN) ────────────────────────────────────────────────────────


def upload_3mf(dev_ip: str, access_code: str, file_path: Path, filename: str) -> str:
    """Upload a .3mf to the printer via FTPS (LAN).

    Returns the filename on the printer (for the MQTT start command).
    """
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    try:
        ftp = ftplib.FTP_TLS(context=ctx)
        ftp.connect(dev_ip, 990, timeout=FTPS_TIMEOUT)
        ftp.login(user="bblp", passwd=access_code)
        ftp.prot_p()

        with file_path.open("rb") as f:
            ftp.storbinary(f"STOR {filename}", f)
        ftp.quit()
    except Exception as e:
        raise BambuError(f"FTPS upload to {dev_ip} failed: {e}") from e

    return filename


# ── Lifecycle ─────────────────────────────────────────────────────────────────


async def init() -> None:
    """Start Bambu Cloud auth + MQTT.  Called from FastAPI lifespan."""
    global _mqtt_client

    if not _is_configured():
        log.info("Bambu not configured — skipping")
        return

    try:
        login()
    except BambuError:
        log.exception("Bambu initial login failed — MQTT won't start")
        return

    # Discover devices so we know what to subscribe to
    devices = list_devices()
    for d in devices:
        _state_cache.setdefault(d["dev_id"], {"ts": 0, "state": "unknown"})

    if not _user_id:
        log.warning("No Bambu user_id — MQTT won't start")
        return

    try:
        import paho.mqtt.client as mqtt

        client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            protocol=mqtt.MQTTv311,
        )
        client.username_pw_set(_user_id, _access_token)
        client.tls_set()
        client.tls_insecure_set(True)

        client.on_connect = _on_connect
        client.on_message = _on_message

        host = _mqtt_host()
        log.info("Bambu MQTT connecting to %s:8883 …", host)
        client.connect_async(host, 8883, MQTT_KEEPALIVE)
        client.loop_start()
        _mqtt_client = client
        log.info("Bambu MQTT loop started")
    except Exception:
        log.exception("Bambu MQTT startup failed")


async def shutdown() -> None:
    """Stop MQTT loop.  Called from FastAPI lifespan."""
    global _mqtt_client
    if _mqtt_client is not None:
        try:
            _mqtt_client.loop_stop()
            _mqtt_client.disconnect()
        except Exception:
            pass
        _mqtt_client = None
