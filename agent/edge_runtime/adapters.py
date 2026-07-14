"""Typed printer-adapter contracts for the Monofarm edge runtime."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Protocol, runtime_checkable


class AdapterCapability(str, Enum):
    DISCOVER = "discover"
    STATUS = "status"
    FILE_UPLOAD = "file_upload"
    PRINT_START = "print_start"
    START_RECONCILE = "start_reconcile"
    PAUSE = "pause"
    RESUME = "resume"
    CANCEL = "cancel"
    CAMERA_SNAPSHOT = "camera_snapshot"


@dataclass(frozen=True, slots=True)
class AdapterCapabilities:
    enabled: frozenset[AdapterCapability]

    @classmethod
    def of(cls, *capabilities: AdapterCapability) -> AdapterCapabilities:
        return cls(frozenset(capabilities))

    def supports(self, capability: AdapterCapability) -> bool:
        return capability in self.enabled

    def missing(self, required: tuple[AdapterCapability, ...]) -> tuple[AdapterCapability, ...]:
        return tuple(capability for capability in required if not self.supports(capability))


class UnsupportedCapability(RuntimeError):
    def __init__(self, adapter_id: str, missing: tuple[AdapterCapability, ...]) -> None:
        self.adapter_id = adapter_id
        self.missing = missing
        names = ", ".join(capability.value for capability in missing)
        super().__init__(f"adapter {adapter_id!r} does not support: {names}")


@dataclass(frozen=True, slots=True)
class LocalArtifact:
    path: Path
    file_name: str
    size: int
    sha256: str
    expires_at: float | None


@dataclass(frozen=True, slots=True)
class RemoteArtifact:
    remote_id: str
    file_name: str


@dataclass(frozen=True, slots=True)
class StartReceipt:
    command_id: str
    remote_id: str
    printer_reference: str | None = None


class ReconcileState(str, Enum):
    UNKNOWN = "unknown"
    PRINTER_ACK = "printer_ack"
    PRINTING = "printing"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class ReconcileResult:
    command_id: str
    state: ReconcileState
    printer_reference: str | None = None


class ProgressSink(Protocol):
    def __call__(self, sent: int, total: int) -> None: ...


@runtime_checkable
class PrinterAdapter(Protocol):
    adapter_id: str
    capabilities: AdapterCapabilities

    async def upload(self, artifact: LocalArtifact, progress: ProgressSink) -> RemoteArtifact: ...

    async def start(self, remote: RemoteArtifact, *, command_id: str) -> StartReceipt: ...

    async def reconcile(
        self,
        remote: RemoteArtifact,
        *,
        command_id: str,
        receipt: StartReceipt | None,
    ) -> ReconcileResult: ...


def require_capabilities(adapter: PrinterAdapter, *required: AdapterCapability) -> None:
    missing = adapter.capabilities.missing(required)
    if missing:
        raise UnsupportedCapability(adapter.adapter_id, missing)
