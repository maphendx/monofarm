"""Central Bambu Cloud error taxonomy.

Codes are safe to persist, log, expose in API responses, and use as metric tags.
Messages intentionally stay high-level so they do not leak Bambu credentials,
tokens, email codes, signed URLs, or raw cloud response bodies.
"""
from __future__ import annotations

import enum
from typing import Any


class BambuErrorCode(str, enum.Enum):
    AUTH_INVALID = "AUTH_INVALID"
    AUTH_EXPIRED = "AUTH_EXPIRED"
    AUTH_REAUTH_REQUIRED = "AUTH_REAUTH_REQUIRED"
    REGION_MISMATCH = "REGION_MISMATCH"
    DEVICE_NOT_FOUND = "DEVICE_NOT_FOUND"
    DEVICE_OFFLINE = "DEVICE_OFFLINE"
    MQTT_NOT_CONNECTED = "MQTT_NOT_CONNECTED"
    MQTT_ACK_TIMEOUT = "MQTT_ACK_TIMEOUT"
    PROJECT_CREATE_FAILED = "PROJECT_CREATE_FAILED"
    OSS_UPLOAD_FAILED = "OSS_UPLOAD_FAILED"
    TASK_CREATE_FAILED = "TASK_CREATE_FAILED"
    PRINT_FAILED_HMS = "PRINT_FAILED_HMS"
    PRINT_CANCELLED_BY_USER = "PRINT_CANCELLED_BY_USER"
    RETRY_EXHAUSTED = "RETRY_EXHAUSTED"
    INVALID_3MF = "INVALID_3MF"
    IDEMPOTENCY_REPLAY = "IDEMPOTENCY_REPLAY"
    DISPATCH_FAILED = "DISPATCH_FAILED"
    WORKER_DISPATCH_FAILED = "WORKER_DISPATCH_FAILED"
    MOONRAKER_UPLOAD_FAILED = "MOONRAKER_UPLOAD_FAILED"
    FILE_INVALID = "FILE_INVALID"
    PRINTER_NOT_CONFIGURED = "PRINTER_NOT_CONFIGURED"
    AGENT_NOT_CONNECTED = "AGENT_NOT_CONNECTED"
    LAN_UPLOAD_FAILED = "LAN_UPLOAD_FAILED"
    LAN_MQTT_FAILED = "LAN_MQTT_FAILED"


_RETRYABLE = {
    BambuErrorCode.AUTH_EXPIRED,
    BambuErrorCode.MQTT_NOT_CONNECTED,
    BambuErrorCode.PROJECT_CREATE_FAILED,
    BambuErrorCode.OSS_UPLOAD_FAILED,
    BambuErrorCode.TASK_CREATE_FAILED,
    BambuErrorCode.DISPATCH_FAILED,
    BambuErrorCode.WORKER_DISPATCH_FAILED,
    BambuErrorCode.MOONRAKER_UPLOAD_FAILED,
    BambuErrorCode.AGENT_NOT_CONNECTED,
    BambuErrorCode.LAN_UPLOAD_FAILED,
    BambuErrorCode.LAN_MQTT_FAILED,
}

_USER_MESSAGES: dict[BambuErrorCode, str] = {
    BambuErrorCode.AUTH_INVALID: "Bambu Cloud credentials were rejected.",
    BambuErrorCode.AUTH_EXPIRED: "Bambu Cloud session expired before the job completed.",
    BambuErrorCode.AUTH_REAUTH_REQUIRED: "Bambu Cloud account needs to be reconnected.",
    BambuErrorCode.REGION_MISMATCH: "Bambu Cloud region does not match the printer account.",
    BambuErrorCode.DEVICE_NOT_FOUND: "Bambu Cloud printer was not found on this account.",
    BambuErrorCode.DEVICE_OFFLINE: "Bambu printer is offline.",
    BambuErrorCode.MQTT_NOT_CONNECTED: "Printer telemetry stopped before the job finished.",
    BambuErrorCode.MQTT_ACK_TIMEOUT: "Printer did not acknowledge the cloud print task in time.",
    BambuErrorCode.PROJECT_CREATE_FAILED: "Bambu Cloud could not create the print project.",
    BambuErrorCode.OSS_UPLOAD_FAILED: "Bambu Cloud upload failed.",
    BambuErrorCode.TASK_CREATE_FAILED: "Bambu Cloud could not create the printer task.",
    BambuErrorCode.PRINT_FAILED_HMS: "Printer reported a print failure.",
    BambuErrorCode.PRINT_CANCELLED_BY_USER: "Print was cancelled by the user.",
    BambuErrorCode.RETRY_EXHAUSTED: "Bambu Cloud job retry limit was reached.",
    BambuErrorCode.INVALID_3MF: "The selected file is not a valid Bambu Cloud .3mf file.",
    BambuErrorCode.IDEMPOTENCY_REPLAY: "Duplicate print request was collapsed into an existing job.",
    BambuErrorCode.DISPATCH_FAILED: "Bambu Cloud dispatch failed.",
    BambuErrorCode.WORKER_DISPATCH_FAILED: "Bambu Cloud worker failed before dispatch completed.",
    BambuErrorCode.MOONRAKER_UPLOAD_FAILED: "Moonraker upload failed.",
    BambuErrorCode.FILE_INVALID: "The selected file is missing or invalid.",
    BambuErrorCode.PRINTER_NOT_CONFIGURED: "Printer connection is not configured.",
    BambuErrorCode.AGENT_NOT_CONNECTED: "Farm agent is not connected.",
    BambuErrorCode.LAN_UPLOAD_FAILED: "LAN file upload to the printer failed.",
    BambuErrorCode.LAN_MQTT_FAILED: "Printer did not accept the LAN print command.",
}

_TECHNICAL_MESSAGES: dict[BambuErrorCode, str] = {
    BambuErrorCode.AUTH_INVALID: "Bambu auth returned invalid credentials or rejected login.",
    BambuErrorCode.AUTH_EXPIRED: "Bambu auth token expired or was rejected during a cloud request.",
    BambuErrorCode.AUTH_REAUTH_REQUIRED: "Refresh/login/fallback were unable to produce a usable Bambu token.",
    BambuErrorCode.REGION_MISMATCH: "Configured Bambu region does not match the requested account/device region.",
    BambuErrorCode.DEVICE_NOT_FOUND: "Bambu Cloud device lookup did not include the requested printer.",
    BambuErrorCode.DEVICE_OFFLINE: "Bambu Cloud device is unavailable for dispatch.",
    BambuErrorCode.MQTT_NOT_CONNECTED: "No fresh MQTT telemetry arrived for an active cloud job.",
    BambuErrorCode.MQTT_ACK_TIMEOUT: "Task-created job exceeded the MQTT acknowledgement timeout.",
    BambuErrorCode.PROJECT_CREATE_FAILED: "Bambu project creation stage failed.",
    BambuErrorCode.OSS_UPLOAD_FAILED: "Bambu OSS upload stage failed.",
    BambuErrorCode.TASK_CREATE_FAILED: "Bambu task creation stage failed.",
    BambuErrorCode.PRINT_FAILED_HMS: "MQTT report indicated printer failure/HMS fault.",
    BambuErrorCode.PRINT_CANCELLED_BY_USER: "User cancelled the Bambu Cloud job.",
    BambuErrorCode.RETRY_EXHAUSTED: "Worker retry budget was exhausted.",
    BambuErrorCode.INVALID_3MF: "File validation failed before Bambu Cloud dispatch.",
    BambuErrorCode.IDEMPOTENCY_REPLAY: "Idempotency key matched an existing non-terminal job.",
    BambuErrorCode.DISPATCH_FAILED: "Bambu Cloud dispatch failed after retry policy.",
    BambuErrorCode.WORKER_DISPATCH_FAILED: "Worker raised an uncaught exception while dispatching.",
    BambuErrorCode.MOONRAKER_UPLOAD_FAILED: "Moonraker upload/start stage failed.",
    BambuErrorCode.FILE_INVALID: "File validation failed before dispatch.",
    BambuErrorCode.PRINTER_NOT_CONFIGURED: "Printer row is missing required connection fields.",
    BambuErrorCode.AGENT_NOT_CONNECTED: "No agent tunnel was available for a LAN dispatch.",
    BambuErrorCode.LAN_UPLOAD_FAILED: "FTPS upload to the printer failed (agent or direct).",
    BambuErrorCode.LAN_MQTT_FAILED: "LAN MQTT project_file publish failed (check Developer Mode on new firmware).",
}


def normalize_error_code(error_code: BambuErrorCode | str | None) -> str | None:
    if error_code is None:
        return None
    if isinstance(error_code, BambuErrorCode):
        return error_code.value
    try:
        return BambuErrorCode(str(error_code)).value
    except ValueError:
        return str(error_code)


def is_retryable(error_code: BambuErrorCode | str | None) -> bool:
    normalized = normalize_error_code(error_code)
    if normalized is None:
        return False
    try:
        return BambuErrorCode(normalized) in _RETRYABLE
    except ValueError:
        return False


def to_user_message(error_code: BambuErrorCode | str | None) -> str:
    normalized = normalize_error_code(error_code)
    try:
        return _USER_MESSAGES[BambuErrorCode(str(normalized))]
    except (TypeError, ValueError, KeyError):
        return "Bambu Cloud print failed."


def to_technical_message(error_code: BambuErrorCode | str | None) -> str:
    normalized = normalize_error_code(error_code)
    try:
        return _TECHNICAL_MESSAGES[BambuErrorCode(str(normalized))]
    except (TypeError, ValueError, KeyError):
        return "Unclassified Bambu Cloud error."


def error_details(
    error_code: BambuErrorCode | str,
    *,
    retryable: bool | None = None,
    **context: Any,
) -> dict[str, Any]:
    normalized = normalize_error_code(error_code) or str(error_code)
    details = {
        "error_code": normalized,
        "retryable": is_retryable(normalized) if retryable is None else retryable,
    }
    details.update({key: value for key, value in context.items() if value is not None})
    return details
