import asyncio
from pathlib import Path

import pytest

from agent.edge_runtime.adapters import (
    AdapterCapabilities,
    LocalArtifact,
    PrinterAdapter,
    ReconcileResult,
    ReconcileState,
    RemoteArtifact,
    StartReceipt,
)
from agent.edge_runtime.registry import (
    BAMBU_DESCRIPTOR,
    MOONRAKER_DESCRIPTOR,
    AdapterContractError,
    AdapterDescriptor,
    AdapterRegistry,
    DelegatingPrinterAdapter,
    DuplicateProviderError,
    ProviderAvailability,
    ProviderUnavailableError,
    TransportKind,
    TransportMetadata,
    TransportScope,
    TransportSecurity,
    UnknownProviderError,
    current_provider_registry,
    validate_adapter_contract,
)


def _adapter_for_descriptor(descriptor: AdapterDescriptor) -> DelegatingPrinterAdapter:
    async def upload(artifact: LocalArtifact, progress) -> RemoteArtifact:
        progress(artifact.size, artifact.size)
        return RemoteArtifact(remote_id=f"{descriptor.provider_id}-remote", file_name=artifact.file_name)

    async def start(remote: RemoteArtifact, command_id: str) -> StartReceipt:
        return StartReceipt(
            command_id=command_id,
            remote_id=remote.remote_id,
            printer_reference=f"{descriptor.provider_id}-task",
        )

    async def reconcile(
        remote: RemoteArtifact,
        command_id: str,
        receipt: StartReceipt | None,
    ) -> ReconcileResult:
        del remote
        return ReconcileResult(
            command_id=command_id,
            state=ReconcileState.PRINTER_ACK,
            printer_reference=receipt.printer_reference if receipt else None,
        )

    return DelegatingPrinterAdapter(
        descriptor=descriptor,
        upload_delegate=upload,
        start_delegate=start,
        reconcile_delegate=reconcile,
    )


def test_current_registry_contains_only_truthful_operational_edge_providers() -> None:
    registry = current_provider_registry(
        bambu_factory=_adapter_for_descriptor,
        moonraker_factory=_adapter_for_descriptor,
    )

    assert [descriptor.provider_id for descriptor in registry.descriptors()] == [
        "bambu",
        "moonraker",
    ]
    assert registry.lookup("bambu") is BAMBU_DESCRIPTOR
    assert registry.lookup("klipper") is MOONRAKER_DESCRIPTOR
    assert registry.lookup("snapmaker_u1") is MOONRAKER_DESCRIPTOR
    assert registry.create("snapmaker_u1").adapter_id == "moonraker"

    assert BAMBU_DESCRIPTOR.availability is ProviderAvailability.OPERATIONAL
    assert BAMBU_DESCRIPTOR.supported_models == ("p1s", "a1", "a1_mini")
    assert {transport.kind for transport in BAMBU_DESCRIPTOR.transports} == {
        TransportKind.BAMBU_LAN_FTPS,
        TransportKind.BAMBU_LAN_MQTT,
    }
    assert MOONRAKER_DESCRIPTOR.availability is ProviderAvailability.OPERATIONAL
    assert MOONRAKER_DESCRIPTOR.supported_models == (
        "generic_klipper",
        "snapmaker_u1",
    )
    assert {transport.kind for transport in MOONRAKER_DESCRIPTOR.transports} == {
        TransportKind.MOONRAKER_HTTP,
        TransportKind.MOONRAKER_WEBSOCKET,
    }

    for unsupported in (
        "octoprint",
        "prusalink",
        "duet",
        "creality",
        "anycubic",
        "elegoo",
    ):
        with pytest.raises(UnknownProviderError, match=unsupported):
            registry.lookup(unsupported)


def test_registry_rejects_duplicate_provider_ids_and_alias_collisions() -> None:
    registry = AdapterRegistry()
    registry.register(BAMBU_DESCRIPTOR, _adapter_for_descriptor)

    with pytest.raises(DuplicateProviderError, match="bambu"):
        registry.register(BAMBU_DESCRIPTOR, _adapter_for_descriptor)

    shadow = AdapterDescriptor(
        provider_id="shadow",
        display_name="Shadow adapter",
        availability=ProviderAvailability.OPERATIONAL,
        capabilities=BAMBU_DESCRIPTOR.capabilities,
        supported_models=("shadow_model",),
        transports=BAMBU_DESCRIPTOR.transports,
        aliases=("bambu",),
    )
    with pytest.raises(DuplicateProviderError, match="bambu"):
        registry.register(shadow, _adapter_for_descriptor)


def test_operational_descriptor_requires_factory() -> None:
    registry = AdapterRegistry()

    with pytest.raises(TypeError, match="operational provider"):
        registry.register(BAMBU_DESCRIPTOR)


def test_non_operational_descriptor_is_visible_but_cannot_create_adapter() -> None:
    planned = AdapterDescriptor(
        provider_id="octoprint",
        display_name="OctoPrint",
        availability=ProviderAvailability.PLANNED,
        capabilities=AdapterCapabilities.of(),
        supported_models=(),
        transports=(),
        validation_notes="No Monofarm edge adapter implementation is registered.",
    )
    registry = AdapterRegistry()
    registry.register(planned)

    assert registry.lookup("octoprint") is planned
    assert registry.descriptors(availability=ProviderAvailability.PLANNED) == (planned,)
    assert registry.descriptors(availability=ProviderAvailability.OPERATIONAL) == ()
    with pytest.raises(ProviderUnavailableError, match="planned"):
        registry.create("octoprint")


def test_descriptor_requires_stable_provider_id() -> None:
    with pytest.raises(ValueError, match="provider_id"):
        AdapterDescriptor(
            provider_id="Bambu Lab",
            display_name="Invalid",
            availability=ProviderAvailability.LAB_REQUIRED,
            capabilities=AdapterCapabilities.of(),
            supported_models=(),
            transports=(),
            validation_notes="Lab validation is required.",
        )


@pytest.mark.parametrize(
    "descriptor",
    [BAMBU_DESCRIPTOR, MOONRAKER_DESCRIPTOR],
    ids=lambda descriptor: descriptor.provider_id,
)
def test_delegating_adapter_passes_reusable_transfer_contract_harness(
    descriptor: AdapterDescriptor,
) -> None:
    calls: list[tuple] = []
    progress: list[tuple[int, int]] = []

    async def upload(artifact: LocalArtifact, progress_sink) -> RemoteArtifact:
        calls.append(("upload", artifact.file_name))
        progress_sink(artifact.size, artifact.size)
        return RemoteArtifact(remote_id="remote-1", file_name=artifact.file_name)

    async def start(remote: RemoteArtifact, command_id: str) -> StartReceipt:
        calls.append(("start", remote.remote_id, command_id))
        return StartReceipt(
            command_id=command_id,
            remote_id=remote.remote_id,
            printer_reference="task-1",
        )

    async def reconcile(
        remote: RemoteArtifact,
        command_id: str,
        receipt: StartReceipt | None,
    ) -> ReconcileResult:
        calls.append(("reconcile", remote.remote_id, command_id, receipt))
        return ReconcileResult(
            command_id=command_id,
            state=ReconcileState.PRINTER_ACK,
            printer_reference=receipt.printer_reference if receipt else None,
        )

    adapter = DelegatingPrinterAdapter(
        descriptor=descriptor,
        upload_delegate=upload,
        start_delegate=start,
        reconcile_delegate=reconcile,
    )
    artifact = LocalArtifact(
        path=Path("/tmp/model.gcode"),
        file_name="model.gcode",
        size=42,
        sha256="a" * 64,
        expires_at=None,
    )

    async def exercise_contract() -> ReconcileResult:
        remote = await adapter.upload(
            artifact,
            lambda sent, total: progress.append((sent, total)),
        )
        receipt = await adapter.start(remote, command_id="command-1")
        return await adapter.reconcile(
            remote,
            command_id="command-1",
            receipt=receipt,
        )

    validate_adapter_contract(descriptor, adapter)
    result = asyncio.run(exercise_contract())

    assert isinstance(adapter, PrinterAdapter)
    assert adapter.adapter_id == descriptor.provider_id
    assert adapter.capabilities == descriptor.capabilities
    assert result.state is ReconcileState.PRINTER_ACK
    assert progress == [(42, 42)]
    assert [call[0] for call in calls] == ["upload", "start", "reconcile"]


def test_registry_rejects_factory_that_violates_descriptor_contract() -> None:
    registry = AdapterRegistry()
    registry.register(
        BAMBU_DESCRIPTOR,
        lambda descriptor: _adapter_for_descriptor(MOONRAKER_DESCRIPTOR),
    )

    with pytest.raises(AdapterContractError, match="adapter_id"):
        registry.create("bambu")


def test_transport_metadata_rejects_invalid_port() -> None:
    with pytest.raises(ValueError, match="default_port"):
        TransportMetadata(
            kind=TransportKind.MOONRAKER_HTTP,
            scope=TransportScope.LAN,
            security=TransportSecurity.TLS_OPTIONAL,
            default_port=70_000,
        )
