"""Verify immutable CI-signed Monofarm Agent releases."""

from __future__ import annotations

import base64
import hashlib
import json
import re
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from pathlib import PurePosixPath
from typing import TypedDict
from urllib.parse import quote, urlsplit

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


_VERSION_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_MAX_CLOCK_SKEW = timedelta(minutes=5)
_MAX_SOURCE_ARTIFACT_SIZE = 16 * 1024 * 1024
_MAX_WINDOWS_ARTIFACT_SIZE = 2 * 1024 * 1024 * 1024
RELEASE_ATTESTATION_SCHEMA_VERSION = 1
RELEASE_ATTESTATION_ALGORITHM = "Ed25519"
RELEASE_ATTESTATION_PLATFORM = "windows-x86_64"
RELEASE_MANIFEST_SCHEMA_VERSION = 2
RELEASE_MANIFEST_ALGORITHM = "Ed25519"
_RELEASE_MANIFEST_FIELDS = frozenset(
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
_RELEASE_ATTESTATION_FIELDS = frozenset(
    {
        "schema_version",
        "algorithm",
        "key_id",
        "object_key",
        "version",
        "platform",
        "size",
        "sha256",
    }
)
_RELEASE_METADATA_FIELDS = _RELEASE_ATTESTATION_FIELDS | {"signature"}


class VerifiedWindowsRelease(TypedDict):
    object_key: str
    version: str
    platform: str
    size: int
    sha256: str


def windows_release_object_key(version: str) -> str:
    """Return the immutable object key for one exact Windows release."""

    if _VERSION_RE.fullmatch(version) is None:
        raise ValueError("invalid agent version")
    return f"agent/releases/{version}/monofarm-agent.exe"


def release_manifest_object_key(version: str) -> str:
    if _VERSION_RE.fullmatch(version) is None:
        raise ValueError("invalid agent version")
    return f"agent/releases/{version}/manifest.json"


def release_source_object_key(version: str, filename: str) -> str:
    if _VERSION_RE.fullmatch(version) is None:
        raise ValueError("invalid agent version")
    relative = PurePosixPath(filename)
    if (
        relative.is_absolute()
        or not relative.parts
        or any(part in {"", ".", ".."} for part in relative.parts)
        or "\\" in filename
    ):
        raise ValueError("source release filename must be a safe relative path")
    return f"agent/releases/{version}/runtime/{filename}"


def _load_attestation_public_key(encoded: str) -> tuple[Ed25519PublicKey, bytes]:
    try:
        raw = base64.b64decode(encoded, validate=True)
        return Ed25519PublicKey.from_public_bytes(raw), raw
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid Ed25519 release attestation public key") from exc


def _canonical_release_attestation(attestation: Mapping[str, object]) -> bytes:
    return json.dumps(
        attestation,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def canonical_manifest_bytes(manifest: Mapping[str, object]) -> bytes:
    """Return the strict canonical bytes signed by CI for one release."""

    unsigned = {name: value for name, value in manifest.items() if name != "signature"}
    return json.dumps(
        unsigned,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def _parse_manifest_timestamp(value: object, field: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError(f"release manifest {field} is missing")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"release manifest {field} is invalid") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"release manifest {field} must include timezone")
    return parsed.astimezone(timezone.utc)


def verify_ci_release_manifest(
    manifest: object,
    *,
    expected_version: str,
    base_url: str,
    public_key_b64: str,
    source_files: set[str],
    windows_release: VerifiedWindowsRelease,
    now: datetime | None = None,
) -> dict:
    """Verify and return the immutable full release manifest produced by CI."""

    if not isinstance(manifest, dict) or set(manifest) != _RELEASE_MANIFEST_FIELDS:
        raise ValueError("invalid CI release manifest schema")
    public_key, public_key_raw = _load_attestation_public_key(public_key_b64)
    try:
        signature = base64.b64decode(manifest["signature"], validate=True)
        public_key.verify(signature, canonical_manifest_bytes(manifest))
    except (InvalidSignature, TypeError, ValueError) as exc:
        raise ValueError("invalid CI release manifest signature") from exc

    parsed_base = urlsplit(base_url)
    if parsed_base.scheme != "https" or not parsed_base.hostname:
        raise ValueError("agent update base URL must use HTTPS")
    if _VERSION_RE.fullmatch(expected_version) is None:
        raise ValueError("invalid agent version")
    expected_key_id = hashlib.sha256(public_key_raw).hexdigest()[:16]
    if (
        manifest["schema_version"] != RELEASE_MANIFEST_SCHEMA_VERSION
        or manifest["algorithm"] != RELEASE_MANIFEST_ALGORITHM
        or manifest["key_id"] != expected_key_id
        or manifest["version"] != expected_version
    ):
        raise ValueError("CI release manifest identity does not match")

    current_time = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    issued_at = _parse_manifest_timestamp(manifest["issued_at"], "issued_at")
    expires_at = _parse_manifest_timestamp(manifest["expires_at"], "expires_at")
    if issued_at > current_time + _MAX_CLOCK_SKEW:
        raise ValueError("CI release manifest issued_at is in the future")
    if expires_at <= current_time or expires_at <= issued_at:
        raise ValueError("CI release manifest expiry is invalid")

    artifacts = manifest["artifacts"]
    expected_names = {"windows-x86_64"} | {
        f"source-{filename}" for filename in source_files
    }
    if not isinstance(artifacts, dict) or set(artifacts) != expected_names:
        raise ValueError("CI release manifest artifact set is not exact")

    normalized_base = base_url.rstrip("/")
    for filename in sorted(source_files):
        artifact = artifacts[f"source-{filename}"]
        expected_url = (
            f"{normalized_base}/agent/releases/{expected_version}/runtime/"
            f"{quote(filename, safe='/')}"
        )
        _verify_release_artifact(
            artifact,
            expected_url=expected_url,
            maximum_size=_MAX_SOURCE_ARTIFACT_SIZE,
        )

    windows_artifact = artifacts["windows-x86_64"]
    _verify_release_artifact(
        windows_artifact,
        expected_url=(
            f"{normalized_base}/agent/releases/{expected_version}/monofarm-agent.exe"
        ),
        maximum_size=_MAX_WINDOWS_ARTIFACT_SIZE,
    )
    if (
        windows_release["object_key"] != windows_release_object_key(expected_version)
        or windows_release["version"] != expected_version
        or windows_release["platform"] != RELEASE_ATTESTATION_PLATFORM
        or windows_artifact["size"] != windows_release["size"]
        or windows_artifact["sha256"] != windows_release["sha256"]
    ):
        raise ValueError("CI release manifest Windows artifact does not match attestation")
    return json.loads(json.dumps(manifest))


def _verify_release_artifact(
    artifact: object,
    *,
    expected_url: str,
    maximum_size: int,
) -> None:
    if not isinstance(artifact, dict) or set(artifact) != {"url", "size", "sha256"}:
        raise ValueError("invalid CI release artifact schema")
    if artifact["url"] != expected_url:
        raise ValueError("CI release artifact URL is not immutable")
    size = artifact["size"]
    sha256 = artifact["sha256"]
    if type(size) is not int or not 0 < size <= maximum_size:
        raise ValueError("invalid CI release artifact size")
    if not isinstance(sha256, str) or _SHA256_RE.fullmatch(sha256) is None:
        raise ValueError("invalid CI release artifact SHA-256")


def verify_windows_release_attestation(
    *,
    object_key: str,
    content_length: int,
    metadata: Mapping[str, str],
    expected_version: str,
    public_key_b64: str,
) -> VerifiedWindowsRelease:
    """Verify a CI-signed Windows release attestation from object metadata.

    R2 metadata is attacker-controlled. Only the fixed canonical fields signed
    by the CI-only release key are trusted, and the signed size is bound to the
    actual object HEAD response before the artifact enters the update manifest.
    """

    expected_object_key = windows_release_object_key(expected_version)
    if object_key != expected_object_key:
        raise ValueError("Windows release object key does not match the API version")
    if not isinstance(content_length, int) or content_length <= 0:
        raise ValueError("invalid Windows release content length")
    if set(metadata) != _RELEASE_METADATA_FIELDS or not all(
        isinstance(value, str) for value in metadata.values()
    ):
        raise ValueError("invalid Windows release attestation schema")

    public_key, public_key_raw = _load_attestation_public_key(public_key_b64)
    expected_key_id = hashlib.sha256(public_key_raw).hexdigest()[:16]
    sha256 = metadata["sha256"]
    if (
        metadata["schema_version"] != str(RELEASE_ATTESTATION_SCHEMA_VERSION)
        or metadata["algorithm"] != RELEASE_ATTESTATION_ALGORITHM
        or metadata["key_id"] != expected_key_id
        or metadata["object_key"] != expected_object_key
        or metadata["version"] != expected_version
        or metadata["platform"] != RELEASE_ATTESTATION_PLATFORM
        or metadata["size"] != str(content_length)
        or _SHA256_RE.fullmatch(sha256) is None
    ):
        raise ValueError("Windows release attestation does not match the object")

    attestation = {
        "schema_version": RELEASE_ATTESTATION_SCHEMA_VERSION,
        "algorithm": RELEASE_ATTESTATION_ALGORITHM,
        "key_id": expected_key_id,
        "object_key": expected_object_key,
        "version": expected_version,
        "platform": RELEASE_ATTESTATION_PLATFORM,
        "size": content_length,
        "sha256": sha256,
    }
    try:
        signature = base64.b64decode(metadata["signature"], validate=True)
        public_key.verify(signature, _canonical_release_attestation(attestation))
    except (InvalidSignature, TypeError, ValueError) as exc:
        raise ValueError("invalid Windows release attestation signature") from exc

    return {
        "object_key": expected_object_key,
        "version": expected_version,
        "platform": RELEASE_ATTESTATION_PLATFORM,
        "size": content_length,
        "sha256": sha256,
    }
