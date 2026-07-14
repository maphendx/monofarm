import base64
import hashlib
import json
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from app.services.agent_updates import (
    RELEASE_ATTESTATION_ALGORITHM,
    RELEASE_ATTESTATION_PLATFORM,
    RELEASE_ATTESTATION_SCHEMA_VERSION,
    verify_windows_release_attestation,
    windows_release_object_key,
)


def _keypair() -> tuple[str, bytes]:
    private = Ed25519PrivateKey.generate()
    private_bytes = private.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_bytes = private.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return base64.b64encode(private_bytes).decode("ascii"), public_bytes


def _release_metadata(
    private_key_b64: str,
    *,
    version: str = "0.9.0",
    size: int = 42,
    sha256: str = "a" * 64,
) -> tuple[dict[str, str], str]:
    private_key = Ed25519PrivateKey.from_private_bytes(base64.b64decode(private_key_b64))
    public_key = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    object_key = f"agent/releases/{version}/monofarm-agent.exe"
    attestation = {
        "schema_version": RELEASE_ATTESTATION_SCHEMA_VERSION,
        "algorithm": RELEASE_ATTESTATION_ALGORITHM,
        "key_id": hashlib.sha256(public_key).hexdigest()[:16],
        "object_key": object_key,
        "version": version,
        "platform": RELEASE_ATTESTATION_PLATFORM,
        "size": size,
        "sha256": sha256,
    }
    canonical = json.dumps(
        attestation,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    metadata = {name: str(value) for name, value in attestation.items()}
    metadata["signature"] = base64.b64encode(private_key.sign(canonical)).decode("ascii")
    return metadata, object_key


def test_windows_release_attestation_binds_immutable_object_and_content() -> None:
    private_key, public_key = _keypair()
    metadata, object_key = _release_metadata(private_key)

    verified = verify_windows_release_attestation(
        object_key=object_key,
        content_length=42,
        metadata=metadata,
        expected_version="0.9.0",
        public_key_b64=base64.b64encode(public_key).decode("ascii"),
    )

    assert verified == {
        "object_key": object_key,
        "version": "0.9.0",
        "platform": "windows-x86_64",
        "size": 42,
        "sha256": "a" * 64,
    }


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("schema_version", "2"),
        ("algorithm", "ed25519"),
        ("key_id", "0" * 16),
        ("object_key", "agent/monofarm-agent.exe"),
        ("version", "0.9.1"),
        ("platform", "windows-arm64"),
        ("size", "43"),
        ("sha256", "b" * 64),
        ("signature", base64.b64encode(b"x" * 64).decode("ascii")),
    ],
)
def test_windows_release_attestation_rejects_tampered_metadata(
    field: str,
    value: str,
) -> None:
    private_key, public_key = _keypair()
    metadata, object_key = _release_metadata(private_key)
    metadata[field] = value

    with pytest.raises(ValueError):
        verify_windows_release_attestation(
            object_key=object_key,
            content_length=42,
            metadata=metadata,
            expected_version="0.9.0",
            public_key_b64=base64.b64encode(public_key).decode("ascii"),
        )


def test_windows_release_attestation_rejects_blob_size_or_schema_drift() -> None:
    private_key, public_key = _keypair()
    metadata, object_key = _release_metadata(private_key)

    with pytest.raises(ValueError):
        verify_windows_release_attestation(
            object_key=object_key,
            content_length=41,
            metadata=metadata,
            expected_version="0.9.0",
            public_key_b64=base64.b64encode(public_key).decode("ascii"),
        )

    metadata["untrusted"] = "value"
    with pytest.raises(ValueError):
        verify_windows_release_attestation(
            object_key=object_key,
            content_length=42,
            metadata=metadata,
            expected_version="0.9.0",
            public_key_b64=base64.b64encode(public_key).decode("ascii"),
        )


@pytest.mark.parametrize("version", ["0.9", "v0.9.0", "0.9.0/other", "01.2.3"])
def test_windows_release_key_rejects_non_semver_versions(version: str) -> None:
    with pytest.raises(ValueError):
        windows_release_object_key(version)
