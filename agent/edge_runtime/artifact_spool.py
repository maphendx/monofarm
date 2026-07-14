"""Bounded-memory HTTP artifact download into the edge runtime spool."""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import stat
import time
from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlsplit

from .adapters import LocalArtifact
from .transfer import (
    DigestMismatch,
    QuotaHook,
    SizeMismatch,
    TransferCancelled,
    TransferError,
    TransferExpired,
    TransferStage,
    TransferTransition,
    TransitionSink,
)

_COMMAND_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\Z")
_CONTENT_RANGE_PATTERN = re.compile(r"bytes\s+(\d+)-(\d+)/(\d+)\Z", re.IGNORECASE)
_INVALID_FILE_NAME_CHARACTERS = frozenset('<>:"/\\|?*')
_WINDOWS_DEVICE_NAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{number}" for number in range(1, 10)}
    | {f"LPT{number}" for number in range(1, 10)}
)


class AsyncHttpResponse(Protocol):
    status_code: int
    headers: Mapping[str, str]

    def aiter_bytes(self, chunk_size: int) -> AsyncIterator[bytes]: ...


class AsyncHttpStream(Protocol):
    async def __aenter__(self) -> AsyncHttpResponse: ...

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: object | None,
    ) -> None: ...


class AsyncHttpClient(Protocol):
    def stream(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        follow_redirects: bool,
    ) -> AsyncHttpStream: ...


class SourcePolicy(Protocol):
    def __call__(self, source_url: str) -> None: ...


@dataclass(frozen=True, slots=True)
class ArtifactDownloadSpec:
    command_id: str
    source_url: str
    file_name: str
    expected_size: int
    expected_sha256: str
    expires_at: float | None = None

    def __post_init__(self) -> None:
        if len(self.command_id) > 128 or not _COMMAND_ID_PATTERN.fullmatch(self.command_id):
            raise ValueError("command_id must contain only safe path characters")
        device_stem = self.file_name.split(".", maxsplit=1)[0].upper()
        if not _is_safe_file_name(self.file_name) or device_stem in _WINDOWS_DEVICE_NAMES:
            raise ValueError("file_name must be a plain file name")
        if not self.source_url or "\x00" in self.source_url:
            raise ValueError("source_url cannot be empty")
        if self.expected_size < 0:
            raise ValueError("expected_size cannot be negative")

        normalized_sha256 = self.expected_sha256.lower()
        if len(normalized_sha256) != 64 or any(
            character not in "0123456789abcdef" for character in normalized_sha256
        ):
            raise ValueError("expected_sha256 must be a 64-character hexadecimal digest")
        object.__setattr__(self, "expected_sha256", normalized_sha256)


class ArtifactDownloadError(TransferError):
    pass


class ArtifactHttpStatusError(ArtifactDownloadError):
    pass


class ArtifactTooLarge(ArtifactDownloadError):
    pass


class UnsafeArtifactSource(ArtifactDownloadError):
    pass


class UnsafeArtifactPath(ArtifactDownloadError):
    pass


def require_https_artifact_source(source_url: str) -> None:
    parsed = urlsplit(source_url)
    if parsed.scheme.lower() != "https" or not parsed.hostname:
        raise UnsafeArtifactSource("artifact source must be an absolute HTTPS URL")
    if parsed.username is not None or parsed.password is not None:
        raise UnsafeArtifactSource("artifact source URL must not contain credentials")


class ArtifactDownloader:
    def __init__(
        self,
        spool_dir: str | Path,
        *,
        max_artifact_bytes: int,
        quota_hook: QuotaHook | None = None,
        transition_sink: TransitionSink | None = None,
        source_policy: SourcePolicy | None = None,
        clock: Callable[[], float] = time.time,
        chunk_size: int = 64 * 1024,
    ) -> None:
        if max_artifact_bytes < 0:
            raise ValueError("max_artifact_bytes cannot be negative")
        if chunk_size <= 0:
            raise ValueError("chunk_size must be positive")

        self.spool_dir = Path(spool_dir)
        self.spool_dir.mkdir(parents=True, exist_ok=True)
        self.max_artifact_bytes = max_artifact_bytes
        self.chunk_size = chunk_size
        self._quota_hook = quota_hook
        self._transition_sink = transition_sink
        self._source_policy = source_policy
        self._clock = clock

    async def download(
        self,
        spec: ArtifactDownloadSpec,
        client: AsyncHttpClient,
        *,
        is_cancelled: Callable[[], bool] | None = None,
    ) -> LocalArtifact:
        part_path, final_path = self._artifact_paths(spec)
        replaced = False
        self._emit(spec.command_id, TransferStage.RECEIVED)

        try:
            self._check_cancelled(is_cancelled)
            self._check_expiry(spec)
            require_https_artifact_source(spec.source_url)
            if self._source_policy is not None:
                self._source_policy(spec.source_url)
            if spec.expected_size > self.max_artifact_bytes:
                raise ArtifactTooLarge(
                    f"artifact is {spec.expected_size} bytes; limit is {self.max_artifact_bytes}"
                )
            if self._quota_hook is not None:
                self._quota_hook(
                    command_id=spec.command_id,
                    bytes_required=spec.expected_size,
                    staging_dir=self.spool_dir,
                )

            resume_from = self._partial_size(part_path)
            if resume_from >= spec.expected_size:
                part_path.unlink(missing_ok=True)
                resume_from = 0

            self._emit(
                spec.command_id,
                TransferStage.DOWNLOADING,
                expected_size=spec.expected_size,
                resume_from=resume_from,
            )
            received_size, actual_sha256 = await self._download_to_part(
                spec,
                client,
                part_path,
                resume_from=resume_from,
                is_cancelled=is_cancelled,
            )

            self._emit(
                spec.command_id,
                TransferStage.VERIFYING_SOURCE,
                received_size=received_size,
            )
            if received_size != spec.expected_size:
                raise SizeMismatch(f"expected {spec.expected_size} bytes, received {received_size}")
            if not hmac.compare_digest(actual_sha256, spec.expected_sha256):
                raise DigestMismatch(
                    f"expected SHA-256 {spec.expected_sha256}, received {actual_sha256}"
                )

            self._check_cancelled(is_cancelled)
            self._check_expiry(spec)
            os.replace(part_path, final_path)
            replaced = True
            artifact = LocalArtifact(
                path=final_path,
                file_name=spec.file_name,
                size=received_size,
                sha256=actual_sha256,
                expires_at=spec.expires_at,
            )
            self._emit(
                spec.command_id,
                TransferStage.READY,
                path=str(final_path),
                size=received_size,
                sha256=actual_sha256,
                expires_at=spec.expires_at,
            )
            return artifact
        except TransferCancelled:
            self._remove_partial(part_path)
            if replaced:
                final_path.unlink(missing_ok=True)
            self._emit(spec.command_id, TransferStage.CANCELLED)
            raise
        except Exception as exc:
            self._remove_partial(part_path)
            if replaced:
                final_path.unlink(missing_ok=True)
            self._emit(
                spec.command_id,
                TransferStage.FAILED,
                error_type=type(exc).__name__,
                error=str(exc),
            )
            raise

    async def _download_to_part(
        self,
        spec: ArtifactDownloadSpec,
        client: AsyncHttpClient,
        part_path: Path,
        *,
        resume_from: int,
        is_cancelled: Callable[[], bool] | None,
    ) -> tuple[int, str]:
        if resume_from <= 0:
            return await self._request_full(spec, client, part_path, is_cancelled)

        headers = {
            "Accept-Encoding": "identity",
            "Range": f"bytes={resume_from}-",
        }
        self._check_cancelled(is_cancelled)
        self._check_expiry(spec)
        async with client.stream(
            "GET",
            spec.source_url,
            headers=headers,
            follow_redirects=False,
        ) as response:
            if response.status_code == 206:
                if self._valid_content_range(response.headers, spec, resume_from):
                    digest = self._hash_existing(
                        part_path,
                        spec,
                        expected_size=resume_from,
                        is_cancelled=is_cancelled,
                    )
                    return await self._stream_response(
                        response,
                        part_path,
                        spec,
                        digest=digest,
                        received_size=resume_from,
                        append=True,
                        is_cancelled=is_cancelled,
                    )
            elif response.status_code == 200:
                return await self._stream_response(
                    response,
                    part_path,
                    spec,
                    digest=hashlib.sha256(),
                    received_size=0,
                    append=False,
                    is_cancelled=is_cancelled,
                )
            elif response.status_code != 416:
                self._raise_for_status(response.status_code)

        self._remove_partial(part_path)
        return await self._request_full(spec, client, part_path, is_cancelled)

    async def _request_full(
        self,
        spec: ArtifactDownloadSpec,
        client: AsyncHttpClient,
        part_path: Path,
        is_cancelled: Callable[[], bool] | None,
    ) -> tuple[int, str]:
        self._check_cancelled(is_cancelled)
        self._check_expiry(spec)
        headers = {"Accept-Encoding": "identity"}
        async with client.stream(
            "GET",
            spec.source_url,
            headers=headers,
            follow_redirects=False,
        ) as response:
            if response.status_code != 200:
                self._raise_for_status(response.status_code)
            return await self._stream_response(
                response,
                part_path,
                spec,
                digest=hashlib.sha256(),
                received_size=0,
                append=False,
                is_cancelled=is_cancelled,
            )

    async def _stream_response(
        self,
        response: AsyncHttpResponse,
        part_path: Path,
        spec: ArtifactDownloadSpec,
        *,
        digest: Any,
        received_size: int,
        append: bool,
        is_cancelled: Callable[[], bool] | None,
    ) -> tuple[int, str]:
        remaining = spec.expected_size - received_size
        self._validate_response_headers(response.headers, remaining)
        mode = "ab" if append else "wb"
        with part_path.open(mode) as output:
            async for chunk in response.aiter_bytes(self.chunk_size):
                self._check_cancelled(is_cancelled)
                self._check_expiry(spec)
                if not isinstance(chunk, (bytes, bytearray, memoryview)):
                    raise TypeError("HTTP response chunks must be bytes-like")
                next_size = received_size + len(chunk)
                if next_size > spec.expected_size:
                    raise SizeMismatch(
                        f"expected {spec.expected_size} bytes, received more than expected"
                    )
                output.write(chunk)
                digest.update(chunk)
                received_size = next_size
                self._check_cancelled(is_cancelled)
                self._check_expiry(spec)

            if received_size != spec.expected_size:
                raise SizeMismatch(f"expected {spec.expected_size} bytes, received {received_size}")
            output.flush()
            os.fsync(output.fileno())
        return received_size, digest.hexdigest()

    def _hash_existing(
        self,
        part_path: Path,
        spec: ArtifactDownloadSpec,
        *,
        expected_size: int,
        is_cancelled: Callable[[], bool] | None,
    ) -> Any:
        digest = hashlib.sha256()
        read_size = 0
        with part_path.open("rb") as source:
            while chunk := source.read(self.chunk_size):
                self._check_cancelled(is_cancelled)
                self._check_expiry(spec)
                digest.update(chunk)
                read_size += len(chunk)
        if read_size != expected_size:
            raise SizeMismatch(
                f"partial artifact changed while reading: expected {expected_size} bytes, "
                f"received {read_size}"
            )
        return digest

    def _partial_size(self, part_path: Path) -> int:
        try:
            metadata = part_path.lstat()
        except FileNotFoundError:
            return 0
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise UnsafeArtifactPath("partial artifact path must be a regular file")
        return metadata.st_size

    def _valid_content_range(
        self,
        headers: Mapping[str, str],
        spec: ArtifactDownloadSpec,
        resume_from: int,
    ) -> bool:
        value = self._header(headers, "Content-Range")
        if value is None:
            return False
        match = _CONTENT_RANGE_PATTERN.fullmatch(value.strip())
        if match is None:
            return False
        start, end, total = (int(part) for part in match.groups())
        return start == resume_from and end == spec.expected_size - 1 and total == spec.expected_size

    def _validate_response_headers(self, headers: Mapping[str, str], remaining: int) -> None:
        content_encoding = self._header(headers, "Content-Encoding")
        if content_encoding is not None and content_encoding.lower() != "identity":
            raise ArtifactDownloadError("compressed artifact responses are not supported")

        content_length = self._header(headers, "Content-Length")
        if content_length is None:
            return
        try:
            parsed_length = int(content_length)
        except ValueError as exc:
            raise ArtifactDownloadError("invalid Content-Length header") from exc
        if parsed_length < 0 or parsed_length != remaining:
            raise SizeMismatch(f"expected HTTP body of {remaining} bytes, received {parsed_length}")

    @staticmethod
    def _raise_for_status(status_code: int) -> None:
        raise ArtifactHttpStatusError(f"artifact request returned HTTP {status_code}")

    def _artifact_paths(self, spec: ArtifactDownloadSpec) -> tuple[Path, Path]:
        final_key = hashlib.sha256(spec.command_id.encode("utf-8")).hexdigest()
        return (
            self.spool_dir / f"{spec.command_id}.part",
            self.spool_dir / f"{final_key}-{spec.file_name}",
        )

    @staticmethod
    def _remove_partial(part_path: Path) -> None:
        try:
            part_path.unlink(missing_ok=True)
        except IsADirectoryError:
            pass

    def _check_expiry(self, spec: ArtifactDownloadSpec) -> None:
        if spec.expires_at is not None and self._clock() >= spec.expires_at:
            raise TransferExpired(f"artifact {spec.command_id!r} expired")

    @staticmethod
    def _check_cancelled(is_cancelled: Callable[[], bool] | None) -> None:
        if is_cancelled is not None and is_cancelled():
            raise TransferCancelled("artifact download was cancelled")

    @staticmethod
    def _header(headers: Mapping[str, str], name: str) -> str | None:
        target = name.lower()
        for key, value in headers.items():
            if key.lower() == target:
                return value
        return None

    def _emit(self, command_id: str, stage: TransferStage, **details: Any) -> None:
        if self._transition_sink is None:
            return
        self._transition_sink(
            TransferTransition(
                command_id=command_id,
                stage=stage,
                details=details,
                occurred_at=self._clock(),
            )
        )


def _is_safe_file_name(file_name: str) -> bool:
    return (
        bool(file_name)
        and file_name not in {".", ".."}
        and not file_name.endswith((" ", "."))
        and len(file_name.encode("utf-8")) <= 180
        and all(
            ord(character) >= 32 and character not in _INVALID_FILE_NAME_CHARACTERS
            for character in file_name
        )
    )
