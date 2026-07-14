import asyncio
import hashlib
import os
from collections.abc import Callable, Iterable, Iterator, Mapping
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from agent.edge_runtime.artifact_spool import (
    ArtifactDownloadError,
    ArtifactDownloadSpec,
    ArtifactDownloader,
    ArtifactHttpStatusError,
    ArtifactTooLarge,
    UnsafeArtifactSource,
)
from agent.edge_runtime.transfer import (
    DigestMismatch,
    SizeMismatch,
    TransferCancelled,
    TransferExpired,
    TransferError,
    TransferStage,
)


def test_artifact_errors_share_transfer_error_base() -> None:
    assert issubclass(ArtifactDownloadError, TransferError)


@dataclass
class FakeResponse:
    status_code: int
    headers: Mapping[str, str]
    chunks: Callable[[], Iterable[bytes]]
    on_chunk: Callable[[int], None] | None = None
    iterated: bool = False
    max_chunk_size: int = 0
    requested_chunk_size: int | None = None

    async def aiter_bytes(self, chunk_size: int) -> Iterator[bytes]:
        self.iterated = True
        self.requested_chunk_size = chunk_size
        for index, chunk in enumerate(self.chunks()):
            self.max_chunk_size = max(self.max_chunk_size, len(chunk))
            if self.on_chunk is not None:
                self.on_chunk(index)
            yield chunk


@dataclass
class FakeStreamContext:
    response: FakeResponse
    entered: bool = False
    exited: bool = False

    async def __aenter__(self) -> FakeResponse:
        self.entered = True
        return self.response

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        del exc_type, exc, traceback
        self.exited = True


@dataclass
class FakeClient:
    responses: list[FakeResponse]
    requests: list[tuple[str, str, dict[str, str]]] = field(default_factory=list)
    streams: list[FakeStreamContext] = field(default_factory=list)

    def stream(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        follow_redirects: bool,
    ) -> FakeStreamContext:
        assert follow_redirects is False
        self.requests.append((method, url, dict(headers)))
        response = self.responses.pop(0)
        context = FakeStreamContext(response)
        self.streams.append(context)
        return context


def make_spec(
    data: bytes,
    *,
    command_id: str = "command-1",
    file_name: str = "model.gcode",
    expires_at: float | None = None,
) -> ArtifactDownloadSpec:
    return ArtifactDownloadSpec(
        command_id=command_id,
        source_url="https://artifacts.example/model.gcode",
        file_name=file_name,
        expected_size=len(data),
        expected_sha256=hashlib.sha256(data).hexdigest(),
        expires_at=expires_at,
    )


def static_response(data: bytes, *, status_code: int = 200) -> FakeResponse:
    return FakeResponse(
        status_code=status_code,
        headers={"Content-Length": str(len(data))},
        chunks=lambda: (data,),
    )


def test_download_streams_simulated_500mb_in_bounded_chunks(tmp_path: Path) -> None:
    chunk = b"x" * (1024 * 1024)
    chunk_count = 500
    expected_size = len(chunk) * chunk_count
    digest = hashlib.sha256()
    for _ in range(chunk_count):
        digest.update(chunk)

    response = FakeResponse(
        status_code=200,
        headers={"Content-Length": str(expected_size)},
        chunks=lambda: (chunk for _ in range(chunk_count)),
    )
    client = FakeClient([response])
    downloader = ArtifactDownloader(
        tmp_path,
        max_artifact_bytes=expected_size,
        chunk_size=len(chunk),
    )
    spec = ArtifactDownloadSpec(
        command_id="large-command",
        source_url="https://artifacts.example/large.3mf",
        file_name="large.3mf",
        expected_size=expected_size,
        expected_sha256=digest.hexdigest(),
    )

    artifact = asyncio.run(downloader.download(spec, client))

    assert artifact.path.stat().st_size == expected_size
    assert artifact.sha256 == digest.hexdigest()
    assert response.max_chunk_size == len(chunk)
    assert response.requested_chunk_size == len(chunk)
    assert all(context.exited for context in client.streams)
    assert not (tmp_path / "large-command.part").exists()


def test_download_fsyncs_and_atomically_renames_with_transfer_events(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    data = b"G1 X1\nG1 X2\n"
    transitions = []
    fsync_calls: list[int] = []
    replace_calls: list[tuple[Path, Path]] = []
    real_replace = os.replace

    def fsync_spy(file_descriptor: int) -> None:
        fsync_calls.append(file_descriptor)

    def replace_spy(source, destination) -> None:
        source_path = Path(source)
        destination_path = Path(destination)
        assert source_path == tmp_path / "command-1.part"
        assert source_path.exists()
        replace_calls.append((source_path, destination_path))
        real_replace(source_path, destination_path)

    monkeypatch.setattr("agent.edge_runtime.artifact_spool.os.fsync", fsync_spy)
    monkeypatch.setattr("agent.edge_runtime.artifact_spool.os.replace", replace_spy)
    downloader = ArtifactDownloader(
        tmp_path,
        max_artifact_bytes=1024,
        transition_sink=transitions.append,
        clock=lambda: 100.0,
    )

    artifact = asyncio.run(downloader.download(make_spec(data), FakeClient([static_response(data)])))

    assert artifact.path.read_bytes() == data
    assert len(fsync_calls) == 1
    assert replace_calls == [(tmp_path / "command-1.part", artifact.path)]
    assert [transition.stage for transition in transitions] == [
        TransferStage.RECEIVED,
        TransferStage.DOWNLOADING,
        TransferStage.VERIFYING_SOURCE,
        TransferStage.READY,
    ]
    assert "source_url" not in transitions[0].details


def test_download_resumes_only_from_valid_content_range(tmp_path: Path) -> None:
    data = b"ABCDEFG"
    part_path = tmp_path / "command-1.part"
    part_path.write_bytes(data[:3])
    response = FakeResponse(
        status_code=206,
        headers={
            "Content-Length": "4",
            "Content-Range": "bytes 3-6/7",
        },
        chunks=lambda: (data[3:5], data[5:]),
    )
    client = FakeClient([response])
    downloader = ArtifactDownloader(tmp_path, max_artifact_bytes=1024)

    artifact = asyncio.run(downloader.download(make_spec(data), client))

    assert artifact.path.read_bytes() == data
    assert client.requests == [
        (
            "GET",
            "https://artifacts.example/model.gcode",
            {"Accept-Encoding": "identity", "Range": "bytes=3-"},
        )
    ]


def test_download_restarts_from_same_response_when_server_ignores_range(tmp_path: Path) -> None:
    data = b"ABCDEFG"
    (tmp_path / "command-1.part").write_bytes(data[:2])
    client = FakeClient([static_response(data)])
    downloader = ArtifactDownloader(tmp_path, max_artifact_bytes=1024)

    artifact = asyncio.run(downloader.download(make_spec(data), client))

    assert artifact.path.read_bytes() == data
    assert client.requests[0][2]["Range"] == "bytes=2-"
    assert len(client.requests) == 1


def test_download_discards_invalid_content_range_and_retries_without_range(tmp_path: Path) -> None:
    data = b"ABCDEFG"
    (tmp_path / "command-1.part").write_bytes(data[:2])
    invalid_resume = FakeResponse(
        status_code=206,
        headers={
            "Content-Length": "7",
            "Content-Range": "bytes 0-6/7",
        },
        chunks=lambda: (data,),
    )
    full_response = static_response(data)
    client = FakeClient([invalid_resume, full_response])
    downloader = ArtifactDownloader(tmp_path, max_artifact_bytes=1024)

    artifact = asyncio.run(downloader.download(make_spec(data), client))

    assert artifact.path.read_bytes() == data
    assert client.requests[0][2]["Range"] == "bytes=2-"
    assert "Range" not in client.requests[1][2]
    assert not invalid_resume.iterated
    assert all(context.exited for context in client.streams)


@pytest.mark.parametrize(
    ("body", "expected_size", "expected_sha256", "error_type"),
    [
        (b"short", 10, hashlib.sha256(b"short").hexdigest(), SizeMismatch),
        (b"too-long", 3, hashlib.sha256(b"too").hexdigest(), SizeMismatch),
        (b"same-size", 9, "0" * 64, DigestMismatch),
    ],
)
def test_download_removes_truncated_or_corrupt_part(
    tmp_path: Path,
    body: bytes,
    expected_size: int,
    expected_sha256: str,
    error_type: type[Exception],
) -> None:
    response = FakeResponse(
        status_code=200,
        headers={},
        chunks=lambda: (body,),
    )
    spec = ArtifactDownloadSpec(
        command_id="command-1",
        source_url="https://artifacts.example/model.gcode",
        file_name="model.gcode",
        expected_size=expected_size,
        expected_sha256=expected_sha256,
    )
    transitions = []
    downloader = ArtifactDownloader(
        tmp_path,
        max_artifact_bytes=1024,
        transition_sink=transitions.append,
    )

    with pytest.raises(error_type):
        asyncio.run(downloader.download(spec, FakeClient([response])))

    assert list(tmp_path.iterdir()) == []
    assert transitions[-1].stage is TransferStage.FAILED


def test_download_cancels_between_chunks_and_removes_part(tmp_path: Path) -> None:
    data = b"firstsecond"
    cancelled = False

    def cancel_after_first_chunk(index: int) -> None:
        nonlocal cancelled
        if index == 0:
            cancelled = True

    response = FakeResponse(
        status_code=200,
        headers={"Content-Length": str(len(data))},
        chunks=lambda: (b"first", b"second"),
        on_chunk=cancel_after_first_chunk,
    )
    transitions = []
    downloader = ArtifactDownloader(
        tmp_path,
        max_artifact_bytes=1024,
        transition_sink=transitions.append,
    )

    with pytest.raises(TransferCancelled):
        asyncio.run(
            downloader.download(
                make_spec(data),
                FakeClient([response]),
                is_cancelled=lambda: cancelled,
            )
        )

    assert list(tmp_path.iterdir()) == []
    assert transitions[-1].stage is TransferStage.CANCELLED


def test_download_rejects_expired_artifact_before_http(tmp_path: Path) -> None:
    client = FakeClient([])
    downloader = ArtifactDownloader(
        tmp_path,
        max_artifact_bytes=1024,
        clock=lambda: 200.0,
    )

    with pytest.raises(TransferExpired):
        asyncio.run(downloader.download(make_spec(b"data", expires_at=200.0), client))

    assert client.requests == []
    assert list(tmp_path.iterdir()) == []


def test_download_enforces_artifact_limit_and_quota_before_http(tmp_path: Path) -> None:
    data = b"12345"
    client = FakeClient([])
    quota_calls = []

    def quota_hook(*, command_id: str, bytes_required: int, staging_dir: Path) -> None:
        quota_calls.append((command_id, bytes_required, staging_dir))

    downloader = ArtifactDownloader(
        tmp_path,
        max_artifact_bytes=4,
        quota_hook=quota_hook,
    )

    with pytest.raises(ArtifactTooLarge):
        asyncio.run(downloader.download(make_spec(data), client))

    assert quota_calls == []
    assert client.requests == []

    def quota_hook_raises(*, command_id: str, bytes_required: int, staging_dir: Path) -> None:
        del command_id, bytes_required, staging_dir
        raise RuntimeError("quota denied")

    with pytest.raises(RuntimeError, match="quota denied"):
        denied = ArtifactDownloader(
            tmp_path,
            max_artifact_bytes=len(data),
            quota_hook=quota_hook_raises,
        )
        asyncio.run(denied.download(make_spec(data), client))

    assert client.requests == []


def test_download_applies_source_policy_and_rejects_insecure_default(tmp_path: Path) -> None:
    data = b"data"
    client = FakeClient([])
    seen_urls: list[str] = []

    def allowlist(source_url: str) -> None:
        seen_urls.append(source_url)
        raise UnsafeArtifactSource("host is not allowlisted")

    downloader = ArtifactDownloader(
        tmp_path,
        max_artifact_bytes=1024,
        source_policy=allowlist,
    )
    with pytest.raises(UnsafeArtifactSource, match="allowlisted"):
        asyncio.run(downloader.download(make_spec(data), client))

    insecure = ArtifactDownloadSpec(
        command_id="command-2",
        source_url="http://artifacts.example/model.gcode",
        file_name="model.gcode",
        expected_size=len(data),
        expected_sha256=hashlib.sha256(data).hexdigest(),
    )
    with pytest.raises(UnsafeArtifactSource, match="HTTPS"):
        asyncio.run(
            ArtifactDownloader(tmp_path, max_artifact_bytes=1024).download(insecure, client)
        )

    assert seen_urls == ["https://artifacts.example/model.gcode"]
    assert client.requests == []


@pytest.mark.parametrize(
    ("command_id", "file_name"),
    [
        ("../command", "model.gcode"),
        ("command/child", "model.gcode"),
        ("command\\child", "model.gcode"),
        ("command-1", "../model.gcode"),
        ("command-1", "folder/model.gcode"),
        ("command-1", "folder\\model.gcode"),
        ("command-1", "NUL.gcode"),
        ("command-1", "model:gcode"),
        ("command-1", "model.gcode "),
        ("a" * 129, "model.gcode"),
    ],
)
def test_artifact_spec_rejects_unsafe_command_or_file_path(
    command_id: str,
    file_name: str,
) -> None:
    with pytest.raises(ValueError):
        ArtifactDownloadSpec(
            command_id=command_id,
            source_url="https://artifacts.example/model.gcode",
            file_name=file_name,
            expected_size=4,
            expected_sha256=hashlib.sha256(b"data").hexdigest(),
        )


def test_download_rejects_http_error_and_removes_partial(tmp_path: Path) -> None:
    (tmp_path / "command-1.part").write_bytes(b"old")
    response = FakeResponse(status_code=503, headers={}, chunks=lambda: ())
    downloader = ArtifactDownloader(tmp_path, max_artifact_bytes=1024)

    with pytest.raises(ArtifactHttpStatusError, match="503"):
        asyncio.run(downloader.download(make_spec(b"data"), FakeClient([response])))

    assert list(tmp_path.iterdir()) == []
