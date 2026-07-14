import asyncio
from pathlib import Path

import pytest

from agent.edge_runtime.adapters import (
    AdapterCapabilities,
    AdapterCapability,
    LocalArtifact,
    PrinterAdapter,
    ReconcileResult,
    ReconcileState,
    RemoteArtifact,
    StartReceipt,
    UnsupportedCapability,
    require_capabilities,
)


class FakeAdapter:
    adapter_id = "fake-printer"
    capabilities = AdapterCapabilities.of(
        AdapterCapability.FILE_UPLOAD,
        AdapterCapability.PRINT_START,
        AdapterCapability.START_RECONCILE,
    )

    async def upload(self, artifact: LocalArtifact, progress) -> RemoteArtifact:
        progress(artifact.size, artifact.size)
        return RemoteArtifact(remote_id="remote-1", file_name=artifact.file_name)

    async def start(self, remote: RemoteArtifact, *, command_id: str) -> StartReceipt:
        return StartReceipt(
            command_id=command_id,
            remote_id=remote.remote_id,
            printer_reference="task-1",
        )

    async def reconcile(
        self,
        remote: RemoteArtifact,
        *,
        command_id: str,
        receipt: StartReceipt | None,
    ) -> ReconcileResult:
        return ReconcileResult(
            command_id=command_id,
            state=ReconcileState.PRINTER_ACK,
            printer_reference=receipt.printer_reference if receipt else None,
        )


def test_fake_adapter_satisfies_typed_contract() -> None:
    adapter = FakeAdapter()
    artifact = LocalArtifact(
        path=Path("/tmp/model.gcode"),
        file_name="model.gcode",
        size=12,
        sha256="a" * 64,
        expires_at=None,
    )
    progress: list[tuple[int, int]] = []

    async def exercise_contract() -> ReconcileResult:
        remote = await adapter.upload(artifact, lambda sent, total: progress.append((sent, total)))
        receipt = await adapter.start(remote, command_id="command-1")
        return await adapter.reconcile(
            remote,
            command_id="command-1",
            receipt=receipt,
        )

    result = asyncio.run(exercise_contract())

    assert isinstance(adapter, PrinterAdapter)
    assert result.state is ReconcileState.PRINTER_ACK
    assert result.printer_reference == "task-1"
    assert progress == [(12, 12)]


def test_capability_guard_reports_missing_contract_capability() -> None:
    adapter = FakeAdapter()

    require_capabilities(
        adapter,
        AdapterCapability.FILE_UPLOAD,
        AdapterCapability.PRINT_START,
    )

    with pytest.raises(UnsupportedCapability, match="camera_snapshot"):
        require_capabilities(adapter, AdapterCapability.CAMERA_SNAPSHOT)
