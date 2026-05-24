"""Bambu Lab Cloud API + MQTT + LAN FTPS client.

Cloud HTTP (sync `requests`): login, token refresh, list_devices.
MQTT (paho-mqtt, background thread per org): live status + print commands.
FTPS (ftplib.FTP_TLS): upload .3mf to printer over LAN.

All stateful operations are keyed by org_id.  Call sync helpers from async
FastAPI via `asyncio.to_thread`.
"""
from __future__ import annotations

import base64
import ftplib
import json
import logging
import ssl
import threading
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

import requests

if TYPE_CHECKING:
    from app.models.organization import Organization

log = logging.getLogger(__name__)

CLOUD_TIMEOUT = 15
FTPS_TIMEOUT = 30
MQTT_KEEPALIVE = 60
STATUS_CACHE_TTL = 30.0

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


# ── Per-org state ────────────────────────────────────────────────────────────

_access_tokens: dict[int, str] = {}   # org_id → access_token
_user_ids: dict[int, str] = {}        # org_id → user_id
_regions: dict[int, str] = {}         # org_id → region string
_mqtt_clients: dict[int, Any] = {}    # org_id → paho Client

_mqtt_lock = threading.Lock()
_seq_counter = 0
_seq_lock = threading.Lock()

# dev_id → {ts: float, state: str, ...}  — latest MQTT report per printer
_state_cache: dict[str, dict[str, Any]] = {}
# dev_id → list[dict]  — AMS tray data
_ams_cache: dict[str, list[dict]] = {}
# dev_id → org_id  — routes publish to the right MQTT client
_dev_to_org: dict[str, int] = {}


def _next_seq() -> str:
    global _seq_counter
    with _seq_lock:
        _seq_counter += 1
        return str(_seq_counter)


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
        resp = requests.get(
            f"{base}/v1/user-service/my/profile",
            headers=_headers(org_id),
            timeout=CLOUD_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
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
        resp = requests.post(
            f"{base}/v1/user-service/user/login",
            json={"account": decrypt(org.bambu_email), "refreshToken": stored_token, "loginType": "refreshToken"},
            timeout=CLOUD_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
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
        resp = requests.post(
            f"{base}/v1/user-service/user/login",
            json={"account": _email, "password": _password, "apiError": ""},
            timeout=CLOUD_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
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

    _access_tokens[org.id] = access
    _extract_user_id(org.id, access)
    log.info("Bambu Cloud: token refreshed (org_id=%s, user_id=%s)", org.id, _user_ids.get(org.id))
    return access


def list_devices(org_id: int) -> list[dict]:
    """Get printers bound to the Bambu Cloud account for an org."""
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
        resp = requests.get(
            f"{base}/v1/iot-service/api/user/bind",
            headers=_headers(org_id),
            timeout=CLOUD_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException as e:
        log.warning("Bambu list_devices failed (org_id=%s): %s", org_id, e)
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
        for dev_id, oid in list(_dev_to_org.items()):
            if oid == org_id:
                client.subscribe(f"device/{dev_id}/report")
                client.publish(f"device/{dev_id}/request", json.dumps({"pushing": {"command": "pushall"}}))
    return _on_connect


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

    prev = _state_cache.get(dev_id, {})
    progress_pct = print_data.get("mc_percent")
    remaining_min = print_data.get("mc_remaining_time")
    eta_minutes = int(remaining_min) if isinstance(remaining_min, (int, float)) and remaining_min > 0 else None

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
            error_msg = f"Помилка друку: {err_code:#010x}"

    updated = {
        "ts": time.monotonic(),
        "state": _GCODE_STATE_MAP.get(raw_state, prev.get("state", "unknown")) if raw_state else prev.get("state", "unknown"),
        "raw_state": raw_state or prev.get("raw_state", ""),
        "progress_pct": int(progress_pct) if progress_pct is not None else prev.get("progress_pct"),
        "eta_minutes": eta_minutes if eta_minutes is not None else prev.get("eta_minutes"),
        "filename": print_data.get("subtask_name") or print_data.get("gcode_file") or prev.get("filename"),
        "nozzle_temp": print_data.get("nozzle_temper") if print_data.get("nozzle_temper") is not None else prev.get("nozzle_temp"),
        "nozzle_target": print_data.get("nozzle_target_temper") if print_data.get("nozzle_target_temper") is not None else prev.get("nozzle_target"),
        "bed_temp": print_data.get("bed_temper") if print_data.get("bed_temper") is not None else prev.get("bed_temp"),
        "bed_target": print_data.get("bed_target_temper") if print_data.get("bed_target_temper") is not None else prev.get("bed_target"),
        "layer_num": print_data.get("layer_num") if print_data.get("layer_num") is not None else prev.get("layer_num"),
        "total_layers": print_data.get("total_layer_num") if print_data.get("total_layer_num") is not None else prev.get("total_layers"),
        # Clear error_msg when printer recovers to normal state
        "error_msg": error_msg if error_msg is not None else (
            None if raw_state in ("IDLE", "RUNNING", "FINISH") else prev.get("error_msg")
        ),
    }
    _state_cache[dev_id] = updated
    from app.services.cache import cache_set
    cache_set(f"bambu:state:{dev_id}", updated, int(STATUS_CACHE_TTL))

    ams_data = print_data.get("ams")
    if isinstance(ams_data, dict):
        _parse_ams(dev_id, ams_data, print_data.get("vt_tray"))
        # Active tray: "255" = external spool (slot 254 in our convention)
        tray_now = ams_data.get("tray_now")
        if tray_now is not None:
            try:
                t = int(tray_now)
                _state_cache[dev_id]["active_tray"] = 254 if t == 255 else t
                cache_set(f"bambu:state:{dev_id}", _state_cache[dev_id], int(STATUS_CACHE_TTL))
            except (ValueError, TypeError):
                pass


def _parse_ams(dev_id: str, ams_data: dict, vt_tray: dict | None) -> None:
    trays: list[dict] = []
    for unit in ams_data.get("ams") or []:
        unit_id = int(unit.get("id", 0))
        for tray in unit.get("tray") or []:
            tray_id = int(tray.get("id", 0))
            slot = unit_id * 4 + tray_id
            tray_type = tray.get("tray_type") or ""
            empty = not tray_type or tray_type.strip() == ""
            color_hex = tray.get("tray_color", "")
            css_color = f"#{color_hex[:6]}" if len(color_hex) >= 6 else "#888888"
            trays.append({
                "slot": slot,
                "color": css_color if not empty else "#888888",
                "type": tray_type if not empty else "",
                "color_name": None,
                "brand": tray.get("tray_sub_brands") or None,
                "filament_id": None,
                "empty": empty,
                "unit_id": unit_id,
            })

    if vt_tray and isinstance(vt_tray, dict):
        vt_type = vt_tray.get("tray_type") or ""
        vt_empty = not vt_type.strip()
        vt_color = vt_tray.get("tray_color", "")
        css = f"#{vt_color[:6]}" if len(vt_color) >= 6 else "#888888"
        trays.append({
            "slot": 254,
            "color": css if not vt_empty else "#888888",
            "type": vt_type,
            "color_name": "External",
            "brand": vt_tray.get("tray_sub_brands") or None,
            "filament_id": None,
            "empty": vt_empty,
            "unit_id": None,
        })

    if trays:
        _ams_cache[dev_id] = trays
        from app.services.cache import cache_set
        cache_set(f"bambu:ams:{dev_id}", trays, 300)


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
    _dev_to_org[dev_id] = org_id
    _state_cache.setdefault(dev_id, {"ts": 0, "state": "unknown"})
    client = _mqtt_clients.get(org_id)
    if client is not None:
        client.subscribe(f"device/{dev_id}/report")
        _publish(dev_id, {"pushing": {"command": "pushall"}})


def get_cached_state(dev_id: str) -> dict:
    """Return cached MQTT state for a device, or offline placeholder."""
    from app.services.cache import cache_get
    fresh = cache_get(f"bambu:state:{dev_id}")
    if fresh is not None:
        return fresh
    # Local dict fallback (same-worker stale data)
    entry = _state_cache.get(dev_id)
    if entry and time.monotonic() - entry.get("ts", 0) <= STATUS_CACHE_TTL:
        return entry
    return {"state": "offline"}


def get_ams_filaments(dev_id: str) -> list[dict]:
    """Return cached AMS tray data for a device."""
    from app.services.cache import cache_get
    fresh = cache_get(f"bambu:ams:{dev_id}")
    if fresh is not None:
        return fresh
    return _ams_cache.get(dev_id, [])


# ── MQTT commands ─────────────────────────────────────────────────────────────


def _publish(dev_id: str, payload: dict) -> None:
    org_id = _dev_to_org.get(dev_id)
    client = _mqtt_clients.get(org_id) if org_id is not None else None
    if client is not None:
        client.publish(f"device/{dev_id}/request", json.dumps(payload))
        return
    # No local MQTT client (web process with INLINE_WORKERS=false) — relay via Redis
    from app.services.cache import _r
    r = _r()
    if r is not None:
        r.publish("bambu:cmd", json.dumps({
            "topic": f"device/{dev_id}/request",
            "payload": json.dumps(payload),
        }))
        return
    raise BambuError("Bambu MQTT не підключений (no local client, no Redis)")


def send_gcode(dev_id: str, script: str) -> None:
    """Send raw G-code to a Bambu printer via MQTT gcode_line command."""
    _publish(dev_id, {
        "print": {
            "command": "gcode_line",
            "param": script if script.endswith("\n") else script + "\n",
            "sequence_id": _next_seq(),
        }
    })


def set_speed_profile(dev_id: str, profile: int) -> None:
    """Set Bambu speed profile: 1=Silent, 2=Standard, 3=Sport, 4=Ludicrous."""
    _publish(dev_id, {
        "print": {
            "command": "print_speed",
            "param": str(profile),
            "sequence_id": _next_seq(),
        }
    })


def pause_print(dev_id: str) -> None:
    _publish(dev_id, {"print": {"command": "pause", "sequence_id": _next_seq()}})


def resume_print(dev_id: str) -> None:
    _publish(dev_id, {"print": {"command": "resume", "sequence_id": _next_seq()}})


def stop_print(dev_id: str) -> None:
    _publish(dev_id, {"print": {"command": "stop", "sequence_id": _next_seq()}})


def start_print(
    dev_id: str,
    subtask_name: str,
    ams_mapping: list[int] | None = None,
    use_ams: bool = True,
    http_url: str | None = None,
    ftp_filename: str | None = None,
) -> None:
    """Send MQTT project_file command to start printing.

    Prefers http_url (printer downloads from R2 — no LAN FTPS needed).
    Falls back to ftp://ftp_filename for local-disk setups.
    A1 fw 1.03+ requires task_id / profile_id / project_id / bed_type.
    """
    import uuid as _uuid
    url = http_url if http_url else f"ftp://{ftp_filename}"
    cmd: dict[str, Any] = {
        "print": {
            "command": "project_file",
            "sequence_id": _next_seq(),
            "task_id": str(_uuid.uuid4()),
            "profile_id": "0",
            "project_id": "0",
            "subtask_id": "0",
            "param": "Metadata/plate_1.gcode",
            "subtask_name": subtask_name,
            "url": url,
            "bed_type": "auto",
            "use_ams": use_ams,
            "timelapse": False,
            "bed_leveling": True,
            "flow_cali": False,
            "vibration_cali": True,
            "layer_inspect": False,
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


async def init(org: "Organization") -> None:
    """Start Bambu Cloud auth + MQTT for one org.  Called from FastAPI lifespan."""
    if not _is_configured(org):
        return

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
        _dev_to_org[d["dev_id"]] = org.id
        _state_cache.setdefault(d["dev_id"], {"ts": 0, "state": "unknown"})

    user_id = _user_ids.get(org.id)
    if not user_id:
        log.warning("No Bambu user_id (org_id=%s) — MQTT won't start", org.id)
        return

    try:
        import paho.mqtt.client as mqtt

        client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            protocol=mqtt.MQTTv311,
        )
        client.username_pw_set(f"u_{user_id}", _access_tokens[org.id])
        client.tls_set()
        client.tls_insecure_set(True)

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

    If org_id is None, shuts down all orgs.
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
