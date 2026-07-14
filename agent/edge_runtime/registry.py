"""Typed provider registry and adapters that delegate to existing edge handlers."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from enum import Enum
from string import ascii_lowercase, digits

from .adapters import (
    AdapterCapabilities,
    AdapterCapability,
    LocalArtifact,
    PrinterAdapter,
    ProgressSink,
    ReconcileResult,
    RemoteArtifact,
    StartReceipt,
)


_STABLE_ID_CHARACTERS = frozenset(ascii_lowercase + digits + "_")


def _validate_stable_id(value: str, *, field_name: str) -> None:
    if (
        not value
        or value[0] not in ascii_lowercase
        or any(character not in _STABLE_ID_CHARACTERS for character in value)
    ):
        raise ValueError(
            f"{field_name} must start with a lowercase letter and contain only a-z, 0-9, or _"
        )


class ProviderAvailability(str, Enum):
    OPERATIONAL = "operational"
    LAB_REQUIRED = "lab_required"
    PLANNED = "planned"


class TransportKind(str, Enum):
    BAMBU_LAN_FTPS = "bambu_lan_ftps"
    BAMBU_LAN_MQTT = "bambu_lan_mqtt"
    MOONRAKER_HTTP = "moonraker_http"
    MOONRAKER_WEBSOCKET = "moonraker_websocket"


class TransportScope(str, Enum):
    LAN = "lan"
    CLOUD = "cloud"


class TransportSecurity(str, Enum):
    TLS_REQUIRED = "tls_required"
    TLS_OPTIONAL = "tls_optional"


@dataclass(frozen=True, slots=True)
class TransportMetadata:
    kind: TransportKind
    scope: TransportScope
    security: TransportSecurity
    default_port: int | None = None

    def __post_init__(self) -> None:
        if self.default_port is not None and not 1 <= self.default_port <= 65_535:
            raise ValueError("default_port must be between 1 and 65535")


@dataclass(frozen=True, slots=True)
class AdapterDescriptor:
    provider_id: str
    display_name: str
    availability: ProviderAvailability
    capabilities: AdapterCapabilities
    supported_models: tuple[str, ...]
    transports: tuple[TransportMetadata, ...]
    aliases: tuple[str, ...] = ()
    validation_notes: str | None = None

    def __post_init__(self) -> None:
        _validate_stable_id(self.provider_id, field_name="provider_id")
        if not self.display_name.strip():
            raise ValueError("display_name cannot be empty")

        names = (self.provider_id, *self.aliases)
        for alias in self.aliases:
            _validate_stable_id(alias, field_name="alias")
        if len(names) != len(set(names)):
            raise ValueError("provider_id and aliases must be unique")

        for model in self.supported_models:
            _validate_stable_id(model, field_name="supported_model")
        if len(self.supported_models) != len(set(self.supported_models)):
            raise ValueError("supported_models must be unique")

        transport_kinds = tuple(transport.kind for transport in self.transports)
        if len(transport_kinds) != len(set(transport_kinds)):
            raise ValueError("transport kinds must be unique")

        if self.availability is ProviderAvailability.OPERATIONAL:
            if not self.capabilities.enabled:
                raise ValueError("operational providers require capabilities")
            if not self.supported_models:
                raise ValueError("operational providers require supported_models")
            if not self.transports:
                raise ValueError("operational providers require transports")
        elif not self.validation_notes or not self.validation_notes.strip():
            raise ValueError("non-operational providers require validation_notes")


UploadDelegate = Callable[[LocalArtifact, ProgressSink], Awaitable[RemoteArtifact]]
StartDelegate = Callable[[RemoteArtifact, str], Awaitable[StartReceipt]]
ReconcileDelegate = Callable[
    [RemoteArtifact, str, StartReceipt | None],
    Awaitable[ReconcileResult],
]
AdapterFactory = Callable[[AdapterDescriptor], PrinterAdapter]


@dataclass(frozen=True, slots=True)
class DelegatingPrinterAdapter:
    """Bridge typed runtime calls to existing async provider handlers."""

    descriptor: AdapterDescriptor
    upload_delegate: UploadDelegate
    start_delegate: StartDelegate
    reconcile_delegate: ReconcileDelegate

    @property
    def adapter_id(self) -> str:
        return self.descriptor.provider_id

    @property
    def capabilities(self) -> AdapterCapabilities:
        return self.descriptor.capabilities

    async def upload(self, artifact: LocalArtifact, progress: ProgressSink) -> RemoteArtifact:
        return await self.upload_delegate(artifact, progress)

    async def start(self, remote: RemoteArtifact, *, command_id: str) -> StartReceipt:
        return await self.start_delegate(remote, command_id)

    async def reconcile(
        self,
        remote: RemoteArtifact,
        *,
        command_id: str,
        receipt: StartReceipt | None,
    ) -> ReconcileResult:
        return await self.reconcile_delegate(remote, command_id, receipt)


class DuplicateProviderError(RuntimeError):
    pass


class UnknownProviderError(KeyError):
    pass


class ProviderUnavailableError(RuntimeError):
    pass


class AdapterContractError(TypeError):
    pass


@dataclass(frozen=True, slots=True)
class _Registration:
    descriptor: AdapterDescriptor
    factory: AdapterFactory | None


class AdapterRegistry:
    def __init__(self) -> None:
        self._registrations: dict[str, _Registration] = {}
        self._provider_by_name: dict[str, str] = {}

    def register(
        self,
        descriptor: AdapterDescriptor,
        factory: AdapterFactory | None = None,
    ) -> None:
        if descriptor.availability is ProviderAvailability.OPERATIONAL and factory is None:
            raise TypeError("operational provider registration requires an adapter factory")
        if factory is not None and not callable(factory):
            raise TypeError("adapter factory must be callable")

        names = (descriptor.provider_id, *descriptor.aliases)
        collision = next((name for name in names if name in self._provider_by_name), None)
        if collision is not None:
            raise DuplicateProviderError(f"provider or alias {collision!r} is already registered")

        self._registrations[descriptor.provider_id] = _Registration(descriptor, factory)
        for name in names:
            self._provider_by_name[name] = descriptor.provider_id

    def lookup(self, provider_id_or_alias: str) -> AdapterDescriptor:
        provider_id = self._provider_by_name.get(provider_id_or_alias)
        if provider_id is None:
            raise UnknownProviderError(f"unknown provider {provider_id_or_alias!r}")
        return self._registrations[provider_id].descriptor

    def descriptors(
        self,
        *,
        availability: ProviderAvailability | None = None,
    ) -> tuple[AdapterDescriptor, ...]:
        descriptors = (
            registration.descriptor for registration in self._registrations.values()
        )
        if availability is not None:
            descriptors = (
                descriptor
                for descriptor in descriptors
                if descriptor.availability is availability
            )
        return tuple(sorted(descriptors, key=lambda descriptor: descriptor.provider_id))

    def create(self, provider_id_or_alias: str) -> PrinterAdapter:
        descriptor = self.lookup(provider_id_or_alias)
        if descriptor.availability is not ProviderAvailability.OPERATIONAL:
            raise ProviderUnavailableError(
                f"provider {descriptor.provider_id!r} is {descriptor.availability.value}"
            )
        factory = self._registrations[descriptor.provider_id].factory
        if factory is None:
            raise AdapterContractError(
                f"operational provider {descriptor.provider_id!r} has no adapter factory"
            )
        adapter = factory(descriptor)
        validate_adapter_contract(descriptor, adapter)
        return adapter


def validate_adapter_contract(
    descriptor: AdapterDescriptor,
    adapter: PrinterAdapter,
) -> None:
    if not isinstance(adapter, PrinterAdapter):
        raise AdapterContractError(
            f"factory for {descriptor.provider_id!r} did not return a PrinterAdapter"
        )
    if adapter.adapter_id != descriptor.provider_id:
        raise AdapterContractError(
            f"adapter_id {adapter.adapter_id!r} does not match provider_id "
            f"{descriptor.provider_id!r}"
        )
    if adapter.capabilities != descriptor.capabilities:
        raise AdapterContractError(
            f"adapter capabilities do not match descriptor for {descriptor.provider_id!r}"
        )


_TRANSFER_CAPABILITIES = AdapterCapabilities.of(
    AdapterCapability.FILE_UPLOAD,
    AdapterCapability.PRINT_START,
    AdapterCapability.START_RECONCILE,
)

BAMBU_DESCRIPTOR = AdapterDescriptor(
    provider_id="bambu",
    display_name="Bambu Lab",
    availability=ProviderAvailability.OPERATIONAL,
    capabilities=_TRANSFER_CAPABILITIES,
    supported_models=("p1s", "a1", "a1_mini"),
    transports=(
        TransportMetadata(
            kind=TransportKind.BAMBU_LAN_FTPS,
            scope=TransportScope.LAN,
            security=TransportSecurity.TLS_REQUIRED,
            default_port=990,
        ),
        TransportMetadata(
            kind=TransportKind.BAMBU_LAN_MQTT,
            scope=TransportScope.LAN,
            security=TransportSecurity.TLS_REQUIRED,
            default_port=8883,
        ),
    ),
)

MOONRAKER_DESCRIPTOR = AdapterDescriptor(
    provider_id="moonraker",
    display_name="Moonraker / Klipper",
    availability=ProviderAvailability.OPERATIONAL,
    capabilities=_TRANSFER_CAPABILITIES,
    supported_models=("generic_klipper", "snapmaker_u1"),
    transports=(
        TransportMetadata(
            kind=TransportKind.MOONRAKER_HTTP,
            scope=TransportScope.LAN,
            security=TransportSecurity.TLS_OPTIONAL,
            default_port=7125,
        ),
        TransportMetadata(
            kind=TransportKind.MOONRAKER_WEBSOCKET,
            scope=TransportScope.LAN,
            security=TransportSecurity.TLS_OPTIONAL,
            default_port=7125,
        ),
    ),
    aliases=("klipper", "snapmaker_u1"),
)

CURRENT_PROVIDER_DESCRIPTORS = (BAMBU_DESCRIPTOR, MOONRAKER_DESCRIPTOR)


def current_provider_registry(
    *,
    bambu_factory: AdapterFactory,
    moonraker_factory: AdapterFactory,
) -> AdapterRegistry:
    registry = AdapterRegistry()
    registry.register(BAMBU_DESCRIPTOR, bambu_factory)
    registry.register(MOONRAKER_DESCRIPTOR, moonraker_factory)
    return registry
