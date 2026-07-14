import base64
import hashlib
import json
from datetime import datetime, timezone

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from app.services.agent_updates import (
    RELEASE_MANIFEST_ALGORITHM,
    RELEASE_MANIFEST_SCHEMA_VERSION,
    canonical_manifest_bytes,
    release_manifest_object_key,
    release_source_object_key,
    verify_ci_release_manifest,
)


SOURCE_FILES = {"monofarm_agent.py", "edge_runtime/journal.py"}
VERSION = "0.9.0"
BASE_URL = "https://api.monofarm.app"


def _keypair() -> tuple[Ed25519PrivateKey, str, str]:
    private = Ed25519PrivateKey.generate()
    public = private.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return (
        private,
        base64.b64encode(public).decode("ascii"),
        hashlib.sha256(public).hexdigest()[:16],
    )


def _signed_manifest(
    private: Ed25519PrivateKey,
    key_id: str,
    *,
    source_files: set[str] = SOURCE_FILES,
) -> dict:
    artifacts = {
        f"source-{filename}": {
            "url": f"{BASE_URL}/agent/releases/{VERSION}/runtime/{filename}",
            "size": len(filename.encode("utf-8")),
            "sha256": hashlib.sha256(filename.encode("utf-8")).hexdigest(),
        }
        for filename in source_files
    }
    artifacts["windows-x86_64"] = {
        "url": f"{BASE_URL}/agent/releases/{VERSION}/monofarm-agent.exe",
        "size": 42,
        "sha256": "a" * 64,
    }
    manifest = {
        "schema_version": RELEASE_MANIFEST_SCHEMA_VERSION,
        "algorithm": RELEASE_MANIFEST_ALGORITHM,
        "key_id": key_id,
        "version": VERSION,
        "issued_at": datetime.now(timezone.utc).isoformat(),
        "expires_at": "9999-12-31T23:59:59+00:00",
        "artifacts": artifacts,
    }
    manifest["signature"] = base64.b64encode(
        private.sign(canonical_manifest_bytes(manifest))
    ).decode("ascii")
    return manifest


def test_backend_verifies_ci_manifest_without_a_release_private_key() -> None:
    private, public_key, key_id = _keypair()
    manifest = _signed_manifest(private, key_id)

    verified = verify_ci_release_manifest(
        manifest,
        expected_version=VERSION,
        base_url=BASE_URL,
        public_key_b64=public_key,
        source_files=SOURCE_FILES,
        windows_release={
            "object_key": f"agent/releases/{VERSION}/monofarm-agent.exe",
            "version": VERSION,
            "platform": "windows-x86_64",
            "size": 42,
            "sha256": "a" * 64,
        },
    )

    assert verified == manifest
    assert release_manifest_object_key(VERSION) == f"agent/releases/{VERSION}/manifest.json"
    assert release_source_object_key(VERSION, "edge_runtime/journal.py") == (
        f"agent/releases/{VERSION}/runtime/edge_runtime/journal.py"
    )


def test_backend_rejects_tampered_ci_manifest() -> None:
    private, public_key, key_id = _keypair()
    manifest = _signed_manifest(private, key_id)
    manifest["artifacts"]["source-monofarm_agent.py"]["sha256"] = "b" * 64

    with pytest.raises(ValueError, match="signature"):
        verify_ci_release_manifest(
            manifest,
            expected_version=VERSION,
            base_url=BASE_URL,
            public_key_b64=public_key,
            source_files=SOURCE_FILES,
            windows_release={
                "object_key": f"agent/releases/{VERSION}/monofarm-agent.exe",
                "version": VERSION,
                "platform": "windows-x86_64",
                "size": 42,
                "sha256": "a" * 64,
            },
        )


@pytest.mark.parametrize(
    "mutation",
    ("missing-source", "extra-artifact", "mutable-url", "windows-digest"),
)
def test_backend_rejects_resigned_manifest_outside_exact_release_contract(
    mutation: str,
) -> None:
    private, public_key, key_id = _keypair()
    manifest = _signed_manifest(private, key_id)
    if mutation == "missing-source":
        manifest["artifacts"].pop("source-edge_runtime/journal.py")
    elif mutation == "extra-artifact":
        manifest["artifacts"]["source-unexpected.py"] = {
            "url": f"{BASE_URL}/agent/releases/{VERSION}/runtime/unexpected.py",
            "size": 1,
            "sha256": "b" * 64,
        }
    elif mutation == "mutable-url":
        manifest["artifacts"]["source-monofarm_agent.py"]["url"] = (
            f"{BASE_URL}/agent/runtime/monofarm_agent.py"
        )
    else:
        manifest["artifacts"]["windows-x86_64"]["sha256"] = "b" * 64
    manifest["signature"] = base64.b64encode(
        private.sign(canonical_manifest_bytes(manifest))
    ).decode("ascii")

    with pytest.raises(ValueError):
        verify_ci_release_manifest(
            manifest,
            expected_version=VERSION,
            base_url=BASE_URL,
            public_key_b64=public_key,
            source_files=SOURCE_FILES,
            windows_release={
                "object_key": f"agent/releases/{VERSION}/monofarm-agent.exe",
                "version": VERSION,
                "platform": "windows-x86_64",
                "size": 42,
                "sha256": "a" * 64,
            },
        )


def test_ci_manifest_is_json_round_trip_stable() -> None:
    private, _public_key, key_id = _keypair()
    manifest = _signed_manifest(private, key_id)

    assert json.loads(json.dumps(manifest)) == manifest
