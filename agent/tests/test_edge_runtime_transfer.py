import asyncio
import hashlib
import os
from pathlib import Path

import pytest

from agent.edge_runtime.adapters import (
    AdapterCapabilities,
    AdapterCapability,
    LocalArtifact,
    ReconcileResult,
    ReconcileState,
    RemoteArtifact,
    StartReceipt,
)
from agent.edge_runtime.transfer import (
    DigestMismatch,
    SizeMismatch,
    TransferCancelled,
    TransferCoordinator,
    TransferExpired,
    TransferSpec,
    TransferStage,
    journal_transition_sink,
)
from agent.edge_runtime.journal import SQLiteCommandJournal


class FakeTransferAdapter:
    adapter_id = "fake-printer"
    capabilities = AdapterCapabilities.of(
        AdapterCapability.FILE_UPLOAD,
        AdapterCapability.PRINT_START,
        AdapterCapability.START_RECONCILE,
    )

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.fail_start = False

    async def upload(self, artifact: LocalArtifact, progress) -> RemoteArtifact:
        self.calls.append("upload")
        progress(artifact.size, artifact.size)
        return RemoteArtifact(remote_id="remote-1", file_name=artifact.file_name)

    async def start(self, remote: RemoteArtifact, *, command_id: str) -> StartReceipt:
        self.calls.append("start")
        if self.fail_start:
            raise TimeoutError("start response was lost")
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
        self.calls.append("reconcile")
        return ReconcileResult(
            command_id=command_id,
            state=ReconcileState.PRINTER_ACK,
            printer_reference=receipt.printer_reference if receipt else "recovered-task",
        )


def make_spec(data: bytes, *, expires_at: float | None = 200.0) -> TransferSpec:
    return TransferSpec(
        command_id="command-1",
        file_name="model.gcode",
        expected_size=len(data),
        expected_sha256=hashlib.sha256(data).hexdigest(),
        expires_at=expires_at,
    )


def test_receive_streams_to_part_verifies_and_atomically_renames(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    data = b"G1 X1\nG1 X2\n"
    transitions = []
    quota_calls = []
    retained = []
    replace_calls: list[tuple[Path, Path]] = []
    real_replace = os.replace

    def quota_hook(*, command_id: str, bytes_required: int, staging_dir: Path) -> None:
        quota_calls.append((command_id, bytes_required, staging_dir))

    def ttl_hook(artifact: LocalArtifact) -> None:
        retained.append(artifact)

    def replace_spy(source, destination) -> None:
        source_path = Path(source)
        destination_path = Path(destination)
        assert source_path.suffix == ".part"
        assert source_path.exists()
        replace_calls.append((source_path, destination_path))
        real_replace(source_path, destination_path)

    monkeypatch.setattr("agent.edge_runtime.transfer.os.replace", replace_spy)
    coordinator = TransferCoordinator(
        tmp_path,
        quota_hook=quota_hook,
        ttl_hook=ttl_hook,
        transition_sink=transitions.append,
        clock=lambda: 100.0,
    )
    spec = make_spec(data)

    artifact = coordinator.receive(spec, [data[:4], data[4:9], data[9:]])

    assert artifact.path.read_bytes() == data
    assert artifact.size == len(data)
    assert artifact.sha256 == spec.expected_sha256
    assert artifact.expires_at == 200.0
    assert quota_calls == [("command-1", len(data), tmp_path)]
    assert retained == [artifact]
    assert len(replace_calls) == 1
    assert replace_calls[0][1] == artifact.path
    assert list(tmp_path.glob("*.part")) == []
    assert [transition.stage for transition in transitions] == [
        TransferStage.RECEIVED,
        TransferStage.DOWNLOADING,
        TransferStage.VERIFYING_SOURCE,
        TransferStage.READY,
    ]


@pytest.mark.parametrize(
    ("chunks", "expected_size", "expected_sha256", "error_type"),
    [
        ([b"short"], 10, hashlib.sha256(b"short").hexdigest(), SizeMismatch),
        ([b"too-long"], 3, hashlib.sha256(b"too-long").hexdigest(), SizeMismatch),
        ([b"same-size"], 9, "0" * 64, DigestMismatch),
    ],
)
def test_receive_rejects_bad_size_or_digest_and_removes_part(
    tmp_path: Path,
    chunks: list[bytes],
    expected_size: int,
    expected_sha256: str,
    error_type: type[Exception],
) -> None:
    transitions = []
    coordinator = TransferCoordinator(tmp_path, transition_sink=transitions.append)
    spec = TransferSpec(
        command_id="command-1",
        file_name="model.gcode",
        expected_size=expected_size,
        expected_sha256=expected_sha256,
    )

    with pytest.raises(error_type):
        coordinator.receive(spec, chunks)

    assert list(tmp_path.iterdir()) == []
    assert transitions[-1].stage is TransferStage.FAILED


def test_receive_checks_expiry_and_cancellation_between_chunks(tmp_path: Path) -> None:
    expired = TransferCoordinator(tmp_path, clock=lambda: 201.0)
    with pytest.raises(TransferExpired):
        expired.receive(make_spec(b"data", expires_at=200.0), [b"data"])

    transitions = []
    cancelled = False

    def chunks():
        nonlocal cancelled
        yield b"first"
        cancelled = True
        yield b"second"

    coordinator = TransferCoordinator(tmp_path, transition_sink=transitions.append)
    spec = make_spec(b"firstsecond", expires_at=None)

    with pytest.raises(TransferCancelled):
        coordinator.receive(spec, chunks(), is_cancelled=lambda: cancelled)

    assert list(tmp_path.iterdir()) == []
    assert transitions[-1].stage is TransferStage.CANCELLED


def test_upload_start_and_reconcile_are_explicit_separate_operations(tmp_path: Path) -> None:
    data = b"G1 X10\n"
    transitions = []
    progress = []
    coordinator = TransferCoordinator(tmp_path, transition_sink=transitions.append)
    artifact = coordinator.receive(make_spec(data, expires_at=None), [data])
    adapter = FakeTransferAdapter()

    async def run_stages():
        uploaded = await coordinator.upload(
            "command-1",
            artifact,
            adapter,
            progress=lambda sent, total: progress.append((sent, total)),
        )
        assert adapter.calls == ["upload"]

        receipt = await coordinator.start(uploaded, adapter)
        assert adapter.calls == ["upload", "start"]

        result = await coordinator.reconcile(uploaded, adapter, receipt=receipt)
        return uploaded, receipt, result

    uploaded, receipt, result = asyncio.run(run_stages())

    assert uploaded.remote.remote_id == "remote-1"
    assert receipt.printer_reference == "task-1"
    assert result.state is ReconcileState.PRINTER_ACK
    assert adapter.calls == ["upload", "start", "reconcile"]
    assert progress == [(len(data), len(data))]
    assert [transition.stage for transition in transitions][-6:] == [
        TransferStage.UPLOADING,
        TransferStage.UPLOADED,
        TransferStage.STARTING,
        TransferStage.START_REQUESTED,
        TransferStage.RECONCILING,
        TransferStage.PRINTER_ACK,
    ]


def test_lost_start_response_is_not_retried_and_can_be_reconciled(tmp_path: Path) -> None:
    data = b"G1 X20\n"
    transitions = []
    coordinator = TransferCoordinator(tmp_path, transition_sink=transitions.append)
    artifact = coordinator.receive(make_spec(data, expires_at=None), [data])
    adapter = FakeTransferAdapter()

    async def run_stages() -> ReconcileResult:
        uploaded = await coordinator.upload("command-1", artifact, adapter)
        adapter.fail_start = True
        with pytest.raises(TimeoutError, match="response was lost"):
            await coordinator.start(uploaded, adapter)

        adapter.fail_start = False
        return await coordinator.reconcile(uploaded, adapter, receipt=None)

    result = asyncio.run(run_stages())

    assert adapter.calls == ["upload", "start", "reconcile"]
    assert result.state is ReconcileState.PRINTER_ACK
    assert result.printer_reference == "recovered-task"
    assert TransferStage.NEEDS_RECONCILE in [transition.stage for transition in transitions]


def test_stage_transitions_can_be_written_to_durable_outbox(tmp_path: Path) -> None:
    data = b"G1 X30\n"
    database = tmp_path / "commands.sqlite3"
    staging = tmp_path / "staging"

    with SQLiteCommandJournal(database) as journal:
        journal.enqueue("command-1", "upload", {"file": "model.gcode"})
        coordinator = TransferCoordinator(
            staging,
            transition_sink=journal_transition_sink(journal),
        )

        coordinator.receive(make_spec(data, expires_at=None), [data])

        transfer_events = [
            event
            for event in journal.pending_outbox(limit=100)
            if event.event_type == "transfer.stage"
        ]
        assert [event.payload["stage"] for event in transfer_events] == [
            TransferStage.RECEIVED.value,
            TransferStage.DOWNLOADING.value,
            TransferStage.VERIFYING_SOURCE.value,
            TransferStage.READY.value,
        ]
