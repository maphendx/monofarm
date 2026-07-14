"""Signed, downgrade-safe update manifest verification for Monofarm Agent."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


_VERSION_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_MAX_CLOCK_SKEW = timedelta(minutes=5)
_MAX_ARTIFACT_SIZE = 2 * 1024 * 1024 * 1024
RELEASE_MANIFEST_SCHEMA_VERSION = 2
RELEASE_MANIFEST_ALGORITHM = "Ed25519"
BUILTIN_RELEASE_PUBLIC_KEY = "2Doaw17ATYHVEEIT9VAVb2Y3HInyNM8sesvLU9Uz33M="
RELEASE_SOURCE_FILES = frozenset(
    {
        "monofarm_agent.py",
        "monofarm_tray.py",
        "command_worker.py",
        "command_runtime.py",
        "device_identity.py",
        "network_policy.py",
        "printer_runtime.py",
        "provider_adapters.py",
        "update_policy.py",
        "requirements.txt",
        "edge_runtime/__init__.py",
        "edge_runtime/adapters.py",
        "edge_runtime/artifact_spool.py",
        "edge_runtime/journal.py",
        "edge_runtime/registry.py",
        "edge_runtime/transfer.py",
    }
)
EXPECTED_RELEASE_ARTIFACTS = frozenset(
    {"windows-x86_64"} | {f"source-{name}" for name in RELEASE_SOURCE_FILES}
)
_MANIFEST_FIELDS = frozenset(
    {
        "schema_version",
        "algorithm",
        "key_id",
        "version",
        "issued_at",
        "expires_at",
        "artifacts",
        "signature",
    }
)


class UpdatePolicyError(ValueError):
    """Raised when an update fails trust, freshness, or integrity checks."""


def _version_tuple(value: str) -> tuple[int, int, int]:
    match = _VERSION_RE.fullmatch(value.strip())
    if match is None:
        raise UpdatePolicyError(f"invalid semantic version: {value!r}")
    return tuple(int(part) for part in match.groups())


def require_newer_version(remote: str, current: str) -> str:
    """Return ``remote`` only when it is a valid, strict upgrade."""

    if _version_tuple(remote) <= _version_tuple(current):
        raise UpdatePolicyError(f"update version {remote} is not newer than {current}")
    return remote


def canonical_manifest_bytes(manifest: dict) -> bytes:
    """Canonical bytes signed by the release key (signature field excluded)."""

    unsigned = {key: value for key, value in manifest.items() if key != "signature"}
    return json.dumps(
        unsigned,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def _parse_timestamp(value: object, field: str) -> datetime:
    if not isinstance(value, str):
        raise UpdatePolicyError(f"manifest {field} is missing")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise UpdatePolicyError(f"manifest {field} is invalid") from exc
    if parsed.tzinfo is None:
        raise UpdatePolicyError(f"manifest {field} must include timezone")
    return parsed.astimezone(timezone.utc)


def _verify_signature(manifest: dict, trusted_public_keys: list[str]) -> str:
    if not trusted_public_keys:
        raise UpdatePolicyError("no trusted update signing key configured")
    signature_text = manifest.get("signature")
    if not isinstance(signature_text, str):
        raise UpdatePolicyError("manifest signature is missing")
    try:
        signature = base64.b64decode(signature_text, validate=True)
    except ValueError as exc:
        raise UpdatePolicyError("manifest signature is invalid") from exc

    payload = canonical_manifest_bytes(manifest)
    for encoded_key in trusted_public_keys:
        try:
            key_bytes = base64.b64decode(encoded_key, validate=True)
            Ed25519PublicKey.from_public_bytes(key_bytes).verify(signature, payload)
            return hashlib.sha256(key_bytes).hexdigest()[:16]
        except (ValueError, InvalidSignature):
            continue
    raise UpdatePolicyError("manifest signature is not trusted")


def _validate_artifacts(value: object) -> None:
    if not isinstance(value, dict) or set(value) != EXPECTED_RELEASE_ARTIFACTS:
        raise UpdatePolicyError("manifest artifact set is incomplete or unexpected")
    for name, artifact in value.items():
        if not isinstance(name, str) or not isinstance(artifact, dict):
            raise UpdatePolicyError("manifest artifact is invalid")
        url = artifact.get("url")
        sha256 = artifact.get("sha256")
        size = artifact.get("size")
        if not isinstance(url, str):
            raise UpdatePolicyError(f"artifact {name} must use HTTPS")
        parsed_url = urlsplit(url)
        if parsed_url.scheme != "https" or not parsed_url.hostname:
            raise UpdatePolicyError(f"artifact {name} must use an absolute HTTPS URL")
        if (
            parsed_url.username is not None
            or parsed_url.password is not None
            or bool(parsed_url.fragment)
        ):
            raise UpdatePolicyError(
                f"artifact {name} URL credentials and fragments are forbidden"
            )
        try:
            parsed_url.port
        except ValueError as exc:
            raise UpdatePolicyError(f"artifact {name} URL port is invalid") from exc
        if not isinstance(sha256, str) or _SHA256_RE.fullmatch(sha256) is None:
            raise UpdatePolicyError(f"artifact {name} SHA-256 is invalid")
        if not isinstance(size, int) or not 0 < size <= _MAX_ARTIFACT_SIZE:
            raise UpdatePolicyError(f"artifact {name} size is invalid")


def verify_signed_manifest(
    manifest: dict,
    *,
    trusted_public_keys: list[str],
    current_version: str,
    now: datetime | None = None,
) -> dict:
    """Verify signature, freshness, downgrade policy, and artifact metadata."""

    if not isinstance(manifest, dict):
        raise UpdatePolicyError("update manifest must be an object")
    if set(manifest) != _MANIFEST_FIELDS:
        raise UpdatePolicyError("update manifest schema is invalid")
    verified_key_id = _verify_signature(manifest, trusted_public_keys)
    if (
        manifest.get("schema_version") != RELEASE_MANIFEST_SCHEMA_VERSION
        or manifest.get("algorithm") != RELEASE_MANIFEST_ALGORITHM
        or manifest.get("key_id") != verified_key_id
    ):
        raise UpdatePolicyError("update manifest signing identity is invalid")
    current_time = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    issued_at = _parse_timestamp(manifest.get("issued_at"), "issued_at")
    expires_at = _parse_timestamp(manifest.get("expires_at"), "expires_at")
    if issued_at > current_time + _MAX_CLOCK_SKEW:
        raise UpdatePolicyError("manifest issued_at is in the future")
    if expires_at <= current_time:
        raise UpdatePolicyError("update manifest expired")
    if expires_at <= issued_at:
        raise UpdatePolicyError("manifest expiry is invalid")
    version = manifest.get("version")
    if not isinstance(version, str):
        raise UpdatePolicyError("manifest version is missing")
    require_newer_version(version, current_version)
    _validate_artifacts(manifest.get("artifacts"))
    return json.loads(json.dumps(manifest))


def verify_artifact_bytes(
    data: bytes,
    *,
    expected_size: int,
    expected_sha256: str,
) -> None:
    """Fail closed unless artifact length and SHA-256 match the signed manifest."""

    if len(data) != expected_size:
        raise UpdatePolicyError(
            f"artifact size mismatch: expected {expected_size}, got {len(data)}"
        )
    actual = hashlib.sha256(data).hexdigest()
    if not hmac.compare_digest(actual, expected_sha256.lower()):
        raise UpdatePolicyError("artifact SHA-256 mismatch")
