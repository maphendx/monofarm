import asyncio
import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest

from agent.command_runtime import (
    CommandExecutionResult,
    CommandNeedsReconcile,
    LeasedAgentCommand,
)
from agent.edge_runtime.adapters import (
    AdapterCapabilities,
    AdapterCapability,
    LocalArtifact,
    ReconcileResult,
    ReconcileState,
    RemoteArtifact,
    StartReceipt,
)
from agent.edge_runtime.artifact_spool import ArtifactDownloader
from agent.printer_runtime import (
    InvalidRuntimeConfig,
    InvalidRuntimePayload,
    PrinterCommandDispatcher,
    RuntimePrinter,
    RuntimePrinterRegistry,
)


def _wire(
    command_type: str,
    payload: dict,
    *,
    printer_id: int = 7,
    command_id: str = "019f0000-0000-7000-8000-000000000010",
) -> LeasedAgentCommand:
    digest = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    now = datetime.now(timezone.utc)
    return LeasedAgentCommand.from_wire(
        {
            "id": command_id,
            "agent_device_id": "019f0000-0000-7000-8000-000000000001",
            "printer_id": printer_id,
            "command_type": command_type,
            "payload": payload,
            "payload_sha256": digest,
            "state": "leased",
            "attempt": 1,
            "deadline_at": (now + timedelta(minutes=5)).isoformat(),
            "lease_expires_at": (now + timedelta(seconds=30)).isoformat(),
        }
    )


def _moonraker_wire() -> dict:
    return {
        "id": 7,
        "transport": "moonraker",
        "name": "U1-07",
        "kind": "snapmaker_u1",
        "moonraker_url": "https://192.168.1.70:7125",
    }


class FakeAdapter:
    adapter_id = "moonraker"
    capabilities = AdapterCapabilities.of(
        AdapterCapability.FILE_UPLOAD,
        AdapterCapability.PRINT_START,
        AdapterCapability.START_RECONCILE,
    )

    def __init__(self, reconcile_state: ReconcileState = ReconcileState.PRINTER_ACK) -> None:
        self.calls: list[tuple] = []
        self.reconcile_state = reconcile_state

    async def upload(self, artifact: LocalArtifact, progress) -> RemoteArtifact:
        self.calls.append(("upload", artifact.file_name, artifact.path.read_bytes()))
        progress(artifact.size, artifact.size)
        return RemoteArtifact(remote_id=f"gcodes/{artifact.file_name}", file_name=artifact.file_name)

    async def start(self, remote: RemoteArtifact, *, command_id: str) -> StartReceipt:
        self.calls.append(("start", remote.remote_id, command_id))
        return StartReceipt(
            command_id=command_id,
            remote_id=remote.remote_id,
            printer_reference="print-42",
        )

    async def reconcile(
        self,
        remote: RemoteArtifact,
        *,
        command_id: str,
        receipt: StartReceipt | None,
    ) -> ReconcileResult:
        self.calls.append(("reconcile", remote.remote_id, command_id, receipt))
        return ReconcileResult(
            command_id=command_id,
            state=self.reconcile_state,
            printer_reference="print-42",
        )


def test_runtime_registry_accepts_only_fixed_provider_specific_targets() -> None:
    registry = RuntimePrinterRegistry()
    registry.replace(
        {
            "artifact_hosts": ["files.monofarm.test"],
            "printers": [
                _moonraker_wire(),
                {
                    "id": 8,
                    "transport": "bambu_lan",
                    "name": "A1-08",
                    "kind": "bambu",
                    "model": "A1",
                    "dev_id": "030123",
                    "ip": "192.168.1.80",
                    "access_code": "12345678",
                },
            ]
        }
    )

    moonraker = registry.require(7)
    bambu = registry.require(8)
    assert moonraker.moonraker_url == "https://192.168.1.70:7125"
    assert bambu.dev_id == "030123"
    assert registry.ids() == (7, 8)
    registry.require_artifact_source("https://files.monofarm.test/model.gcode?signature=ok")
    with pytest.raises(InvalidRuntimePayload, match="not registered"):
        registry.require_artifact_source("https://evil.example/model.gcode")

    with pytest.raises(InvalidRuntimeConfig, match="transport"):
        RuntimePrinter.from_wire({**_moonraker_wire(), "transport": "octoprint"})
    with pytest.raises(InvalidRuntimeConfig, match="unexpected"):
        RuntimePrinter.from_wire({**_moonraker_wire(), "proxy_url": "http://169.254.169.254"})
    with pytest.raises(InvalidRuntimeConfig, match="duplicate"):
        registry.replace({"printers": [_moonraker_wire(), _moonraker_wire()]})


def test_upload_downloads_verified_artifact_then_uses_typed_adapter(tmp_path: Path) -> None:
    data = b"G28\nG1 X10\n"
    adapter = FakeAdapter()
    registry = RuntimePrinterRegistry()
    registry.replace({"printers": [_moonraker_wire()]})

    async def artifact_handler(request: httpx.Request) -> httpx.Response:
        assert request.url == httpx.URL("https://files.monofarm.test/model.gcode")
        assert request.headers.get("range") is None
        return httpx.Response(200, content=data, headers={"Content-Length": str(len(data))})

    client = httpx.AsyncClient(transport=httpx.MockTransport(artifact_handler))
    downloader = ArtifactDownloader(
        tmp_path,
        max_artifact_bytes=1024,
        source_policy=lambda url: None,
    )
    dispatcher = PrinterCommandDispatcher(
        registry=registry,
        adapter_factory=lambda _printer, _command: adapter,
        control_handler=_unexpected_control,
        artifact_downloader=downloader,
        artifact_client=client,
    )
    payload = {
        "source_url": "https://files.monofarm.test/model.gcode",
        "file_name": "model.gcode",
        "expected_size": len(data),
        "expected_sha256": hashlib.sha256(data).hexdigest(),
        "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
    }

    result = asyncio.run(dispatcher.execute(_wire("printer.upload", payload)))
    asyncio.run(client.aclose())

    assert isinstance(result, CommandExecutionResult)
    assert result.milestones == ("delivered", "terminal")
    assert result.payload == {
        "provider": "moonraker",
        "remote_id": "gcodes/model.gcode",
        "file_name": "model.gcode",
        "size": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }
    assert adapter.calls == [("upload", "model.gcode", data)]


def test_control_commands_cannot_smuggle_targets_or_unknown_options(tmp_path: Path) -> None:
    calls: list[tuple[int, str]] = []
    registry = RuntimePrinterRegistry()
    registry.replace({"printers": [_moonraker_wire()]})

    async def control(
        printer: RuntimePrinter,
        command: LeasedAgentCommand,
    ) -> CommandExecutionResult:
        calls.append((printer.id, command.command_type))
        return CommandExecutionResult({"ok": True}, ("printer_ack", "terminal"))

    dispatcher = PrinterCommandDispatcher(
        registry=registry,
        adapter_factory=lambda _printer, _command: FakeAdapter(),
        control_handler=control,
        artifact_downloader=ArtifactDownloader(tmp_path, max_artifact_bytes=1024),
        artifact_client=httpx.AsyncClient(transport=httpx.MockTransport(lambda _: None)),
    )

    result = asyncio.run(dispatcher.execute(_wire("printer.pause", {})))
    assert result.payload == {"ok": True}
    assert calls == [(7, "printer.pause")]

    with pytest.raises(InvalidRuntimePayload, match="does not accept payload"):
        asyncio.run(
            dispatcher.execute(
                _wire("printer.cancel", {"url": "http://169.254.169.254/latest/meta-data"})
            )
        )


def test_start_and_reconcile_are_semantic_not_publish_only(tmp_path: Path) -> None:
    registry = RuntimePrinterRegistry()
    registry.replace({"printers": [_moonraker_wire()]})
    adapter = FakeAdapter()
    dispatcher = PrinterCommandDispatcher(
        registry=registry,
        adapter_factory=lambda _printer, _command: adapter,
        control_handler=_unexpected_control,
        artifact_downloader=ArtifactDownloader(tmp_path, max_artifact_bytes=1024),
        artifact_client=httpx.AsyncClient(transport=httpx.MockTransport(lambda _: None)),
    )
    payload = {"remote_id": "gcodes/model.gcode", "file_name": "model.gcode"}

    started = asyncio.run(dispatcher.execute(_wire("printer.start", payload)))
    reconciled = asyncio.run(dispatcher.execute(_wire("printer.reconcile", payload)))

    assert started.milestones == ("delivered", "printer_ack", "terminal")
    assert started.payload["printer_reference"] == "print-42"
    assert reconciled.milestones == ("printer_ack", "terminal")

    unknown_adapter = FakeAdapter(ReconcileState.UNKNOWN)
    unknown = PrinterCommandDispatcher(
        registry=registry,
        adapter_factory=lambda _printer, _command: unknown_adapter,
        control_handler=_unexpected_control,
        artifact_downloader=ArtifactDownloader(tmp_path, max_artifact_bytes=1024),
        artifact_client=httpx.AsyncClient(transport=httpx.MockTransport(lambda _: None)),
    )
    with pytest.raises(CommandNeedsReconcile, match="inconclusive"):
        asyncio.run(unknown.execute(_wire("printer.reconcile", payload)))


def test_command_requires_a_known_printer_target(tmp_path: Path) -> None:
    dispatcher = PrinterCommandDispatcher(
        registry=RuntimePrinterRegistry(),
        adapter_factory=lambda _printer, _command: FakeAdapter(),
        control_handler=_unexpected_control,
        artifact_downloader=ArtifactDownloader(tmp_path, max_artifact_bytes=1024),
        artifact_client=httpx.AsyncClient(transport=httpx.MockTransport(lambda _: None)),
    )

    with pytest.raises(InvalidRuntimePayload, match="printer_id"):
        asyncio.run(dispatcher.execute(_wire("printer.status", {}, printer_id=99)))


async def _unexpected_control(
    _printer: RuntimePrinter,
    _command: LeasedAgentCommand,
) -> CommandExecutionResult:
    raise AssertionError("control handler was not expected")
