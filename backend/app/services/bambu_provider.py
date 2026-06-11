"""Raw Bambu Cloud HTTP endpoint calls — the single place that knows URLs and payload shapes.

Protocol reference: github.com/coelacant1/Bambu-Lab-Cloud-API (documentation only —
the package itself is AGPL-3.0 and must NOT be imported or vendored into Monofarm).

No Monofarm domain logic here. Functions take an explicit region `base` URL and
prebuilt `headers`; callers (`bambu.py`, `bambu_auth.py`, `bambu_dispatch.py`)
own auth, retries, error taxonomy, and job lifecycle.

Two return conventions:
  - auth/profile/device functions raise_for_status and return parsed JSON —
    callers catch `requests.RequestException`;
  - dispatch-stage functions (`create_project` / `upload_to_oss` / `create_task`)
    return the raw `requests.Response` so `bambu_dispatch._execute_with_retry`
    can interpret status codes under its own retry policy.
"""
from __future__ import annotations

from typing import Any

import requests

CLOUD_TIMEOUT = 15
EMAIL_CODE_TIMEOUT = 10
OSS_UPLOAD_TIMEOUT = 300


# ── Auth / user ──────────────────────────────────────────────────────────────


def post_login(base: str, payload: dict[str, Any]) -> dict[str, Any]:
    """`POST /v1/user-service/user/login` — password, email-code, or refreshToken login."""
    resp = requests.post(f"{base}/v1/user-service/user/login", json=payload, timeout=CLOUD_TIMEOUT)
    resp.raise_for_status()
    return resp.json()


def post_refresh_token(base: str, refresh_token: str) -> dict[str, Any]:
    """`POST /v1/user-service/user/refreshtoken` — refresh-token grant."""
    resp = requests.post(
        f"{base}/v1/user-service/user/refreshtoken",
        json={"refreshToken": refresh_token},
        timeout=CLOUD_TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json()


def send_email_code(base: str, email: str) -> requests.Response:
    """`POST /v1/user-service/user/sendemail/code` — 6-digit login code email.

    Returns the raw Response — the org settings endpoint maps non-2xx itself.
    """
    return requests.post(
        f"{base}/v1/user-service/user/sendemail/code",
        json={"email": email, "type": "codeLogin"},
        timeout=EMAIL_CODE_TIMEOUT,
    )


def get_user_profile(base: str, headers: dict[str, str]) -> dict[str, Any]:
    """`GET /v1/user-service/my/profile` — user_id fallback for opaque tokens."""
    resp = requests.get(f"{base}/v1/user-service/my/profile", headers=headers, timeout=CLOUD_TIMEOUT)
    resp.raise_for_status()
    return resp.json()


# ── Devices ──────────────────────────────────────────────────────────────────


def get_user_bind(base: str, headers: dict[str, str]) -> dict[str, Any]:
    """`GET /v1/iot-service/api/user/bind` — printers bound to the account."""
    resp = requests.get(f"{base}/v1/iot-service/api/user/bind", headers=headers, timeout=CLOUD_TIMEOUT)
    resp.raise_for_status()
    return resp.json()


def get_device_version(base: str, headers: dict[str, str], dev_id: str) -> dict[str, Any]:
    """`GET /v1/iot-service/api/user/device/version` — firmware/update info for one device."""
    resp = requests.get(
        f"{base}/v1/iot-service/api/user/device/version",
        headers=headers,
        params={"dev_id": dev_id},
        timeout=CLOUD_TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json()


def get_device_info(base: str, headers: dict[str, str], dev_id: str) -> dict[str, Any]:
    """`GET /v1/iot-service/api/user/device/info` — detailed device status."""
    resp = requests.get(
        f"{base}/v1/iot-service/api/user/device/info",
        headers=headers,
        params={"dev_id": dev_id},
        timeout=CLOUD_TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json()


def extract_firmware_version(data: dict[str, Any]) -> str | None:
    """Best-effort current-firmware extraction from a device/version response.

    The community docs disagree on the exact shape (see issue #13 upstream),
    so try the known variants and return None rather than guess wrong.
    """
    devices = data.get("devices") or []
    if not devices or not isinstance(devices[0], dict):
        return None
    dev = devices[0]
    direct = dev.get("firmware_version") or dev.get("version")
    if direct:
        return str(direct)
    for item in dev.get("firmware") or []:
        if isinstance(item, dict) and item.get("version"):
            return str(item["version"])
    return None


# ── Cloud print dispatch stages (raw Response — caller owns retry policy) ────


def create_project(base: str, headers: dict[str, str], filename: str) -> requests.Response:
    """`POST /v1/iot-service/api/user/project` — returns project_id + OSS upload_url."""
    return requests.post(
        f"{base}/v1/iot-service/api/user/project",
        json={"name": filename},
        headers=headers,
        timeout=CLOUD_TIMEOUT,
    )


def get_project_detail(base: str, headers: dict[str, str], project_id: str) -> requests.Response:
    """`GET /v1/iot-service/api/user/project/{id}` — profiles + plate thumbnails.

    Bambu's backend parses the uploaded .3mf asynchronously and attaches a
    profile to the project; `/my/task` requires that profile's id.
    """
    return requests.get(
        f"{base}/v1/iot-service/api/user/project/{project_id}",
        headers=headers,
        timeout=CLOUD_TIMEOUT,
    )


def upload_to_oss(upload_url: str, file_bytes: bytes) -> requests.Response:
    """`PUT <presigned OSS url>` — no bearer token, long timeout for big .3mf files."""
    return requests.put(upload_url, data=file_bytes, headers={}, timeout=OSS_UPLOAD_TIMEOUT)


def create_task(base: str, headers: dict[str, str], task_body: dict[str, Any]) -> requests.Response:
    """`POST /v1/user-service/my/task` — cloud pushes the print to the device."""
    return requests.post(
        f"{base}/v1/user-service/my/task",
        json=task_body,
        headers=headers,
        timeout=CLOUD_TIMEOUT,
    )
