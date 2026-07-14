import base64
import hashlib
import json
from datetime import datetime, timezone

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from app.api import agent as agent_api
from app.core.config import settings
from app.services import storage
from app.services.agent_updates import (
    RELEASE_ATTESTATION_ALGORITHM,
    RELEASE_ATTESTATION_PLATFORM,
    RELEASE_ATTESTATION_SCHEMA_VERSION,
    RELEASE_MANIFEST_ALGORITHM,
    RELEASE_MANIFEST_SCHEMA_VERSION,
    canonical_manifest_bytes,
    release_manifest_object_key,
    release_source_object_key,
    windows_release_object_key,
)


def _release_fixture() -> tuple[str, dict, bytes, dict[str, dict]]:
    private = Ed25519PrivateKey.generate()
    public = private.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    public_b64 = base64.b64encode(public).decode("ascii")
    key_id = hashlib.sha256(public).hexdigest()[:16]
    version = agent_api.AGENT_VERSION
    source_heads: dict[str, dict] = {}
    artifacts: dict[str, dict] = {}
    for filename in agent_api._AGENT_SOURCE_FILES:
        data = filename.encode("utf-8")
        sha256 = hashlib.sha256(data).hexdigest()
        object_key = release_source_object_key(version, filename)
        source_heads[object_key] = {
            "key": object_key,
            "size": len(data),
            "metadata": {"version": version, "sha256": sha256},
        }
        artifacts[f"source-{filename}"] = {
            "url": f"https://api.monofarm.app/agent/releases/{version}/runtime/{filename}",
            "size": len(data),
            "sha256": sha256,
        }

    windows_key = windows_release_object_key(version)
    windows_attestation = {
        "schema_version": RELEASE_ATTESTATION_SCHEMA_VERSION,
        "algorithm": RELEASE_ATTESTATION_ALGORITHM,
        "key_id": key_id,
        "object_key": windows_key,
        "version": version,
        "platform": RELEASE_ATTESTATION_PLATFORM,
        "size": 42,
        "sha256": "a" * 64,
    }
    windows_canonical = json.dumps(
        windows_attestation,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    windows_metadata = {name: str(value) for name, value in windows_attestation.items()}
    windows_metadata["signature"] = base64.b64encode(
        private.sign(windows_canonical)
    ).decode("ascii")
    source_heads[windows_key] = {
        "key": windows_key,
        "size": 42,
        "metadata": windows_metadata,
    }
    artifacts["windows-x86_64"] = {
        "url": f"https://api.monofarm.app/agent/releases/{version}/monofarm-agent.exe",
        "size": 42,
        "sha256": "a" * 64,
    }
    manifest = {
        "schema_version": RELEASE_MANIFEST_SCHEMA_VERSION,
        "algorithm": RELEASE_MANIFEST_ALGORITHM,
        "key_id": key_id,
        "version": version,
        "issued_at": datetime.now(timezone.utc).isoformat(),
        "expires_at": "9999-12-31T23:59:59+00:00",
        "artifacts": artifacts,
    }
    manifest["signature"] = base64.b64encode(
        private.sign(canonical_manifest_bytes(manifest))
    ).decode("ascii")
    return public_b64, manifest, json.dumps(manifest).encode("utf-8"), source_heads


def _configure_release(monkeypatch, public_key: str, raw: bytes, heads: dict) -> None:
    monkeypatch.setattr(settings, "AGENT_UPDATE_BASE_URL", "https://api.monofarm.app")
    monkeypatch.setattr(agent_api, "_release_public_key", lambda: public_key)
    monkeypatch.setattr(storage, "get_raw_object_bytes", lambda key, limit: raw)
    monkeypatch.setattr(storage, "head_raw_object", lambda key: heads.get(key))


def test_version_endpoint_serves_verified_ci_manifest_verbatim(monkeypatch) -> None:
    public_key, manifest, raw, heads = _release_fixture()
    _configure_release(monkeypatch, public_key, raw, heads)

    payload = agent_api.agent_version()

    assert payload["manifest"] == manifest
    assert payload["update_public_key"] == public_key


def test_version_endpoint_rejects_tampered_ci_manifest(monkeypatch) -> None:
    public_key, _manifest, raw, heads = _release_fixture()
    tampered = json.loads(raw)
    tampered["artifacts"]["source-monofarm_agent.py"]["sha256"] = "b" * 64
    _configure_release(monkeypatch, public_key, json.dumps(tampered).encode(), heads)

    payload = agent_api.agent_version()

    assert payload["manifest"] is None
    assert payload["update_public_key"] is None


def test_version_endpoint_fails_closed_without_ci_public_key(monkeypatch) -> None:
    monkeypatch.setattr(settings, "AGENT_UPDATE_BASE_URL", "https://api.monofarm.app")
    monkeypatch.setattr(agent_api, "_release_public_key", lambda: None)
    monkeypatch.setattr(
        storage,
        "get_raw_object_bytes",
        lambda *_args: (_ for _ in ()).throw(AssertionError("must not read R2")),
    )

    payload = agent_api.agent_version()

    assert payload["manifest"] is None
    assert payload["update_public_key"] is None


def test_release_download_presigns_only_manifest_artifact_keys(monkeypatch) -> None:
    public_key, _manifest, raw, heads = _release_fixture()
    _configure_release(monkeypatch, public_key, raw, heads)
    calls: list[str] = []
    monkeypatch.setattr(
        storage,
        "presigned_url_raw",
        lambda key, expires=3600: calls.append(key) or f"https://r2.example/{key}?sig=x",
    )

    source_url = agent_api.agent_release_download_url(
        agent_api.AGENT_VERSION,
        "source-edge_runtime/journal.py",
    )
    windows_url = agent_api.agent_windows_download_url()

    assert calls == [
        release_source_object_key(agent_api.AGENT_VERSION, "edge_runtime/journal.py"),
        windows_release_object_key(agent_api.AGENT_VERSION),
    ]
    assert source_url and "/runtime/edge_runtime/journal.py" in source_url
    assert windows_url and windows_url.endswith("monofarm-agent.exe?sig=x")


def test_release_download_has_no_unknown_or_old_version_fallback(monkeypatch) -> None:
    public_key, _manifest, raw, heads = _release_fixture()
    _configure_release(monkeypatch, public_key, raw, heads)
    monkeypatch.setattr(
        storage,
        "presigned_url_raw",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("must not presign")),
    )

    assert agent_api.agent_release_download_url("0.8.10", "windows-x86_64") is None
    assert agent_api.agent_release_download_url(agent_api.AGENT_VERSION, "source-evil.py") is None


def test_manifest_object_key_is_versioned() -> None:
    assert release_manifest_object_key(agent_api.AGENT_VERSION) == (
        f"agent/releases/{agent_api.AGENT_VERSION}/manifest.json"
    )
