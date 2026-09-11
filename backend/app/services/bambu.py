"""Bambu Lab Cloud API + MQTT + LAN FTPS client.

Cloud HTTP (sync `requests`): login, token refresh, list_devices.
MQTT (paho-mqtt, background thread per org): live status + print commands.
FTPS (ftplib.FTP_TLS): upload .3mf to printer over LAN.

All stateful operations are keyed by org_id.  Call sync helpers from async
FastAPI via `asyncio.to_thread`.
"""
from __future__ import annotations

import asyncio
import base64
import ftplib
import json
import logging
import ssl
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any

import requests
from sqlalchemy.orm import Session

from app.core import metrics
from app.core.db import SessionLocal
from app.models.bambu_cloud_job import BambuCloudJob, BambuCloudJobStatus
from app.services import bambu_provider
from app.services.bambu_errors import BambuErrorCode, error_details
from app.services.bambu_job_state import (
    ACTIVE_STATUSES as CLOUD_JOB_ACTIVE_STATUSES,
    BambuJobTransitionError,
    transition_job,
)
from app.services.bambu_observability import event_tags, log_event

if TYPE_CHECKING:
    from app.models.organization import Organization

log = logging.getLogger(__name__)

FTPS_TIMEOUT = 30
MQTT_KEEPALIVE = 60
STATUS_CACHE_TTL = 30.0
# A printer can stay quiet on MQTT while its SD card is busy writing a large
# 3MF. Keep the last known state separately so the dashboard does not turn a
# working printer red just because the fresh telemetry window elapsed.
STATUS_STALE_TTL = 15 * 60
DEVICE_LIST_CACHE_TTL = 60
# MQTT reports arrive ~1/s per printing device — persist to Redis on change
# or at most this often, so Upstash isn't hammered with identical payloads.
REDIS_STATE_WRITE_INTERVAL = 5.0
REDIS_AMS_WRITE_INTERVAL = 60.0
BAMBU_FULL_REFRESH_INTERVAL_SECONDS = 5 * 60
# P1/A1 reports are delta-based, so AMS fields may be absent for minutes at a
# time. Keep last-known trays beyond the periodic full refresh interval.
AMS_CACHE_TTL_SECONDS = 15 * 60
FILAMENT_COMMAND_TTL_SECONDS = 30
FILAMENT_ACK_TIMEOUT_SECONDS = 8.0
FILAMENT_ACK_POLL_SECONDS = 0.05
FILAMENT_CONFIRMATION_GRACE_SECONDS = 12.0
CLOUD_JOB_FILENAME_WINDOW = timedelta(hours=2)
TRANSIENT_FAILURE_RECOVERY_WINDOW = timedelta(minutes=30)
BED_CLEARED_TTL_SECONDS = 12 * 3600

_GENERIC_FILAMENT_PROFILES: dict[str, tuple[str, int, int]] = {
    "PLA": ("GFL99", 190, 240),
    "PETG": ("GFG99", 220, 270),
    "ABS": ("GFB99", 240, 280),
    "ASA": ("GFB98", 240, 280),
    "TPU": ("GFU99", 200, 250),
    "PA": ("GFN99", 240, 280),
    "PC": ("GFC99", 260, 290),
    "PVA": ("GFS99", 190, 240),
}

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


class _ImplicitFTP_TLS(ftplib.FTP_TLS):
    """Implicit FTPS for Bambu printers on :990."""

    @property
    def sock(self):
        return self._sock

    @sock.setter
    def sock(self, value):
        if value is not None and not isinstance(value, ssl.SSLSocket):
            value = self.context.wrap_socket(value)
        self._sock = value

    def storbinary(self, cmd, fp, blocksize=8192, callback=None, rest=None):
        self.voidcmd("TYPE I")
        conn = self.transfercmd(cmd, rest)
        try:
            while buf := fp.read(blocksize):
                conn.sendall(buf)
                if callback:
                    callback(buf)
            if isinstance(conn, ssl.SSLSocket):
                try:
                    conn.settimeout(0.5)
                    conn.unwrap()
                except Exception:
                    pass
        finally:
            conn.close()
        return self.voidresp()


# ── Per-org state ────────────────────────────────────────────────────────────

_access_tokens: dict[int, str] = {}   # org_id → access_token
_user_ids: dict[int, str] = {}        # org_id → user_id
_regions: dict[int, str] = {}         # org_id → region string
_mqtt_clients: dict[int, Any] = {}    # org_id → paho Client

_mqtt_lock = threading.Lock()
_seq_counter = 0
_seq_lock = threading.Lock()

# (org_id, dev_id) → latest MQTT report; serial numbers are not tenant boundaries.
_state_cache: dict[tuple[int, str], dict[str, Any]] = {}
# (org_id, dev_id) → AMS tray data
_ams_cache: dict[tuple[int, str], list[dict]] = {}
# A successful setting ACK can arrive just before an older full AMS snapshot.
# Hold the confirmed value briefly so that stale in-flight telemetry cannot
# make the spool flash back to its previous colour in the UI.
_confirmed_filament_slots: dict[tuple[int, str, int], tuple[float, dict[str, Any]]] = {}
# (org_id, dev_id) → last Redis write (throttling)
_last_state_redis_write: dict[tuple[int, str], float] = {}
_last_ams_redis_write: dict[tuple[int, str], float] = {}
# Subscriptions are owned by the authenticated cloud/LAN connection.
_subscriptions: set[tuple[int, str]] = set()
# (org_id, dev_id) → LAN MQTT client
_lan_mqtt_clients: dict[tuple[int, str], Any] = {}


def _next_seq() -> str:
    global _seq_counter
    with _seq_lock:
        _seq_counter += 1
        return str(_seq_counter)


def build_pushall_payload() -> dict[str, dict[str, str | int]]:
    """Build the complete Bambu status request used by Handy/Studio clients."""
    return {
        "pushing": {
            "command": "pushall",
            "sequence_id": _next_seq(),
            "version": 1,
            "push_target": 1,
        },
    }


def _is_configured(org: "Organization") -> bool:
    from app.services.encryption import decrypt
    return bool(
        (decrypt(org.bambu_email) and decrypt(org.bambu_password))
        or decrypt(org.bambu_refresh_token)
    )


def _api_base(org_id: int) -> str:
    r = _regions.get(org_id) or "us"
    return _REGION_HOSTS.get(r, _REGION_HOSTS["us"])["api"]


def _mqtt_host(org_id: int) -> str:
    r = _regions.get(org_id) or "us"
    return _REGION_HOSTS.get(r, _REGION_HOSTS["us"])["mqtt"]


def _headers(org_id: int) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {_access_tokens.get(org_id, '')}",
        "Content-Type": "application/json",
    }


# ── Cloud HTTP (sync) ────────────────────────────────────────────────────────


def _fetch_user_id_from_api(org_id: int) -> None:
    """Fetch user_id from Bambu profile API (fallback when token is not a JWT)."""
    base = _api_base(org_id)
    try:
        data = bambu_provider.get_user_profile(base, _headers(org_id))
        uid = str(data.get("uid") or data.get("userId") or data.get("user_id") or "")
        if uid:
            _user_ids[org_id] = uid
            log.info("Bambu user_id from profile API (org_id=%s): %s", org_id, uid)
        else:
            log.warning("Bambu profile API returned no uid (org_id=%s): keys=%s", org_id, list(data.keys()))
    except Exception as e:
        log.warning("Bambu profile API call failed (org_id=%s): %s", org_id, e)


def _extract_user_id(org_id: int, token: str) -> None:
    """Extract user_id from JWT payload, or fetch from profile API if token is opaque."""
    parts = token.split(".")
    if len(parts) == 3:
        try:
            payload_b64 = parts[1]
            padding = 4 - len(payload_b64) % 4
            if padding != 4:
                payload_b64 += "=" * padding
            payload = json.loads(base64.urlsafe_b64decode(payload_b64))
            uid = str(
                payload.get("user_id") or payload.get("uid") or payload.get("sub") or ""
            )
            if uid:
                _user_ids[org_id] = uid
                return
            log.warning("Bambu JWT has no user_id (org_id=%s). Keys: %s", org_id, list(payload.keys()))
        except Exception:
            log.warning("Could not decode Bambu JWT (org_id=%s)", org_id)
    else:
        log.info("Bambu token is opaque (org_id=%s), fetching user_id from profile API", org_id)

    # JWT decode failed or token is opaque — call profile API
    _fetch_user_id_from_api(org_id)


def _login_with_refresh_token(org: "Organization", stored_token: str) -> str:
    """Try Bambu's loginType=refreshToken endpoint (used by email-code/Google accounts)."""
    from app.services.encryption import decrypt
    base = _api_base(org.id)
    try:
        data = bambu_provider.post_login(
            base,
            {"account": decrypt(org.bambu_email), "refreshToken": stored_token, "loginType": "refreshToken"},
        )
    except requests.RequestException as e:
        raise BambuError(f"Bambu loginType=refreshToken failed: {e}") from e

    token = data.get("accessToken") or data.get("token")
    if not token:
        raise BambuError(f"Bambu loginType=refreshToken: no token in response: {data}")

    _access_tokens[org.id] = token
    _extract_user_id(org.id, token)
    log.info("Bambu Cloud: re-login via refreshToken (org_id=%s, user_id=%s)", org.id, _user_ids.get(org.id))
    return token


def login(org: "Organization") -> str:
    """Authenticate with Bambu Cloud for an org.  Returns access_token.

    Tries refresh_token endpoint first (for password accounts), then falls
    back to using the stored token directly as an access token (email-code accounts
    return a long-lived token that doesn't work with the refresh endpoint).
    """
    from app.services.encryption import decrypt
    _refresh = decrypt(org.bambu_refresh_token)
    _email   = decrypt(org.bambu_email)
    _password = decrypt(org.bambu_password)

    if _refresh:
        r = org.bambu_region or "us"
        _regions[org.id] = r
        try:
            return refresh_token(org, _refresh)
        except BambuError as e:
            log.warning("Bambu /refreshtoken failed (org_id=%s): %s", org.id, e)
        try:
            return _login_with_refresh_token(org, _refresh)
        except BambuError as e:
            log.warning("Bambu loginType=refreshToken failed (org_id=%s): %s", org.id, e)
        # Last resort: use the stored token directly (may be a long-lived JWT access token)
        _access_tokens[org.id] = _refresh
        _extract_user_id(org.id, _refresh)
        uid = _user_ids.get(org.id)
        if uid:
            log.info("Bambu: using stored token as-is (org_id=%s, user_id=%s)", org.id, uid)
            return _refresh
        raise BambuError(
            f"Bambu authentication failed (org_id={org.id}) — please re-authenticate via email code"
        )

    if not (_email and _password):
        raise BambuError("Bambu credentials not configured for this organization")

    r = org.bambu_region or "us"
    _regions[org.id] = r
    base = _api_base(org.id)
    try:
        data = bambu_provider.post_login(base, {"account": _email, "password": _password, "apiError": ""})
    except requests.RequestException as e:
        raise BambuError(f"Bambu login failed: {e}") from e

    if not data.get("success") and data.get("loginType") == "verifyCode":
        raise BambuError(
            "Bambu потребує код верифікації (2FA). "
            "Вимкніть 2FA для фермового акаунта, або використайте bambu_refresh_token."
        )
    if not data.get("accessToken"):
        raise BambuError(f"Bambu login failed: {data}")

    token = data["accessToken"]
    _access_tokens[org.id] = token
    _extract_user_id(org.id, token)
    log.info("Bambu Cloud: logged in (org_id=%s, user_id=%s)", org.id, _user_ids.get(org.id))
    return token


def refresh_token(org: "Organization", token: str) -> str:
    """Use a refresh_token to get a fresh access_token for an org."""
    r = org.bambu_region or "us"
    _regions[org.id] = r
    base = _api_base(org.id)
    try:
        data = bambu_provider.post_refresh_token(base, token)
    except requests.RequestException as e:
        raise BambuError(f"Bambu token refresh failed: {e}") from e

    access = data.get("accessToken") or data.get("token")
    if not access:
        raise BambuError(f"Bambu token refresh: no token in response: {data}")

    _access_tokens[org.id] = access
    _extract_user_id(org.id, access)
    log.info("Bambu Cloud: token refreshed (org_id=%s, user_id=%s)", org.id, _user_ids.get(org.id))
    return access


def list_devices(org_id: int, *, force: bool = False) -> list[dict]:
    """Get printers bound to the Bambu Cloud account for an org.

    Cached for DEVICE_LIST_CACHE_TTL — every printer listing used to hit
    Bambu Cloud directly. `force=True` bypasses the cache (claim/discovery).
    """
    from app.services.cache import cache_get, cache_set

    if not force:
        cached = cache_get(f"bambu:devices:{org_id}")
        if cached is not None:
            return cached

    token = _access_tokens.get(org_id)
    if not token:
        # Token missing (e.g. after server restart) — try to re-login from DB
        try:
            from app.core.db import SessionLocal
            from app.models.organization import Organization
            with SessionLocal() as db:
                org = db.get(Organization, org_id)
            if org and _is_configured(org):
                login(org)
                token = _access_tokens.get(org_id)
        except Exception:
            log.warning("Bambu auto-login failed (org_id=%s)", org_id, exc_info=True)
        if not token:
            return []
    base = _api_base(org_id)
    try:
        data = bambu_provider.get_user_bind(base, _headers(org_id))
    except requests.RequestException as e:
        log.warning("Bambu list_devices failed (org_id=%s): %s", org_id, e)
        return []

    devices = data.get("devices") or []
    result = [
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
    # Error paths above return [] without caching, so a transient cloud
    # failure never hides printers for the whole TTL.
    cache_set(f"bambu:devices:{org_id}", result, DEVICE_LIST_CACHE_TTL)
    return result


def get_device_firmware_version(org_id: int, dev_id: str) -> str | None:
    """Best-effort firmware version for a Bambu Cloud device. Never raises."""
    if not _access_tokens.get(org_id):
        return None
    try:
        data = bambu_provider.get_device_version(_api_base(org_id), _headers(org_id), dev_id)
        return bambu_provider.extract_firmware_version(data)
    except Exception as e:
        log.debug("Bambu device version lookup failed (org_id=%s dev_id=%s): %s", org_id, dev_id, e)
        return None


def do_token_refresh() -> None:
    """Periodic refresh called by APScheduler — iterates all configured orgs."""
    from app.core.db import SessionLocal
    from app.models.organization import Organization

    with SessionLocal() as db:
        orgs = db.query(Organization).all()

    for org in orgs:
        if not _is_configured(org):
            continue
        try:
            from app.services.encryption import decrypt
            rt = decrypt(org.bambu_refresh_token)
            if rt:
                refresh_token(org, rt)
            else:
                login(org)
        except BambuError:
            log.exception("Bambu periodic token refresh failed (org_id=%s)", org.id)


# ── MQTT ──────────────────────────────────────────────────────────────────────


def _make_on_connect(org_id: int):
    def _on_connect(client: Any, userdata: Any, flags: Any, rc: int, properties: Any = None) -> None:
        if rc != 0:
            log.warning("Bambu MQTT connect failed (org_id=%s): rc=%s", org_id, rc)
            return
        log.info("Bambu MQTT connected (org_id=%s)", org_id)
        for oid, dev_id in list(_subscriptions):
            if oid == org_id:
                client.subscribe(f"device/{dev_id}/report")
                _maybe_pushall(dev_id, client=client, org_id=org_id)
    return _on_connect


_last_pushall: dict[tuple[int, str], float] = {}


def _maybe_pushall(dev_id: str, *, org_id: int, force: bool = False, qos: int = 0, client: Any = None) -> None:
    """Publish a pushall (full-state dump) unless one was sent recently for this device.

    Repeated pushall requests make P1/A1 printers drop their Bambu Cloud
    connection, which knocks them out of the Handy app. `_make_on_connect`
    fires this for every device on every MQTT reconnect, so it must be
    throttled — a flapping connection would otherwise storm every printer.
    The periodic worker refresh (`request_full_status`, every
    `BAMBU_FULL_REFRESH_INTERVAL_SECONDS`) and explicit post-command reads
    pass `force=True` to bypass the throttle deliberately.
    """
    now = time.monotonic()
    if not force and now - _last_pushall.get((org_id, dev_id), 0.0) < BAMBU_FULL_REFRESH_INTERVAL_SECONDS:
        return
    _last_pushall[(org_id, dev_id)] = now
    if client is not None:
        # on_connect callback — _mqtt_clients[org_id] isn't assigned yet, so
        # publish directly on the client paho just handed us.
        client.publish(f"device/{dev_id}/request", json.dumps(build_pushall_payload()), qos=qos)
    else:
        _publish(dev_id, build_pushall_payload(), qos=qos, org_id=org_id)


def _on_message(client: Any, userdata: Any, msg: Any) -> None:
    try:
        payload = json.loads(msg.payload)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return

    parts = msg.topic.split("/")
    if len(parts) < 2:
        return
    dev_id = parts[1]
    org_id = userdata
    if type(org_id) is not int or (org_id, dev_id) not in _subscriptions:
        return
    if len(parts) != 3 or parts[0] != "device" or parts[2] != "report" or not isinstance(payload, dict):
        return

    job = _handle_report_payload(dev_id, payload, org_id=org_id)
    _kick_autoprint_from_report(dev_id, payload, job, org_id=org_id)


_autoprint_idle_kicks: dict[tuple[int, str], float] = {}
# Event loop of the process that called init() — lets paho callback threads
# schedule coroutines when there is no Redis to relay through.
_main_loop: asyncio.AbstractEventLoop | None = None


def _kick_autoprint_from_report(dev_id: str, payload: dict[str, Any], job: BambuCloudJob | None, *, org_id: int) -> None:
    """Forward PlateCycler AutoPrint triggers from cloud MQTT reports.

    Runs in the paho callback thread of the worker process. Publish a kick event
    to Redis (`autoprint:kick`, consumed by autoprint.run_kick_listener) so the
    web process advances the queue. When Redis is absent (single-process dev),
    schedule the coroutine locally.
    """

    from app.services.bambu_job_state import TERMINAL_STATUSES

    event: dict[str, Any] | None = None
    if job is not None and job.plan_entry_id is not None and job.status in TERMINAL_STATUSES:
        event = {"org_id": org_id, "job_id": job.id}
    else:
        raw_state = str((payload.get("print") or {}).get("gcode_state") or "")
        now = time.monotonic()
        if raw_state in {"IDLE", "FINISH"} and now - _autoprint_idle_kicks.get((org_id, dev_id), 0.0) >= 30:
            _autoprint_idle_kicks[(org_id, dev_id)] = now
            event = {"org_id": org_id, "dev_id": dev_id, "finished": raw_state == "FINISH"}
    if event is None:
        return

    from app.services.cache import _r

    r = _r()
    if r is not None:
        try:
            r.publish("autoprint:kick", json.dumps(event))
            return
        except Exception:
            log.warning("autoprint kick publish failed (dev_id=%s)", dev_id, exc_info=True)
    if _main_loop is None or not _main_loop.is_running():
        return
    from app.services.autoprint import handle_terminal_job, start_next_for_device

    if "job_id" in event:
        coro = handle_terminal_job(event["job_id"])
    else:
        coro = start_next_for_device(org_id, dev_id, allow_finished_state=bool(event.get("finished")))
    asyncio.run_coroutine_threadsafe(coro, _main_loop)


def handle_agent_report(org_id: int, dev_id: str, payload: dict[str, Any]) -> BambuCloudJob | None:
    """Ingest a Bambu LAN MQTT report forwarded by monofarm-agent.

    The agent owns LAN connectivity when the backend runs in the cloud. Once a
    report reaches this function, reuse the same parser/cache/job correlation
    path as cloud MQTT so the rest of the app sees one live-state source.
    """
    if not dev_id:
        return None
    _subscriptions.add((org_id, dev_id))
    return _handle_report_payload(dev_id, payload, org_id=org_id)


def _handle_report_payload(dev_id: str, payload: dict[str, Any], *, org_id: int) -> BambuCloudJob | None:
    print_data = payload.get("print", {})
    if not print_data:
        return None

    raw_state = print_data.get("gcode_state", "")

    prev = _state_cache.get((org_id, dev_id), {})
    received_at = datetime.now(timezone.utc)
    progress_pct = print_data.get("mc_percent")
    remaining_min = print_data.get("mc_remaining_time")
    eta_minutes = int(remaining_min) if isinstance(remaining_min, (int, float)) and remaining_min > 0 else None
    filename = print_data.get("subtask_name") or print_data.get("gcode_file") or prev.get("filename")

    from app.services.cache import cache_delete, cache_get, cache_set
    bed_cleared_key = f"bambu:org:{org_id}:bed_cleared:{dev_id}"
    if raw_state in ("RUNNING", "PREPARE", "SLICING"):
        cache_delete(bed_cleared_key)
        bed_cleared = None
    else:
        bed_cleared = cache_get(bed_cleared_key)

    state = _GCODE_STATE_MAP.get(raw_state, prev.get("state", "unknown")) if raw_state else prev.get("state", "unknown")
    cleared_terminal = raw_state in ("FINISH", "FAILED") and bool(bed_cleared)
    if cleared_terminal:
        state = "idle"
        progress_pct = None
        eta_minutes = None
        filename = None

    # Parse HMS error codes (Bambu health monitoring system)
    hms_list = print_data.get("hms")
    error_msg: str | None = None
    if isinstance(hms_list, list) and hms_list:
        texts = [_hms_describe(h) for h in hms_list if isinstance(h, dict)]
        if texts:
            error_msg = " | ".join(texts)
    if error_msg is None and print_data.get("print_error"):
        err_code = print_data["print_error"]
        if err_code != 0:
            error_msg = _describe_print_error(err_code)
    if cleared_terminal:
        error_msg = None

    updated = {
        "ts": time.monotonic(),
        "last_message_at": received_at.isoformat(),
        "state": state,
        "raw_state": "IDLE" if cleared_terminal else (raw_state or prev.get("raw_state", "")),
        "progress_pct": None if cleared_terminal else (int(progress_pct) if progress_pct is not None else prev.get("progress_pct")),
        "eta_minutes": None if cleared_terminal else (eta_minutes if eta_minutes is not None else prev.get("eta_minutes")),
        "filename": filename,
        "nozzle_temp": print_data.get("nozzle_temper") if print_data.get("nozzle_temper") is not None else prev.get("nozzle_temp"),
        "nozzle_target": print_data.get("nozzle_target_temper") if print_data.get("nozzle_target_temper") is not None else prev.get("nozzle_target"),
        "bed_temp": print_data.get("bed_temper") if print_data.get("bed_temper") is not None else prev.get("bed_temp"),
        "bed_target": print_data.get("bed_target_temper") if print_data.get("bed_target_temper") is not None else prev.get("bed_target"),
        "layer_num": None if cleared_terminal else (
            print_data.get("layer_num") if print_data.get("layer_num") is not None else prev.get("layer_num")
        ),
        "total_layers": None if cleared_terminal else (
            print_data.get("total_layer_num") if print_data.get("total_layer_num") is not None else prev.get("total_layers")
        ),
        # Clear error_msg when printer recovers to normal state
        "error_msg": error_msg if error_msg is not None else (
            None if raw_state in ("IDLE", "RUNNING", "FINISH") or cleared_terminal else prev.get("error_msg")
        ),
        # Carry forward — reports without AMS data must not drop the active tray
        "active_tray": prev.get("active_tray"),
        # Bambu reports the cumulative native skip-object set as `s_obj`.
        "skipped_object_ids": (
            [int(value) for value in print_data.get("s_obj", []) if str(value).lstrip("-").isdigit()]
            if isinstance(print_data.get("s_obj"), list)
            else prev.get("skipped_object_ids", [])
        ),
    }
    if state in ("paused", "printing", "error") and error_msg and error_msg != prev.get("error_msg"):
        from app.core.db import SessionLocal as _SessionLocal
        from app.models.printer import Printer

        org_id_local = org_id
        with _SessionLocal() as db:
            printer = (
                db.query(Printer)
                .filter(
                    Printer.organization_id == org_id_local,
                    Printer.bambu_dev_id == dev_id,
                )
                .first()
            )
            if printer is not None:
                from app.services.telegram_notify import send_print_event_notification

                send_print_event_notification(
                    db,
                    org_id_local or 0,
                    event="failed",
                    printer_name=printer.name,
                    printer_id=printer.id,
                    file_name=filename,
                    reason=error_msg,
                    dedupe_key=f"{printer.id}:failed:{error_msg}",
                )
    state_changed = updated.get("state") != prev.get("state")
    _state_cache[(org_id, dev_id)] = updated
    if state_changed:
        log_event(
            log,
            logging.INFO,
            "bambu.mqtt.state.changed",
            org_id=org_id,
            dev_id=dev_id,
            old_status=prev.get("state", "unknown"),
            new_status=updated.get("state"),
        )

    ams_changed = _handle_filament_setting_ack(dev_id, print_data, org_id=org_id)
    ams_data = print_data.get("ams")
    vt_tray = print_data.get("vt_tray")
    # P1-series printers without a physical AMS unit still report the external
    # spool via vt_tray but may omit the "ams" key entirely — parse it either way.
    if isinstance(ams_data, dict) or isinstance(vt_tray, dict):
        ams_changed = _parse_ams(
            dev_id,
            ams_data if isinstance(ams_data, dict) else {},
            vt_tray,
            org_id=org_id,
        ) or ams_changed
    if isinstance(ams_data, dict):
        # Active tray: "255" = external spool (slot 254 in our convention)
        tray_now = ams_data.get("tray_now")
        if tray_now is not None:
            try:
                t = int(tray_now)
                updated["active_tray"] = 254 if t == 255 else t
            except (ValueError, TypeError):
                pass
    elif isinstance(vt_tray, dict):
        # No AMS unit reporting at all — the external spool is the only source.
        updated["active_tray"] = 254

    # Persist to Redis on meaningful change, else at most every few seconds —
    # reports stream ~1/s per printing device and the payload rarely differs.
    now_mono = time.monotonic()
    active_tray_changed = updated.get("active_tray") != prev.get("active_tray")
    skipped_objects_changed = updated.get("skipped_object_ids") != prev.get("skipped_object_ids")
    if (
        state_changed
        or updated.get("error_msg") != prev.get("error_msg")
        or active_tray_changed
        or skipped_objects_changed
        or now_mono - _last_state_redis_write.get((org_id, dev_id), 0.0) >= REDIS_STATE_WRITE_INTERVAL
    ):
        cache_set(f"bambu:org:{org_id}:state:{dev_id}", updated, int(STATUS_CACHE_TTL))
        cache_set(f"bambu:org:{org_id}:state:stale:{dev_id}", updated, STATUS_STALE_TTL)
        _last_state_redis_write[(org_id, dev_id)] = now_mono
    if ams_changed or active_tray_changed:
        _publish_printer_refresh(dev_id, "ams" if ams_changed else "active_tray", org_id=org_id)
    elif skipped_objects_changed:
        _publish_printer_refresh(dev_id, "skip_objects", org_id=org_id)
    if cleared_terminal:
        return None
    return _sync_cloud_job_from_report(dev_id, print_data, updated, error_msg, org_id=org_id)


def _describe_print_error(err_code: int) -> str:
    """Return an actionable message for a numeric Bambu print error."""
    if err_code == 0x0500C010:
        return "Помилка MicroSD: карта пам’яті не читається або не записується — перевір/заміни MicroSD-карту на принтері (0x0500c010)"
    return f"Помилка друку: {err_code:#010x}"


def mark_bed_cleared(dev_id: str, filename: str | None = None, *, org_id: int) -> dict[str, Any]:
    """Persist operator confirmation so FINISH reports do not re-open the bed prompt."""
    from app.services.cache import cache_set
    marker = {"cleared_at": datetime.now(timezone.utc).isoformat(), "filename": filename}
    cache_set(f"bambu:org:{org_id}:bed_cleared:{dev_id}", marker, BED_CLEARED_TTL_SECONDS)
    idle = {
        "ts": time.monotonic(),
        "last_message_at": marker["cleared_at"],
        "state": "idle",
        "raw_state": "IDLE",
        "filename": None,
        "progress_pct": None,
        "eta_minutes": None,
        "error_msg": None,
        "layer_num": None,
        "total_layers": None,
    }
    _state_cache[(org_id, dev_id)] = idle
    cache_set(f"bambu:org:{org_id}:state:{dev_id}", idle, int(STATUS_CACHE_TTL))
    cache_set(f"bambu:org:{org_id}:state:stale:{dev_id}", idle, STATUS_STALE_TTL)
    return idle


def _safe_int(value: Any) -> int | None:
    try:
        if value is None:
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def _extract_mqtt_task_id(print_data: dict[str, Any]) -> str | None:
    for key in ("task_id", "taskId", "subtask_id", "subtaskId", "print_task_id", "printTaskId"):
        value = print_data.get(key)
        if value not in (None, ""):
            return str(value)
    project = print_data.get("project")
    if isinstance(project, dict):
        for key in ("task_id", "taskId", "subtask_id", "subtaskId"):
            value = project.get(key)
            if value not in (None, ""):
                return str(value)
    return None


def _normalize_cloud_job_name(value: str | None) -> str:
    return Path(value or "").name.strip().lower()


def _query_active_jobs_for_device(db: Session, dev_id: str, *, org_id: int) -> list[BambuCloudJob]:
    return (
        db.query(BambuCloudJob)
        .filter(
            BambuCloudJob.printer_bambu_dev_id == dev_id,
            BambuCloudJob.organization_id == org_id,
            BambuCloudJob.status.in_(CLOUD_JOB_ACTIVE_STATUSES),
        )
        .order_by(BambuCloudJob.created_at.desc(), BambuCloudJob.id.desc())
        .all()
    )


def _find_matching_cloud_job(
    db: Session,
    *,
    org_id: int,
    dev_id: str,
    print_data: dict[str, Any],
    filename: str | None,
    now: datetime,
) -> BambuCloudJob | None:
    task_id = _extract_mqtt_task_id(print_data)
    if task_id:
        matches = (
            db.query(BambuCloudJob)
            .filter(
                BambuCloudJob.printer_bambu_dev_id == dev_id,
                BambuCloudJob.organization_id == org_id,
                BambuCloudJob.bambu_task_id == task_id,
                BambuCloudJob.status.in_((*CLOUD_JOB_ACTIVE_STATUSES, BambuCloudJobStatus.failed)),
            )
            .order_by(BambuCloudJob.created_at.desc(), BambuCloudJob.id.desc())
            .all()
        )
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            log_event(
                log,
                logging.WARNING,
                "bambu.cloud.mqtt.ambiguous",
                task_id=task_id,
                dev_id=dev_id,
                matches=len(matches),
            )
            return None

    active_jobs = [
        job for job in _query_active_jobs_for_device(db, dev_id, org_id=org_id)
        if job.status in (
            BambuCloudJobStatus.task_created,
            BambuCloudJobStatus.acknowledged,
            BambuCloudJobStatus.printing,
            BambuCloudJobStatus.paused,
        )
    ]
    if len(active_jobs) == 1:
        return active_jobs[0]
    if len(active_jobs) > 1:
        normalized = _normalize_cloud_job_name(filename)
        if normalized:
            cutoff = now - CLOUD_JOB_FILENAME_WINDOW
            filename_matches = [
                job for job in active_jobs
                if job.created_at
                and job.created_at >= cutoff
                and _normalize_cloud_job_name(job.file_name) == normalized
            ]
            if len(filename_matches) == 1:
                return filename_matches[0]
        log_event(
            log,
            logging.INFO,
            "bambu.cloud.mqtt.ambiguous",
            dev_id=dev_id,
            active_jobs=len(active_jobs),
            filename=filename,
        )
    return None


def _can_recover_transient_failure(job: BambuCloudJob, now: datetime) -> bool:
    return bool(
        job.status == BambuCloudJobStatus.failed
        and job.error_code == BambuErrorCode.PRINT_FAILED_HMS.value
        and job.started_printing_at is None
        and job.failed_at is not None
        and job.task_created_at is not None
        and timedelta(0) <= now - job.failed_at <= TRANSIENT_FAILURE_RECOVERY_WINDOW
    )


def _status_from_mqtt_report(
    job: BambuCloudJob,
    *,
    raw_state: str,
    progress_pct: int | None,
    error_msg: str | None,
) -> tuple[BambuCloudJobStatus | None, str | None]:
    if raw_state in ("RUNNING", "PREPARE", "SLICING"):
        return BambuCloudJobStatus.printing, "Printer reports print progress"
    if raw_state == "PAUSE" and error_msg:
        return BambuCloudJobStatus.failed, error_msg or "Printer reports print failed"
    if raw_state == "PAUSE":
        return BambuCloudJobStatus.paused, "Printer reports print paused"
    if raw_state == "FINISH" or (
        progress_pct is not None and progress_pct >= 100 and job.status in (BambuCloudJobStatus.printing, BambuCloudJobStatus.paused)
    ):
        return BambuCloudJobStatus.completed, "Printer reports print completed"
    if raw_state == "FAILED":
        # Bambu can echo a transient FAILED snapshot immediately after
        # project_file is accepted, before the first RUNNING report. Do not
        # terminally fail a job unless the printer supplied a real error or
        # had already started this print.
        if error_msg or job.started_printing_at is not None or job.status in (
            BambuCloudJobStatus.printing,
            BambuCloudJobStatus.paused,
        ):
            return BambuCloudJobStatus.failed, error_msg or "Printer reports print failed"
        if job.status in (BambuCloudJobStatus.task_created, BambuCloudJobStatus.acknowledged):
            return BambuCloudJobStatus.acknowledged, "Printer acknowledged task; awaiting start confirmation"
        return BambuCloudJobStatus.failed, error_msg or "Printer reports print failed"
    if job.status == BambuCloudJobStatus.task_created and raw_state:
        return BambuCloudJobStatus.acknowledged, "Printer acknowledged Bambu Cloud task"
    return None, None


def _sync_cloud_job_from_report(
    dev_id: str,
    print_data: dict[str, Any],
    cached_state: dict[str, Any],
    error_msg: str | None,
    *,
    org_id: int,
    session_factory=None,
) -> BambuCloudJob | None:
    session_factory = session_factory or SessionLocal
    now = datetime.now(timezone.utc)
    filename = cached_state.get("filename")
    raw_state = str(print_data.get("gcode_state") or "")
    progress_pct = _safe_int(print_data.get("mc_percent"))
    eta_minutes = cached_state.get("eta_minutes")
    if eta_minutes is not None:
        eta_minutes = _safe_int(eta_minutes)

    with session_factory() as db:
        job = _find_matching_cloud_job(db, dev_id=dev_id, print_data=print_data, filename=filename, now=now, org_id=org_id)
        if job is None:
            return None

        prior_error_msg = job.error_msg
        task_id = _extract_mqtt_task_id(print_data)
        updates: dict[str, Any] = {"last_mqtt_at": now}
        if task_id and not job.bambu_task_id:
            updates["bambu_task_id"] = task_id
        if progress_pct is not None:
            updates["progress_pct"] = max(0, min(progress_pct, 100))
        if eta_minutes is not None:
            updates["eta_minutes"] = eta_minutes
        if error_msg is not None:
            updates["error_msg"] = error_msg

        target_status, reason = _status_from_mqtt_report(
            job,
            raw_state=raw_state,
            progress_pct=updates.get("progress_pct"),
            error_msg=error_msg,
        )
        recovering_transient_failure = (
            target_status == BambuCloudJobStatus.printing
            and _can_recover_transient_failure(job, now)
        )
        if recovering_transient_failure:
            reason = "Printer is printing; previous pre-start failure report was transient"
            updates.update({
                "error_code": None,
                "error_msg": None,
                "error_details_json": None,
                "failed_at": None,
            })
        if target_status in (
            BambuCloudJobStatus.acknowledged,
            BambuCloudJobStatus.printing,
            BambuCloudJobStatus.paused,
            BambuCloudJobStatus.completed,
            BambuCloudJobStatus.failed,
        ) and job.printer_ack_at is None:
            updates["printer_ack_at"] = now
        if target_status in (
            BambuCloudJobStatus.printing,
            BambuCloudJobStatus.completed,
        ) and job.started_printing_at is None:
            updates["started_printing_at"] = now
        if target_status == BambuCloudJobStatus.failed:
            updates["error_code"] = BambuErrorCode.PRINT_FAILED_HMS.value
            updates["error_details_json"] = error_details(
                BambuErrorCode.PRINT_FAILED_HMS,
                retryable=False,
                raw_state=raw_state,
                source="bambu_mqtt",
                previous_error_code=(job.error_details_json or {}).get("error_code"),
            )

        try:
            transition_job(job, target_status or job.status, reason=reason, now=now, **updates)
        except BambuJobTransitionError as exc:
            log_event(
                log,
                logging.INFO,
                "bambu.cloud.mqtt.transition_rejected",
                org_id=job.organization_id,
                printer_id=job.printer_id,
                dev_id=dev_id,
                job_id=job.id,
                correlation_id=job.correlation_id,
                old_status=job.status.value,
                new_status=(target_status or job.status).value,
                reason=exc,
            )
            return None

        db.commit()
        db.refresh(job)
        from app.models.printer import Printer
        from app.services.telegram_notify import send_print_event_notification

        printer = db.get(Printer, job.printer_id)
        if printer is not None:
            if target_status in (BambuCloudJobStatus.printing, BambuCloudJobStatus.paused) and error_msg and error_msg != prior_error_msg:
                send_print_event_notification(
                    db,
                    job.organization_id,
                    event="failed",
                    printer_name=printer.name,
                    printer_id=printer.id,
                    file_name=job.file_name or filename,
                    reason=error_msg,
                    dedupe_key=f"{job.id}:error:{error_msg}",
                )
            if target_status == BambuCloudJobStatus.failed:
                send_print_event_notification(
                    db,
                    job.organization_id,
                    event="failed",
                    printer_name=printer.name,
                    printer_id=printer.id,
                    file_name=job.file_name or filename,
                    reason=error_msg or job.error_msg,
                    dedupe_key=f"{job.id}:failed",
                )
        if progress_pct is not None:
            log_event(
                log,
                logging.INFO,
                "bambu.mqtt.job.progress",
                org_id=job.organization_id,
                printer_id=job.printer_id,
                dev_id=dev_id,
                job_id=job.id,
                correlation_id=job.correlation_id,
                status=job.status.value,
                progress_pct=job.progress_pct,
                eta_minutes=job.eta_minutes,
            )
        log_event(
            log,
            logging.INFO,
            "bambu.cloud.mqtt.correlated",
            org_id=job.organization_id,
            printer_id=job.printer_id,
            dev_id=dev_id,
            job_id=job.id,
            correlation_id=job.correlation_id,
            status=job.status.value,
        )
        metrics.increment("bambu.mqtt.report.correlated.count", tags=event_tags(org_id=job.organization_id, status=job.status.value))
        return job


def _parse_ams(dev_id: str, ams_data: dict, vt_tray: dict | None, *, org_id: int) -> bool:
    from app.services.cache import cache_get, cache_set

    previous = _ams_cache.get((org_id, dev_id))
    if previous is None:
        cached = cache_get(f"bambu:org:{org_id}:ams:{dev_id}")
        previous = cached if isinstance(cached, list) else []

    trays_by_slot = {
        int(tray["slot"]): tray
        for tray in previous
        if isinstance(tray, dict) and tray.get("slot") is not None
    }
    authoritative = False

    units = ams_data.get("ams")
    if isinstance(units, list):
        authoritative = True
        trays_by_slot = {slot: tray for slot, tray in trays_by_slot.items() if slot == 254}
        for unit in units:
            unit_id = int(unit.get("id", 0))
            for tray in unit.get("tray") or []:
                tray_id = int(tray.get("id", 0))
                slot = unit_id * 4 + tray_id
                tray_type = tray.get("tray_type") or ""
                empty = not tray_type.strip()
                color_hex = tray.get("tray_color", "")
                css_color = f"#{color_hex[:6]}" if len(color_hex) >= 6 else "#888888"
                trays_by_slot[slot] = {
                    "slot": slot,
                    "color": css_color if not empty else "#888888",
                    "type": tray_type if not empty else "",
                    "color_name": None,
                    "brand": tray.get("tray_sub_brands") or None,
                    "filament_id": None,
                    "empty": empty,
                    "unit_id": unit_id,
                }

    if isinstance(vt_tray, dict):
        authoritative = True
        vt_type = vt_tray.get("tray_type") or ""
        vt_empty = not vt_type.strip()
        vt_color = vt_tray.get("tray_color", "")
        css = f"#{vt_color[:6]}" if len(vt_color) >= 6 else "#888888"
        trays_by_slot[254] = {
            "slot": 254,
            "color": css if not vt_empty else "#888888",
            "type": vt_type,
            "color_name": "External",
            "brand": vt_tray.get("tray_sub_brands") or None,
            "filament_id": None,
            "empty": vt_empty,
            "unit_id": None,
        }

    if not authoritative:
        return False

    now_mono = time.monotonic()
    for key, (expires_at, confirmed) in list(_confirmed_filament_slots.items()):
        confirmed_org_id, confirmed_dev_id, slot = key
        if confirmed_org_id != org_id or confirmed_dev_id != dev_id:
            continue
        if expires_at <= now_mono:
            _confirmed_filament_slots.pop(key, None)
            continue
        reported = trays_by_slot.get(slot)
        if reported is not None and _same_filament_state(reported, confirmed):
            _confirmed_filament_slots.pop(key, None)
        else:
            trays_by_slot[slot] = confirmed

    trays = [trays_by_slot[slot] for slot in sorted(trays_by_slot)]
    changed = previous != trays
    _ams_cache[(org_id, dev_id)] = trays
    if changed or now_mono - _last_ams_redis_write.get((org_id, dev_id), 0.0) >= REDIS_AMS_WRITE_INTERVAL:
        cache_set(f"bambu:org:{org_id}:ams:{dev_id}", trays, AMS_CACHE_TTL_SECONDS)
        _last_ams_redis_write[(org_id, dev_id)] = now_mono
    return changed


def _publish_printer_refresh(dev_id: str, reason: str, *, org_id: int) -> None:
    """Notify the web process that a Bambu AMS snapshot changed."""

    publish_printer_refresh(org_id, dev_id, reason)


def publish_printer_refresh(org_id: int, dev_id: str, reason: str) -> None:
    """Publish a printer refresh from MQTT callbacks or API mutations."""

    event = {"org_id": org_id, "dev_id": dev_id, "reason": reason}
    from app.services.cache import _r
    from app.services.ws_manager import PRINTER_EVENTS_CHANNEL

    redis_client = _r()
    if redis_client is not None:
        try:
            if redis_client.publish(PRINTER_EVENTS_CHANNEL, json.dumps(event)):
                return
        except Exception:
            log.warning("printer realtime publish failed (dev_id=%s)", dev_id, exc_info=True)

    if _main_loop is None or not _main_loop.is_running():
        return
    from app.api.ws import broadcast_printer_snapshot

    asyncio.run_coroutine_threadsafe(broadcast_printer_snapshot(org_id), _main_loop)


# ── HMS error lookup ──────────────────────────────────────────────────────────

def _load_hms_db() -> dict[str, str]:
    import gzip
    import json as _json
    db_path = Path(__file__).parent / "hms_en.json.gz"
    if not db_path.exists():
        return {}
    with gzip.open(db_path) as f:
        raw = _json.load(f)
    return {k: next(iter(v)) for k, v in raw.get("device_hms", {}).items() if v}


_HMS_DB: dict[str, str] = _load_hms_db()

# Module code (attr >> 16) → module name (fallback when code not in DB)
_HMS_MODULES: dict[int, str] = {
    0x0100: "Тулхед",
    0x0200: "Екструдер",
    0x0300: "Стіл",
    0x0500: "Рух/мотори",
    0x0600: "Привід осі",
    0x0700: "AMS",
    0x0800: "Зовнішня котушка",
    0x0900: "Датчик філаменту",
    0x0A00: "Буфер",
    0x0C00: "Сопло/хотенд",
    0x0D00: "Камера",
    0x0F00: "Плата MC",
    0x1000: "Живлення",
    0x1100: "Вентилятор",
    0x1200: "XCam/Огляд шарів",
    0x1400: "Гіроскоп",
    0x2000: "Мережа",
    0x3000: "AP Board",
}

# Full code → Ukrainian description (attr_high_attr_low_code_high_code_low)
_HMS_MESSAGES: dict[str, str] = {
    # Hotend / Nozzle
    "0C00_0100_0001_0001": "Температура сопла нижча за норму",
    "0C00_0100_0002_0001": "Перегрів сопла",
    "0C00_0200_0001_0001": "Помилка датчика температури сопла",
    "0C00_0200_0002_0001": "Датчик температури сопла відключено",
    "0C00_0300_0001_0001": "Заминка філаменту в хотенді",
    "0C00_0300_0002_0001": "Філамент не подається в хотенд",
    "0C00_0400_0001_0001": "Збій вентилятора хотенду",
    "0C00_0400_0002_0001": "Збій вентилятора обдуву деталі",
    # Heated bed
    "0300_0100_0001_0001": "Помилка датчика температури столу",
    "0300_0100_0001_0002": "NTC температура столу аномальна",
    "0300_0100_0002_0001": "Стіл нагрівається занадто повільно",
    "0300_0100_0002_0002": "Стіл не досягає цільової температури",
    "0300_0200_0001_0001": "Перегрів столу",
    # Motors / Motion
    "0500_0100_0001_0001": "Збій мотора осі X (stall)",
    "0500_0100_0002_0001": "Збій мотора осі Y (stall)",
    "0500_0100_0003_0001": "Збій мотора осі Z (stall)",
    "0500_0100_0004_0001": "Збій мотора подачі філаменту",
    "0500_0200_0001_0001": "Зіткнення по осі X",
    "0500_0200_0002_0001": "Зіткнення по осі Y",
    "0500_0300_0001_0001": "Помилка калібрування осі Z",
    "0500_0300_0002_0001": "Помилка mesh калібрування столу",
    # AMS
    "0700_0300_0001_0001": "AMS: помилка подачі філаменту",
    "0700_0300_0002_0001": "AMS: заминка/застрявання філаменту",
    "0700_0400_0001_0001": "AMS: помилка намотки",
    "0700_0500_0001_0001": "AMS: помилка температури",
    "0700_0600_0001_0001": "AMS: немає філаменту",
    "0700_7000_0002_0001": "AMS: не вдалося подати філамент в тулхед",
    "0700_7000_0002_0002": "AMS: не вдалося подати філамент в тулхед (можлива заминка або зачеплена котушка)",
    "0700_7000_0003_0001": "AMS: не вдалося втягнути філамент назад",
    "0700_1700_0001_0001": "AMS слот 1: проблема з філаментом",
    "0700_1700_0001_0002": "AMS слот 1: заминка",
    "0700_1700_0001_0003": "AMS слот 1: немає філаменту",
    "0700_1700_0002_0001": "AMS слот 2: проблема з філаментом",
    "0700_1700_0002_0002": "AMS слот 2: заминка",
    "0700_1700_0002_0003": "AMS слот 2: немає філаменту",
    "0700_1700_0003_0001": "AMS слот 3: проблема з філаментом",
    "0700_1700_0003_0002": "AMS слот 3: заминка",
    "0700_1700_0003_0003": "AMS слот 3: немає філаменту",
    "0700_1700_0004_0001": "AMS слот 4: проблема з філаментом",
    "0700_1700_0004_0002": "AMS слот 4: заминка",
    "0700_1700_0004_0003": "AMS слот 4: немає філаменту",
    # Power
    "1000_0100_0001_0001": "Проблема з живленням",
    "1000_0200_0001_0001": "Напруга виходу за межі норми",
    # Network
    "2000_0100_0001_0001": "Проблема з мережею",
    "2000_0100_0002_0001": "Втрата підключення до хмари",
    # XCam / Lidar — only codes confirmed from firmware msg field
}


def _hms_describe(h: dict) -> str:
    attr = h.get("attr", 0)
    code = h.get("code", 0)
    # Firmware sometimes includes text directly
    if h.get("msg"):
        return str(h["msg"])
    key_underscored = (
        f"{attr >> 16 & 0xFFFF:04X}_{attr & 0xFFFF:04X}"
        f"_{code >> 16 & 0xFFFF:04X}_{code & 0xFFFF:04X}"
    )
    key_flat = key_underscored.replace("_", "")
    # 1. Full 4998-entry database
    if key_flat in _HMS_DB:
        return _HMS_DB[key_flat]
    # 2. Manual fallback table
    if key_underscored in _HMS_MESSAGES:
        return _HMS_MESSAGES[key_underscored]
    # 3. Module name + raw code
    module = _HMS_MODULES.get(attr >> 16 & 0xFFFF, None)
    prefix = f"{module}: " if module else ""
    return f"{prefix}HMS {key_underscored}"


def subscribe_device(dev_id: str, org_id: int) -> None:
    """Subscribe to MQTT reports for a device (idempotent)."""
    _subscriptions.add((org_id, dev_id))
    _state_cache.setdefault((org_id, dev_id), {"ts": 0, "state": "unknown"})
    client = _mqtt_clients.get(org_id)
    if client is not None:
        client.subscribe(f"device/{dev_id}/report")
        _maybe_pushall(dev_id, org_id=org_id)


def get_cached_state(dev_id: str, *, org_id: int) -> dict:
    """Return cached MQTT state for a device, or offline placeholder."""
    from app.services.cache import cache_get
    fresh = cache_get(f"bambu:org:{org_id}:state:{dev_id}")
    if fresh is not None:
        return {**fresh, "state_stale": False}
    stale = cache_get(f"bambu:org:{org_id}:state:stale:{dev_id}")
    if stale is not None:
        return {**stale, "state_stale": True}
    # Local dict fallback (same-worker stale data)
    entry = _state_cache.get((org_id, dev_id))
    if entry and time.monotonic() - entry.get("ts", 0) <= STATUS_CACHE_TTL:
        return {**entry, "state_stale": False}
    if entry:
        return {**entry, "state_stale": True}
    return {"state": "offline"}


def get_ams_filaments(dev_id: str, *, org_id: int) -> list[dict]:
    """Return cached AMS tray data for a device."""
    from app.services.cache import cache_get
    fresh = cache_get(f"bambu:org:{org_id}:ams:{dev_id}")
    if fresh is not None:
        return fresh
    return _ams_cache.get((org_id, dev_id), [])


# ── MQTT commands ─────────────────────────────────────────────────────────────


def _publish(dev_id: str, payload: dict, qos: int = 0, *, org_id: int) -> None:
    # LAN client takes priority (per-device, older firmware)
    lan_client = _lan_mqtt_clients.get((org_id, dev_id))
    if lan_client is not None:
        lan_client.publish(
            f"device/{dev_id}/request",
            json.dumps(payload, separators=(",", ":")),
            qos=qos,
        )
        return
    # Cloud MQTT client (per-org)
    client = _mqtt_clients.get(org_id) if org_id is not None else None
    if client is not None:
        client.publish(f"device/{dev_id}/request", json.dumps(payload), qos=qos)
        return
    # No local MQTT client (web process with INLINE_WORKERS=false) — relay via Redis
    from app.services.cache import _r
    r = _r()
    if r is not None:
        r.publish("bambu:cmd", json.dumps({
            "org_id": org_id,
            "topic": f"device/{dev_id}/request",
            "payload": json.dumps(payload),
            "qos": qos,
        }))
        return
    raise BambuError("Bambu MQTT не підключений (no local client, no Redis)")


def send_gcode(dev_id: str, script: str, *, org_id: int) -> None:
    """Send raw G-code to a Bambu printer via MQTT gcode_line command."""
    _publish(dev_id, {
        "print": {
            "command": "gcode_line",
            "param": script if script.endswith("\n") else script + "\n",
            "sequence_id": _next_seq(),
        }
    }, org_id=org_id)


def set_speed_profile(dev_id: str, profile: int, *, org_id: int) -> None:
    """Set Bambu speed profile: 1=Silent, 2=Standard, 3=Sport, 4=Ludicrous."""
    _publish(dev_id, {
        "print": {
            "command": "print_speed",
            "param": str(profile),
            "sequence_id": _next_seq(),
        }
    }, org_id=org_id)


def _generic_filament_profile(material: str) -> tuple[str, int, int]:
    if not material:
        return "", 0, 0
    normalized = material.strip().upper()
    for prefix, profile in _GENERIC_FILAMENT_PROFILES.items():
        if normalized == prefix or normalized.startswith(f"{prefix}-") or normalized.startswith(f"{prefix}+"):
            return profile
    return "", 190, 300


def _filament_pending_key(dev_id: str, sequence_id: str, *, org_id: int) -> str:
    return f"bambu:org:{org_id}:ams:pending:{dev_id}:{sequence_id}"


def _filament_ack_key(dev_id: str, sequence_id: str, *, org_id: int) -> str:
    return f"bambu:org:{org_id}:ams:ack:{dev_id}:{sequence_id}"


def _filament_cache_entry(slot: dict[str, Any]) -> dict[str, Any]:
    slot_index = int(slot.get("slot", 254))
    empty = bool(slot.get("empty"))
    raw_color = str(slot.get("hex_color") or slot.get("color") or "").strip()
    if len(raw_color.lstrip("#")) not in (6, 8):
        raw_color = "#888888"
    else:
        raw_color = f"#{raw_color.lstrip('#')[:6].upper()}"
    material = "" if empty else str(slot.get("type") or "PLA").strip().upper()
    return {
        "slot": slot_index,
        "color": "#888888" if empty else raw_color,
        "type": material,
        "color_name": None,
        "brand": None,
        "filament_id": None,
        "empty": empty,
        "unit_id": None if slot_index == 254 else slot_index // 4,
    }


def _same_filament_state(left: dict[str, Any], right: dict[str, Any]) -> bool:
    if bool(left.get("empty")) != bool(right.get("empty")):
        return False
    if bool(left.get("empty")):
        return True
    return (
        str(left.get("type") or "").strip().upper()
        == str(right.get("type") or "").strip().upper()
        and str(left.get("color") or "").strip().lower()[:7]
        == str(right.get("color") or "").strip().lower()[:7]
    )


def _store_confirmed_filament_slot(dev_id: str, slot: dict[str, Any], *, org_id: int) -> bool:
    from app.services.cache import cache_set

    previous = get_ams_filaments(dev_id, org_id=org_id)
    by_slot = {
        int(item["slot"]): item
        for item in previous
        if isinstance(item, dict) and item.get("slot") is not None
    }
    slot_index = int(slot["slot"])
    changed = by_slot.get(slot_index) != slot
    by_slot[slot_index] = slot
    trays = [by_slot[index] for index in sorted(by_slot)]
    _ams_cache[(org_id, dev_id)] = trays
    cache_set(f"bambu:org:{org_id}:ams:{dev_id}", trays, AMS_CACHE_TTL_SECONDS)
    _last_ams_redis_write[(org_id, dev_id)] = time.monotonic()
    _confirmed_filament_slots[(org_id, dev_id, slot_index)] = (
        time.monotonic() + FILAMENT_CONFIRMATION_GRACE_SECONDS,
        slot,
    )
    return changed


def _handle_filament_setting_ack(dev_id: str, print_data: dict[str, Any], *, org_id: int) -> bool:
    if print_data.get("command") != "ams_filament_setting":
        return False
    sequence_id = str(print_data.get("sequence_id") or "")
    if not sequence_id:
        return False

    from app.services.cache import cache_delete, cache_get, cache_set

    result = str(print_data.get("result") or "").strip().lower()
    ok = result in {"success", "ok"}
    pending_key = _filament_pending_key(dev_id, sequence_id, org_id=org_id)
    pending = cache_get(pending_key)
    changed = False
    if ok and isinstance(pending, dict):
        changed = _store_confirmed_filament_slot(dev_id, pending, org_id=org_id)
    cache_set(
        _filament_ack_key(dev_id, sequence_id, org_id=org_id),
        {
            "ok": ok,
            "result": result,
            "reason": print_data.get("reason") or print_data.get("reason_code"),
        },
        FILAMENT_COMMAND_TTL_SECONDS,
    )
    cache_delete(pending_key)
    log.info(
        "bambu.ams.filament_ack dev_id=%s sequence_id=%s result=%s",
        dev_id,
        sequence_id,
        result or "unknown",
    )
    return changed


def _wait_for_filament_ack(dev_id: str, sequence_id: str, *, org_id: int) -> None:
    from app.services.cache import cache_delete, cache_get

    ack_key = _filament_ack_key(dev_id, sequence_id, org_id=org_id)
    deadline = time.monotonic() + FILAMENT_ACK_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        ack = cache_get(ack_key)
        if isinstance(ack, dict):
            cache_delete(ack_key)
            if ack.get("ok"):
                return
            detail = ack.get("reason") or ack.get("result") or "невідома помилка"
            raise BambuError(f"принтер відхилив зміну AMS ({detail})")
        time.sleep(FILAMENT_ACK_POLL_SECONDS)

    cache_delete(_filament_pending_key(dev_id, sequence_id, org_id=org_id))
    log.warning(
        "bambu.ams.filament_ack_timeout dev_id=%s sequence_id=%s",
        dev_id,
        sequence_id,
    )
    raise BambuError("принтер не підтвердив зміну AMS протягом 8 секунд")


def build_ams_filament_setting_payload(slot: dict[str, Any]) -> dict[str, Any]:
    """Build the MQTT command that makes Handy show a slot's material/color."""
    slot_index = int(slot.get("slot", 254))
    if slot_index == 254:
        ams_id, slot_id, tray_id = 255, 0, 254
    else:
        ams_id, slot_id = divmod(slot_index, 4)
        tray_id = slot_id

    raw_color = str(slot.get("hex_color") or slot.get("color") or "").strip().lstrip("#")
    color = raw_color[:8].upper() if len(raw_color) in (6, 8) else "FFFFFF00"
    if len(color) == 6:
        color += "FF"
    empty = bool(slot.get("empty"))
    material = "" if empty else str(slot.get("type") or "PLA").strip().upper()
    filament_id, nozzle_temp_min, nozzle_temp_max = _generic_filament_profile(material)
    return {
        "print": {
            "command": "ams_filament_setting",
            "sequence_id": _next_seq(),
            "ams_id": ams_id,
            "slot_id": slot_id,
            "tray_id": tray_id,
            "tray_info_idx": filament_id,
            "setting_id": "",
            "tray_color": "FFFFFF00" if empty else color,
            "nozzle_temp_min": nozzle_temp_min,
            "nozzle_temp_max": nozzle_temp_max,
            "tray_type": material,
        },
    }


def sync_filament_slot(dev_id: str, slot: dict[str, Any], *, org_id: int) -> None:
    """Publish one operator-edited AMS/external-spool setting."""
    sync_filament_slots(dev_id, [slot], org_id=org_id)


def sync_filament_slots(dev_id: str, slots: list[dict[str, Any]], *, org_id: int) -> None:
    """Publish slot edits, require printer ACKs, then refresh authoritative state."""
    from app.services.cache import cache_delete, cache_set

    sequences: list[str] = []
    for slot in slots:
        payload = build_ams_filament_setting_payload(slot)
        sequence_id = str(payload["print"]["sequence_id"])
        cache_delete(_filament_ack_key(dev_id, sequence_id, org_id=org_id))
        cache_set(
            _filament_pending_key(dev_id, sequence_id, org_id=org_id),
            _filament_cache_entry(slot),
            FILAMENT_COMMAND_TTL_SECONDS,
        )
        try:
            _publish(dev_id, payload, qos=1, org_id=org_id)
        except Exception:
            cache_delete(_filament_pending_key(dev_id, sequence_id, org_id=org_id))
            raise
        sequences.append(sequence_id)

    for sequence_id in sequences:
        _wait_for_filament_ack(dev_id, sequence_id, org_id=org_id)
    request_full_status(dev_id, qos=1, org_id=org_id)


def request_full_status(dev_id: str, *, org_id: int, qos: int = 0) -> None:
    """Request a complete state snapshot; required for delta-only P1/A1 reports.

    Bypasses the pushall throttle (force=True) — callers use this for the
    periodic worker refresh and explicit post-command reads, both already
    paced deliberately by their own caller.
    """
    _maybe_pushall(dev_id, force=True, qos=qos, org_id=org_id)


# Spec: QoS 1 for stop/pause/resume — guaranteed delivery for safety-critical commands.


def pause_print(dev_id: str, *, org_id: int) -> None:
    _publish(dev_id, {"print": {"command": "pause", "param": "", "sequence_id": _next_seq()}}, qos=1, org_id=org_id)


def resume_print(dev_id: str, *, org_id: int) -> None:
    _publish(dev_id, {"print": {"command": "resume", "param": "", "sequence_id": _next_seq()}}, qos=1, org_id=org_id)


def stop_print(dev_id: str, *, org_id: int) -> None:
    _publish(dev_id, {"print": {"command": "stop", "param": "", "sequence_id": _next_seq()}}, qos=1, org_id=org_id)


def skip_objects(dev_id: str, object_ids: list[int], *, org_id: int) -> None:
    """Skip specific native Bambu object IDs from slice_info.config."""
    from app.services.skip_objects import build_bambu_skip_payload

    _publish(
        dev_id,
        build_bambu_skip_payload(object_ids, sequence_id=_next_seq()),
        qos=1,
        org_id=org_id,
    )


def clear_print_error(dev_id: str, *, org_id: int) -> None:
    _publish(dev_id, {"print": {"command": "clean_print_error", "param": "", "sequence_id": _next_seq()}}, qos=1, org_id=org_id)


def plate_gcode_entry(file_bytes: bytes) -> str | None:
    """Return the `Metadata/plate_N.gcode` entry name inside a sliced .3mf.

    A plate keeps its project index when exported ("Export plate sliced file"
    of plate 2 contains only `Metadata/plate_2.gcode`), so the project_file
    `param` must point at the real entry — a hardcoded plate_1 makes the
    printer fail with "failed to parse file". Returns the lowest-numbered
    plate when several are sliced, None for unsliced/invalid archives.
    """
    import io as _io
    import re as _re
    import zipfile as _zipfile
    try:
        with _zipfile.ZipFile(_io.BytesIO(file_bytes)) as zf:
            plates = [
                n for n in zf.namelist()
                if _re.fullmatch(r"Metadata/plate_(\d+)\.gcode", n)
            ]
    except _zipfile.BadZipFile:
        return None
    if not plates:
        return None
    return min(plates, key=lambda n: int(_re.search(r"(\d+)\.gcode$", n).group(1)))


def sanitize_sd_filename(name: str, fallback: str = "print") -> str:
    """ASCII-safe temp name for the printer SD card.

    The project_file `url` (`file:///sdcard/<name>` / `file:///sdcard/cache/<name>`)
    is sent unescaped, so spaces and non-ASCII in the uploaded name break URL
    parsing on some firmware. The pretty original name stays in subtask_name.
    """
    import re as _re
    import unicodedata as _unicodedata
    lower = name.lower()
    suffix = ".gcode.3mf" if lower.endswith(".gcode.3mf") else ".3mf"
    stem = name[: -len(suffix)] if lower.endswith(suffix) else name
    ascii_stem = _unicodedata.normalize("NFKD", stem).encode("ascii", "ignore").decode()
    safe_stem = _re.sub(r"[^A-Za-z0-9._-]+", "_", ascii_stem).strip("._")
    return f"{safe_stem or fallback}{suffix}"


def build_start_print_payload(
    dev_id: str,
    subtask_name: str,
    ams_mapping: list[int] | None = None,
    use_ams: bool = True,
    http_url: str | None = None,
    ftp_filename: str | None = None,
    task_id: str | None = None,
    plate_index: int = 1,
    plate_gcode: str | None = None,
    bed_leveling: bool = True,
    flow_cali: bool = False,
) -> dict[str, Any]:
    """Build a Bambu MQTT project_file command (OpenBambuAPI spec, §6.7).

    Prefers http_url (printer downloads from R2 — no LAN FTPS needed).
    `ftp_filename` is the path returned by the FTPS upload — `cache/x.3mf`
    maps to `file:///sdcard/cache/x.3mf` (the path used by Bambu Handy),
    while a bare name maps to `file:///sdcard/x.3mf` (SD-root upload).
    A1 fw 1.03+ requires task_id / profile_id / project_id / bed_type.
    `task_id` is echoed back in push_status — pass a known value to correlate
    the print with a BambuCloudJob deterministically.
    `plate_gcode` (from `plate_gcode_entry`) overrides the plate_index guess —
    the entry keeps the project's plate number, not always plate_1.
    """
    import uuid as _uuid
    if http_url:
        url = http_url
    elif ftp_filename and ftp_filename.startswith("cache/"):
        url = f"file:///sdcard/{ftp_filename}"
    else:
        url = f"file:///sdcard/{ftp_filename}"
    cmd: dict[str, Any] = {
        "print": {
            "command": "project_file",
            "sequence_id": _next_seq(),
            "task_id": task_id or str(_uuid.uuid4()),
            "profile_id": "0",
            "project_id": "0",
            "subtask_id": "0",
            "param": plate_gcode or f"Metadata/plate_{plate_index}.gcode",
            "subtask_name": subtask_name,
            "url": url,
            "file": "",
            "md5": "",
            "bed_type": "auto",
            "use_ams": use_ams,
            "timelapse": False,
            # Firmware generations disagree on the spelling — send both, unknown
            # keys are ignored (old fw: bed_leveling, OpenBambuAPI: bed_levelling).
            "bed_leveling": bed_leveling,
            "bed_levelling": bed_leveling,
            "flow_cali": flow_cali,
            "vibration_cali": True,
            "layer_inspect": False,
        },
    }
    if ams_mapping is not None:
        cmd["print"]["ams_mapping"] = ams_mapping
    return cmd


def start_print(
    dev_id: str,
    subtask_name: str,
    ams_mapping: list[int] | None = None,
    use_ams: bool = True,
    http_url: str | None = None,
    ftp_filename: str | None = None,
    task_id: str | None = None,
    *,
    org_id: int,
) -> None:
    """Send MQTT project_file command to start printing."""
    cmd = build_start_print_payload(
        dev_id,
        subtask_name,
        ams_mapping=ams_mapping,
        use_ams=use_ams,
        http_url=http_url,
        ftp_filename=ftp_filename,
        task_id=task_id,
    )
    _publish(dev_id, cmd, qos=1, org_id=org_id)


# ── Cloud upload + print (no LAN required) ───────────────────────────────────
#
# The three HTTP calls below are extracted as thin, reusable helpers so
# `bambu_dispatch.py` (job-tracked cloud dispatch) can wrap them with its own
# retry/auth policy without duplicating the request-building logic. They return
# the raw `requests.Response` — callers decide how to interpret status/body.


def _cloud_create_project(base: str, headers: dict[str, str], filename: str) -> requests.Response:
    return bambu_provider.create_project(base, headers, filename)


def _cloud_upload_to_oss(upload_url: str, file_bytes: bytes) -> requests.Response:
    return bambu_provider.upload_to_oss(upload_url, file_bytes)


def _cloud_create_task(base: str, headers: dict[str, str], task_body: dict[str, Any]) -> requests.Response:
    return bambu_provider.create_task(base, headers, task_body)


def cloud_upload_and_print(
    org_id: int,
    file_bytes: bytes,
    filename: str,
    dev_id: str,
    ams_mapping: list[int] | None = None,
    use_ams: bool = True,
) -> None:
    """Upload .3mf to Bambu Cloud (Alibaba OSS) and start print via Cloud task API.

    Flow: POST /project → PUT <oss_upload_url> → POST /task.
    No LAN connectivity required.
    """
    token = _access_tokens.get(org_id)
    if not token:
        try:
            from app.core.db import SessionLocal
            from app.models.organization import Organization as _Org
            with SessionLocal() as db:
                org = db.get(_Org, org_id)
                if org:
                    login(org)
            token = _access_tokens.get(org_id)
        except Exception:
            pass
    if not token:
        raise BambuError("Not authenticated with Bambu Cloud — check credentials")

    base = _api_base(org_id)
    hdrs = _headers(org_id)

    # 1. Create project → get Alibaba OSS upload_url
    try:
        resp = _cloud_create_project(base, hdrs, filename)
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException as e:
        raise BambuError(f"Bambu Cloud create project failed: {e}") from e

    log.info("Bambu Cloud project response: %s", data)
    project = data.get("project") or data
    project_id = project.get("project_id") or project.get("id", "")
    model_id = project.get("model_id") or project_id
    upload_url = project.get("upload_url") or data.get("upload_url")
    cover_url = project.get("cover_url") or project.get("cover") or ""
    if not upload_url:
        raise BambuError(f"Bambu Cloud: no upload_url in project response: {data}")

    # 2. PUT file bytes to Alibaba OSS presigned URL
    try:
        oss = _cloud_upload_to_oss(upload_url, file_bytes)
        oss.raise_for_status()
    except requests.RequestException as e:
        raise BambuError(f"Bambu Cloud OSS upload failed: {e}") from e

    # 3. Create task → Cloud pushes to printer
    task_body: dict[str, Any] = {
        "modelId": model_id,
        "projectId": project_id,
        "profileId": "0",
        "title": filename,
        "deviceId": dev_id,
        "plateIndex": 1,
        "useAms": use_ams,
        "bedLeveling": True,
        "flowCali": False,
        "vibrationCali": True,
        "layerInspect": False,
        "timelapse": False,
        "designId": 0,
        "mode": "cloud_file",
        # Bambu Cloud rejects /task without cover/profileId set
        "cover": cover_url or "",
    }
    if ams_mapping is not None:
        task_body["amsMapping"] = ams_mapping

    log.info("Bambu Cloud task body: %s", task_body)
    try:
        task_resp = _cloud_create_task(base, hdrs, task_body)
        body_text = task_resp.text
        task_resp.raise_for_status()
        log.info("Bambu Cloud: task created dev=%s project=%s", dev_id, project_id)
    except requests.RequestException as e:
        raise BambuError(f"Bambu Cloud create task failed: {e} — body: {body_text}") from e


# ── FTPS upload (LAN fallback) ────────────────────────────────────────────────


def upload_3mf(
    dev_ip: str,
    access_code: str,
    file_path: Path,
    filename: str,
    target_dir: str = "cache",
) -> str:
    """Upload a .3mf to the printer via FTPS (LAN, implicit TLS :990).

    Uploads into `cache/` by default and falls back to the SD root on old
    firmware without that directory. A1/A1 mini project_file jobs should pass
    target_dir="sdcard" so the matching URL is file:///sdcard/<name>.
    Returns the remote path on the printer (`cache/x.3mf` or `x.3mf`) for
    `build_start_print_payload`.
    """
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    try:
        ftp = _ImplicitFTP_TLS(context=ctx)
        ftp.connect(dev_ip, 990, timeout=FTPS_TIMEOUT)
        ftp.login(user="bblp", passwd=access_code.strip())
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

        with file_path.open("rb") as f:
            ftp.storbinary(f"STOR {filename}", f)
        ftp.quit()
    except Exception as e:
        raise BambuError(f"FTPS upload to {dev_ip} failed: {e}") from e

    return remote_path


# ── Lifecycle ─────────────────────────────────────────────────────────────────


async def init_lan_printers(org_id: int) -> None:
    """Start LAN MQTT clients for printers with bambu_lan_mode=True.

    Called from FastAPI lifespan after DB is ready. LAN printers don't need
    cloud auth — they connect directly to the printer IP with the access code.
    """
    try:
        from app.core.db import SessionLocal
        from app.models.printer import Printer, PrinterKind
        with SessionLocal() as db:
            rows = (
                db.query(Printer)
                .filter(
                    Printer.organization_id == org_id,
                    Printer.kind == PrinterKind.bambu,
                    Printer.bambu_lan_mode.is_(True),
                    Printer.is_active.is_(True),
                )
                .all()
            )
        for row in rows:
            if row.bambu_dev_id and row.bambu_dev_ip and row.bambu_access_code:
                start_lan_mqtt(row.bambu_dev_id, row.bambu_dev_ip, row.bambu_access_code, org_id=org_id)
    except Exception:
        log.exception("Bambu LAN MQTT init failed (org_id=%s)", org_id)


async def init(org: "Organization") -> None:
    """Start Bambu Cloud auth + MQTT for one org.  Called from FastAPI lifespan.

    The cloud portion (login + list_devices) does blocking HTTP with retries; a
    dead/expired token can stall it for tens of seconds. Run it in a worker
    thread so a broken Bambu account never freezes the async event loop.
    """
    global _main_loop
    _main_loop = asyncio.get_running_loop()
    await init_lan_printers(org.id)

    if not _is_configured(org):
        return

    await asyncio.to_thread(_init_cloud_sync, org)


def _init_cloud_sync(org: "Organization") -> None:
    """Blocking cloud auth + MQTT startup for one org. Must run off the event loop."""
    # Skip login if token was already seeded (e.g. right after email-code verification).
    if not _access_tokens.get(org.id):
        try:
            login(org)
        except BambuError:
            log.exception("Bambu initial login failed (org_id=%s) — MQTT won't start", org.id)
            return

    # Ensure user_id is populated even if token was pre-seeded
    if not _user_ids.get(org.id):
        token = _access_tokens.get(org.id, "")
        if token:
            _extract_user_id(org.id, token)

    devices = list_devices(org.id)
    for d in devices:
        _subscriptions.add((org.id, d["dev_id"]))
        _state_cache.setdefault((org.id, d["dev_id"]), {"ts": 0, "state": "unknown"})

    user_id = _user_ids.get(org.id)
    if not user_id:
        log.warning("No Bambu user_id (org_id=%s) — MQTT won't start", org.id)
        return

    try:
        import paho.mqtt.client as mqtt

        client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            protocol=mqtt.MQTTv311,
            client_id=f"monofarm-cloud-{org.id}",
            userdata=org.id,
        )
        client.username_pw_set(f"u_{user_id}", _access_tokens[org.id])
        client.tls_set()
        client.tls_insecure_set(False)

        client.on_connect = _make_on_connect(org.id)
        client.on_message = _on_message

        host = _mqtt_host(org.id)
        log.info("Bambu MQTT connecting to %s:8883 (org_id=%s) …", host, org.id)
        client.connect_async(host, 8883, MQTT_KEEPALIVE)
        client.loop_start()
        _mqtt_clients[org.id] = client
        log.info("Bambu MQTT loop started (org_id=%s)", org.id)
    except Exception:
        log.exception("Bambu MQTT startup failed (org_id=%s)", org.id)


async def shutdown(org_id: int | None = None) -> None:
    """Stop MQTT loop(s).  Called from FastAPI lifespan.

    If org_id is None, shuts down all orgs and all LAN clients.
    """
    targets = [org_id] if org_id is not None else list(_mqtt_clients.keys())
    for oid in targets:
        client = _mqtt_clients.pop(oid, None)
        if client is not None:
            try:
                client.loop_stop()
                client.disconnect()
            except Exception:
                pass

    for oid, dev_id in list(_lan_mqtt_clients):
        if org_id is None or oid == org_id:
            stop_lan_mqtt(dev_id, org_id=oid)


# ── LAN MQTT (per-device, older firmware without cloud) ──────────────────────


def start_lan_mqtt(dev_id: str, dev_ip: str, access_code: str, *, org_id: int) -> None:
    """Connect directly to a printer over LAN MQTT (port 8883, TLS, no cloud).

    Auth: username="bblp", password=access_code (LAN Access Code from display).
    Creates a dedicated paho client per device; reuses the same _on_message handler.
    Idempotent — stops and replaces any existing LAN client for this device.
    """
    stop_lan_mqtt(dev_id, org_id=org_id)

    try:
        import paho.mqtt.client as mqtt

        def _on_connect_lan(client: Any, userdata: Any, flags: Any, rc: int, properties: Any = None) -> None:
            if rc != 0:
                log.warning("Bambu LAN MQTT connect failed (dev_id=%s): rc=%s", dev_id, rc)
                return
            log.info("Bambu LAN MQTT connected (dev_id=%s ip=%s)", dev_id, dev_ip)
            client.subscribe(f"device/{dev_id}/report")
            # Request full state dump on connect
            client.publish(
                f"device/{dev_id}/request",
                json.dumps(build_pushall_payload(), separators=(",", ":")),
            )

        def _on_disconnect_lan(client: Any, userdata: Any, rc: int, properties: Any = None) -> None:
            if rc != 0:
                log.warning("Bambu LAN MQTT disconnected unexpectedly (dev_id=%s): rc=%s", dev_id, rc)

        client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            protocol=mqtt.MQTTv311,
            client_id=f"monofarm-lan-{org_id}-{dev_id}",
            userdata=org_id,
        )
        client.username_pw_set("bblp", access_code)
        client.tls_set(tls_version=ssl.PROTOCOL_TLS, cert_reqs=ssl.CERT_NONE)
        client.tls_insecure_set(True)

        client.on_connect = _on_connect_lan
        client.on_disconnect = _on_disconnect_lan
        client.on_message = _on_message

        _subscriptions.add((org_id, dev_id))
        _state_cache.setdefault((org_id, dev_id), {"ts": 0, "state": "unknown"})
        client.connect_async(dev_ip, 8883, MQTT_KEEPALIVE)
        client.loop_start()
        _lan_mqtt_clients[(org_id, dev_id)] = client
        log.info("Bambu LAN MQTT loop started (dev_id=%s ip=%s)", dev_id, dev_ip)
    except Exception:
        log.exception("Bambu LAN MQTT startup failed (dev_id=%s ip=%s)", dev_id, dev_ip)


def stop_lan_mqtt(dev_id: str, *, org_id: int) -> None:
    """Stop and remove the LAN MQTT client for a device."""
    client = _lan_mqtt_clients.pop((org_id, dev_id), None)
    if client is not None:
        try:
            client.loop_stop()
            client.disconnect()
        except Exception:
            pass
        log.info("Bambu LAN MQTT stopped (dev_id=%s)", dev_id)
