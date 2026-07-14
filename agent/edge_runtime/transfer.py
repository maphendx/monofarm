"""Shared, provider-neutral artifact transfer coordination."""

from __future__ import annotations

import hashlib
import os
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Protocol

from .adapters import (
    AdapterCapability,
    LocalArtifact,
    PrinterAdapter,
    ProgressSink,
    ReconcileResult,
    ReconcileState,
    RemoteArtifact,
    StartReceipt,
    require_capabilities,
)


class TransferStage(str, Enum):
    RECEIVED = "received"
    DOWNLOADING = "downloading"
    VERIFYING_SOURCE = "verifying_source"
    READY = "ready"
    UPLOADING = "uploading"
    UPLOADED = "uploaded"
    STARTING = "starting"
    START_REQUESTED = "start_requested"
    RECONCILING = "reconciling"
    NEEDS_RECONCILE = "needs_reconcile"
    PRINTER_ACK = "printer_ack"
    PRINTING = "printing"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass(frozen=True, slots=True)
class TransferSpec:
    command_id: str
    file_name: str
    expected_size: int
    expected_sha256: str
    expires_at: float | None = None

    def __post_init__(self) -> None:
        if not self.command_id:
            raise ValueError("command_id cannot be empty")
        if not self.file_name or Path(self.file_name).name != self.file_name:
            raise ValueError("file_name must be a plain file name")
        if self.expected_size < 0:
            raise ValueError("expected_size cannot be negative")
        normalized_sha256 = self.expected_sha256.lower()
        if len(normalized_sha256) != 64 or any(character not in "0123456789abcdef" for character in normalized_sha256):
            raise ValueError("expected_sha256 must be a 64-character hexadecimal digest")
        object.__setattr__(self, "expected_sha256", normalized_sha256)


@dataclass(frozen=True, slots=True)
class UploadedTransfer:
    command_id: str
    local: LocalArtifact
    remote: RemoteArtifact


@dataclass(frozen=True, slots=True)
class TransferTransition:
    command_id: str
    stage: TransferStage
    details: Mapping[str, Any]
    occurred_at: float


class TransferError(RuntimeError):
    pass


class TransferExpired(TransferError):
    pass


class TransferCancelled(TransferError):
    pass


class SizeMismatch(TransferError):
    pass


class DigestMismatch(TransferError):
    pass


class QuotaHook(Protocol):
    def __call__(self, *, command_id: str, bytes_required: int, staging_dir: Path) -> None: ...


class TTLHook(Protocol):
    def __call__(self, artifact: LocalArtifact) -> None: ...


class TransitionSink(Protocol):
    def __call__(self, transition: TransferTransition) -> None: ...


class EventOutbox(Protocol):
    def append_event(
        self,
        command_id: str | None,
        event_type: str,
        payload: Mapping[str, Any],
    ) -> object: ...


def journal_transition_sink(journal: EventOutbox) -> TransitionSink:
    def sink(transition: TransferTransition) -> None:
        journal.append_event(
            transition.command_id,
            "transfer.stage",
            {
                "stage": transition.stage.value,
                "details": dict(transition.details),
                "occurred_at": transition.occurred_at,
            },
        )

    return sink


class TransferCoordinator:
    def __init__(
        self,
        staging_dir: str | Path,
        *,
        quota_hook: QuotaHook | None = None,
        ttl_hook: TTLHook | None = None,
        transition_sink: TransitionSink | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.staging_dir = Path(staging_dir)
        self.staging_dir.mkdir(parents=True, exist_ok=True)
        self._quota_hook = quota_hook
        self._ttl_hook = ttl_hook
        self._transition_sink = transition_sink
        self._clock = clock

    def receive(
        self,
        spec: TransferSpec,
        chunks: Iterable[bytes],
        *,
        is_cancelled: Callable[[], bool] | None = None,
    ) -> LocalArtifact:
        part_path, final_path = self._artifact_paths(spec)
        replaced = False
        self._emit(spec.command_id, TransferStage.RECEIVED)

        try:
            self._check_expiry(spec)
            self._check_cancelled(is_cancelled)
            if self._quota_hook is not None:
                self._quota_hook(
                    command_id=spec.command_id,
                    bytes_required=spec.expected_size,
                    staging_dir=self.staging_dir,
                )

            self._emit(
                spec.command_id,
                TransferStage.DOWNLOADING,
                expected_size=spec.expected_size,
            )
            digest = hashlib.sha256()
            received_size = 0
            with part_path.open("wb") as output:
                for chunk in chunks:
                    self._check_cancelled(is_cancelled)
                    self._check_expiry(spec)
                    if not isinstance(chunk, (bytes, bytearray, memoryview)):
                        raise TypeError("transfer chunks must be bytes-like")
                    chunk_bytes = bytes(chunk)
                    next_size = received_size + len(chunk_bytes)
                    if next_size > spec.expected_size:
                        raise SizeMismatch(
                            f"expected {spec.expected_size} bytes, received more than expected"
                        )
                    output.write(chunk_bytes)
                    digest.update(chunk_bytes)
                    received_size = next_size
                    self._check_cancelled(is_cancelled)
                    self._check_expiry(spec)
                output.flush()
                os.fsync(output.fileno())

            self._emit(
                spec.command_id,
                TransferStage.VERIFYING_SOURCE,
                received_size=received_size,
            )
            if received_size != spec.expected_size:
                raise SizeMismatch(f"expected {spec.expected_size} bytes, received {received_size}")

            actual_sha256 = digest.hexdigest()
            if actual_sha256 != spec.expected_sha256:
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
            if self._ttl_hook is not None:
                self._ttl_hook(artifact)
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
            part_path.unlink(missing_ok=True)
            if replaced:
                final_path.unlink(missing_ok=True)
            self._emit(spec.command_id, TransferStage.CANCELLED)
            raise
        except Exception as exc:
            part_path.unlink(missing_ok=True)
            if replaced:
                final_path.unlink(missing_ok=True)
            self._emit(
                spec.command_id,
                TransferStage.FAILED,
                error_type=type(exc).__name__,
                error=str(exc),
            )
            raise

    async def upload(
        self,
        command_id: str,
        artifact: LocalArtifact,
        adapter: PrinterAdapter,
        *,
        progress: ProgressSink | None = None,
        is_cancelled: Callable[[], bool] | None = None,
    ) -> UploadedTransfer:
        try:
            self._check_cancelled(is_cancelled)
            require_capabilities(adapter, AdapterCapability.FILE_UPLOAD)
            self._emit(command_id, TransferStage.UPLOADING, size=artifact.size)
            remote = await adapter.upload(artifact, progress or _ignore_progress)
            self._check_cancelled(is_cancelled)
        except TransferCancelled:
            self._emit(command_id, TransferStage.CANCELLED)
            raise
        except Exception as exc:
            self._emit(
                command_id,
                TransferStage.FAILED,
                error_type=type(exc).__name__,
                error=str(exc),
            )
            raise

        self._emit(
            command_id,
            TransferStage.UPLOADED,
            remote_id=remote.remote_id,
            file_name=remote.file_name,
        )
        return UploadedTransfer(command_id=command_id, local=artifact, remote=remote)

    async def start(
        self,
        transfer: UploadedTransfer,
        adapter: PrinterAdapter,
        *,
        is_cancelled: Callable[[], bool] | None = None,
    ) -> StartReceipt:
        try:
            self._check_cancelled(is_cancelled)
        except TransferCancelled:
            self._emit(transfer.command_id, TransferStage.CANCELLED)
            raise

        require_capabilities(adapter, AdapterCapability.PRINT_START)
        self._emit(
            transfer.command_id,
            TransferStage.STARTING,
            remote_id=transfer.remote.remote_id,
        )
        try:
            receipt = await adapter.start(transfer.remote, command_id=transfer.command_id)
        except Exception as exc:
            self._emit(
                transfer.command_id,
                TransferStage.NEEDS_RECONCILE,
                error_type=type(exc).__name__,
                error=str(exc),
            )
            raise

        self._emit(
            transfer.command_id,
            TransferStage.START_REQUESTED,
            remote_id=receipt.remote_id,
            printer_reference=receipt.printer_reference,
        )
        return receipt

    async def reconcile(
        self,
        transfer: UploadedTransfer,
        adapter: PrinterAdapter,
        *,
        receipt: StartReceipt | None,
        is_cancelled: Callable[[], bool] | None = None,
    ) -> ReconcileResult:
        try:
            self._check_cancelled(is_cancelled)
        except TransferCancelled:
            self._emit(transfer.command_id, TransferStage.CANCELLED)
            raise

        require_capabilities(adapter, AdapterCapability.START_RECONCILE)
        self._emit(
            transfer.command_id,
            TransferStage.RECONCILING,
            remote_id=transfer.remote.remote_id,
        )
        try:
            result = await adapter.reconcile(
                transfer.remote,
                command_id=transfer.command_id,
                receipt=receipt,
            )
        except Exception as exc:
            self._emit(
                transfer.command_id,
                TransferStage.NEEDS_RECONCILE,
                error_type=type(exc).__name__,
                error=str(exc),
            )
            raise

        stage = {
            ReconcileState.UNKNOWN: TransferStage.NEEDS_RECONCILE,
            ReconcileState.PRINTER_ACK: TransferStage.PRINTER_ACK,
            ReconcileState.PRINTING: TransferStage.PRINTING,
            ReconcileState.FAILED: TransferStage.FAILED,
        }[result.state]
        self._emit(
            transfer.command_id,
            stage,
            printer_reference=result.printer_reference,
        )
        return result

    def _artifact_paths(self, spec: TransferSpec) -> tuple[Path, Path]:
        key = hashlib.sha256(spec.command_id.encode("utf-8")).hexdigest()
        return (
            self.staging_dir / f"{key}.part",
            self.staging_dir / f"{key}-{spec.file_name}",
        )

    def _check_expiry(self, spec: TransferSpec) -> None:
        if spec.expires_at is not None and self._clock() >= spec.expires_at:
            raise TransferExpired(f"transfer {spec.command_id!r} expired")

    @staticmethod
    def _check_cancelled(is_cancelled: Callable[[], bool] | None) -> None:
        if is_cancelled is not None and is_cancelled():
            raise TransferCancelled("transfer was cancelled")

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


def _ignore_progress(sent: int, total: int) -> None:
    del sent, total
