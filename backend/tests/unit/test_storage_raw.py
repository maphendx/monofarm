import io

import pytest

from app.core.config import settings
from app.services import storage


class _HeadClient:
    def __init__(self, response=None, error=None) -> None:
        self.response = response
        self.error = error
        self.calls = []

    def head_object(self, **kwargs):
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return self.response


class _GetClient:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.calls = []

    def get_object(self, **kwargs):
        self.calls.append(kwargs)
        return {"ContentLength": len(self.data), "Body": io.BytesIO(self.data)}


def test_get_raw_object_bytes_is_bounded(monkeypatch) -> None:
    client = _GetClient(b"signed-manifest")
    monkeypatch.setattr(storage, "is_s3", lambda: True)
    monkeypatch.setattr(storage, "_client", lambda: client)
    monkeypatch.setattr(settings, "S3_BUCKET", "releases")

    assert storage.get_raw_object_bytes("agent/releases/0.9.0/manifest.json", 64) == (
        b"signed-manifest"
    )
    with pytest.raises(ValueError, match="size limit"):
        storage.get_raw_object_bytes("agent/releases/0.9.0/manifest.json", 4)


def test_head_raw_object_returns_normalized_release_metadata(monkeypatch) -> None:
    client = _HeadClient(
        {
            "ContentLength": 42,
            "Metadata": {
                "Sha256": "A" * 64,
                "Version": "0.8.10",
            },
        }
    )
    monkeypatch.setattr(storage, "is_s3", lambda: True)
    monkeypatch.setattr(storage, "_client", lambda: client)
    monkeypatch.setattr(settings, "S3_BUCKET", "releases")

    metadata = storage.head_raw_object("agent/releases/0.8.10/monofarm-agent.exe")

    assert metadata == {
        "key": "agent/releases/0.8.10/monofarm-agent.exe",
        "size": 42,
        "metadata": {
            "sha256": "A" * 64,
            "version": "0.8.10",
        },
    }
    assert client.calls == [
        {
            "Bucket": "releases",
            "Key": "agent/releases/0.8.10/monofarm-agent.exe",
        }
    ]


def test_head_raw_object_does_not_trust_or_interpret_release_metadata(monkeypatch) -> None:
    client = _HeadClient({"ContentLength": 42, "Metadata": {"sha256": "invalid"}})
    monkeypatch.setattr(storage, "is_s3", lambda: True)
    monkeypatch.setattr(storage, "_client", lambda: client)
    monkeypatch.setattr(settings, "S3_BUCKET", "releases")

    assert storage.head_raw_object("agent/releases/0.8.10/monofarm-agent.exe") == {
        "key": "agent/releases/0.8.10/monofarm-agent.exe",
        "size": 42,
        "metadata": {"sha256": "invalid"},
    }


def test_head_raw_object_fails_closed_for_empty_release(monkeypatch) -> None:
    client = _HeadClient(
        {"ContentLength": 0, "Metadata": {"sha256": "a" * 64}}
    )
    monkeypatch.setattr(storage, "is_s3", lambda: True)
    monkeypatch.setattr(storage, "_client", lambda: client)
    monkeypatch.setattr(settings, "S3_BUCKET", "releases")

    assert storage.head_raw_object("agent/releases/0.8.10/monofarm-agent.exe") is None


def test_head_raw_object_returns_none_when_head_fails(monkeypatch) -> None:
    client = _HeadClient(error=RuntimeError("R2 unavailable"))
    monkeypatch.setattr(storage, "is_s3", lambda: True)
    monkeypatch.setattr(storage, "_client", lambda: client)
    monkeypatch.setattr(settings, "S3_BUCKET", "releases")

    assert storage.head_raw_object("agent/releases/0.8.10/monofarm-agent.exe") is None
