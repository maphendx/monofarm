"""Typed protocol-v2 printer command dispatch for the Monofarm edge runtime.

The cloud chooses a printer by its durable database ID. Network targets are
loaded separately from the authenticated runtime-config endpoint, so command
payloads cannot turn the agent into a generic LAN proxy.
"""

from __future__ import annotations

import ipaddress
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Protocol
from urllib.parse import urlsplit

try:
    from .command_runtime import (
        CommandExecutionResult,
        CommandNeedsReconcile,
        LeasedAgentCommand,
    )
    from .edge_runtime.adapters import (
        PrinterAdapter,
        ReconcileState,
        RemoteArtifact,
        StartReceipt,
        require_capabilities,
        AdapterCapability,
    )
    from .edge_runtime.artifact_spool import ArtifactDownloadSpec, ArtifactDownloader
    from .network_policy import NetworkPolicyError, require_registered_http_url
except ImportError:  # source-script / PyInstaller execution from agent directory
    from command_runtime import (
        CommandExecutionResult,
        CommandNeedsReconcile,
        LeasedAgentCommand,
    )
    from edge_runtime.adapters import (
        PrinterAdapter,
        ReconcileState,
        RemoteArtifact,
        StartReceipt,
        require_capabilities,
        AdapterCapability,
    )
    from edge_runtime.artifact_spool import ArtifactDownloadSpec, ArtifactDownloader
    from network_policy import NetworkPolicyError, require_registered_http_url


_COMMON_PRINTER_FIELDS = frozenset({"id", "transport", "name", "kind", "model"})
_PROVIDER_FIELDS = {
    "moonraker": frozenset({"moonraker_url"}),
    "bambu_lan": frozenset({"dev_id", "ip", "access_code"}),
}
_EMPTY_PAYLOAD_COMMANDS = frozenset(
    {
        "printer.status",
        "printer.pause",
        "printer.resume",
        "printer.cancel",
        "printer.snapshot",
    }
)
_UPLOAD_FIELDS = frozenset(
    {
        "source_url",
        "file_name",
        "expected_size",
        "expected_sha256",
        "expires_at",
    }
)
_REMOTE_FIELDS = frozenset({"remote_id", "file_name", "printer_reference", "options"})


class InvalidRuntimeConfig(ValueError):
    pass


class InvalidRuntimePayload(ValueError):
    pass


class ArtifactHttpClient(Protocol):
    def stream(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        follow_redirects: bool,
    ) -> Any: ...


@dataclass(frozen=True, slots=True)
class RuntimePrinter:
    id: int
    provider: str
    name: str
    kind: str
    model: str | None = None
    moonraker_url: str | None = None
    dev_id: str | None = None
    ip: str | None = None
    access_code: str | None = None

    @classmethod
    def from_wire(cls, value: Mapping[str, Any]) -> RuntimePrinter:
        if not isinstance(value, Mapping):
            raise InvalidRuntimeConfig("runtime printer must be an object")
        transport = value.get("transport")
        if transport not in _PROVIDER_FIELDS:
            raise InvalidRuntimeConfig(f"unsupported runtime printer transport: {transport!r}")
        allowed_fields = _COMMON_PRINTER_FIELDS | _PROVIDER_FIELDS[transport]
        unexpected = set(value) - allowed_fields
        if unexpected:
            raise InvalidRuntimeConfig(
                f"unexpected runtime printer fields: {', '.join(sorted(unexpected))}"
            )

        printer_id = value.get("id")
        if not isinstance(printer_id, int) or isinstance(printer_id, bool) or printer_id < 1:
            raise InvalidRuntimeConfig("runtime printer id must be a positive integer")
        name = _required_text(value.get("name"), "name", limit=200)
        kind = _required_text(value.get("kind"), "kind", limit=64)
        model = _optional_text(value.get("model"), "model", limit=120)

        if transport == "moonraker":
            moonraker_url = _required_text(
                value.get("moonraker_url"),
                "moonraker_url",
                limit=2048,
            ).rstrip("/")
            parsed = urlsplit(moonraker_url)
            try:
                require_registered_http_url(moonraker_url, {parsed.hostname or ""})
            except NetworkPolicyError as exc:
                raise InvalidRuntimeConfig(f"invalid Moonraker target: {exc}") from exc
            return cls(
                id=printer_id,
                provider="moonraker",
                name=name,
                kind=kind,
                model=model,
                moonraker_url=moonraker_url,
            )

        dev_id = _required_text(value.get("dev_id"), "dev_id", limit=128)
        ip = _required_text(value.get("ip"), "ip", limit=255)
        access_code = _required_text(value.get("access_code"), "access_code", limit=256)
        # Reuse the same fail-closed LAN validation used by the generic proxy.
        try:
            require_registered_http_url(f"http://{_url_host(ip)}", {ip})
        except NetworkPolicyError as exc:
            raise InvalidRuntimeConfig(f"invalid Bambu LAN target: {exc}") from exc
        return cls(
            id=printer_id,
            provider="bambu",
            name=name,
            kind=kind,
            model=model,
            dev_id=dev_id,
            ip=ip,
            access_code=access_code,
        )


class RuntimePrinterRegistry:
    """Atomically replace the authenticated device's fixed printer targets."""

    def __init__(self) -> None:
        self._printers: dict[int, RuntimePrinter] = {}
        self._artifact_hosts: frozenset[str] = frozenset()

    def replace(self, payload: Mapping[str, Any]) -> None:
        if not isinstance(payload, Mapping):
            raise InvalidRuntimeConfig("runtime config must be an object")
        unexpected = set(payload) - {
            "artifact_hosts",
            "device_id",
            "generated_at",
            "organization_id",
            "printers",
        }
        if unexpected:
            raise InvalidRuntimeConfig(
                f"unexpected runtime config fields: {', '.join(sorted(unexpected))}"
            )
        raw_printers = payload.get("printers")
        if not isinstance(raw_printers, list):
            raise InvalidRuntimeConfig("runtime config printers must be a list")
        raw_artifact_hosts = payload.get("artifact_hosts", [])
        if not isinstance(raw_artifact_hosts, list) or not all(
            isinstance(host, str) and host.strip() for host in raw_artifact_hosts
        ):
            raise InvalidRuntimeConfig("runtime config artifact_hosts must be a string list")
        artifact_hosts = frozenset(_normalize_artifact_host(host) for host in raw_artifact_hosts)
        parsed: dict[int, RuntimePrinter] = {}
        for raw in raw_printers:
            printer = RuntimePrinter.from_wire(raw)
            if printer.id in parsed:
                raise InvalidRuntimeConfig(f"duplicate runtime printer id {printer.id}")
            parsed[printer.id] = printer
        self._printers = parsed
        self._artifact_hosts = artifact_hosts

    def get(self, printer_id: int) -> RuntimePrinter | None:
        return self._printers.get(printer_id)

    def require(self, printer_id: int | None) -> RuntimePrinter:
        if printer_id is None:
            raise InvalidRuntimePayload("command printer_id is required")
        printer = self.get(printer_id)
        if printer is None:
            raise InvalidRuntimePayload(f"command printer_id {printer_id} is not assigned")
        return printer

    def ids(self) -> tuple[int, ...]:
        return tuple(sorted(self._printers))

    def require_artifact_source(self, source_url: str) -> None:
        parsed = urlsplit(source_url)
        host = (parsed.hostname or "").rstrip(".").lower()
        if parsed.scheme != "https" or not host or host not in self._artifact_hosts:
            raise InvalidRuntimePayload("artifact source host is not registered")


AdapterFactory = Callable[[RuntimePrinter, LeasedAgentCommand], PrinterAdapter]
ControlHandler = Callable[
    [RuntimePrinter, LeasedAgentCommand],
    Awaitable[CommandExecutionResult],
]


class PrinterCommandDispatcher:
    """Map strict typed commands to fixed configs and provider adapters."""

    def __init__(
        self,
        *,
        registry: RuntimePrinterRegistry,
        adapter_factory: AdapterFactory,
        control_handler: ControlHandler,
        artifact_downloader: ArtifactDownloader,
        artifact_client: ArtifactHttpClient,
    ) -> None:
        self.registry = registry
        self._adapter_factory = adapter_factory
        self._control_handler = control_handler
        self._artifact_downloader = artifact_downloader
        self._artifact_client = artifact_client

    async def execute(self, command: LeasedAgentCommand) -> CommandExecutionResult:
        printer = self.registry.require(command.printer_id)
        if command.command_type in _EMPTY_PAYLOAD_COMMANDS:
            if command.payload:
                raise InvalidRuntimePayload(
                    f"{command.command_type} does not accept payload fields"
                )
            return await self._control_handler(printer, command)
        if command.command_type == "printer.upload":
            return await self._upload(printer, command)
        if command.command_type == "printer.start":
            return await self._start(printer, command)
        if command.command_type == "printer.reconcile":
            return await self._reconcile(printer, command)
        raise InvalidRuntimePayload(f"unsupported command type {command.command_type!r}")

    async def _upload(
        self,
        printer: RuntimePrinter,
        command: LeasedAgentCommand,
    ) -> CommandExecutionResult:
        _require_exact_payload(command.payload, _UPLOAD_FIELDS, "printer.upload")
        expires_at = _optional_wire_timestamp(command.payload.get("expires_at"))
        spec = ArtifactDownloadSpec(
            command_id=command.command_id,
            source_url=_required_text(
                command.payload.get("source_url"),
                "source_url",
                limit=8192,
            ),
            file_name=_required_text(
                command.payload.get("file_name"),
                "file_name",
                limit=180,
            ),
            expected_size=_required_nonnegative_int(
                command.payload.get("expected_size"),
                "expected_size",
            ),
            expected_sha256=_required_text(
                command.payload.get("expected_sha256"),
                "expected_sha256",
                limit=64,
            ),
            expires_at=expires_at,
        )
        artifact = await self._artifact_downloader.download(spec, self._artifact_client)
        adapter = self._adapter_factory(printer, command)
        require_capabilities(adapter, AdapterCapability.FILE_UPLOAD)
        try:
            remote = await adapter.upload(artifact, _ignore_progress)
        finally:
            artifact.path.unlink(missing_ok=True)
        return CommandExecutionResult(
            {
                "provider": printer.provider,
                "remote_id": remote.remote_id,
                "file_name": remote.file_name,
                "size": artifact.size,
                "sha256": artifact.sha256,
            },
            ("delivered", "terminal"),
        )

    async def _start(
        self,
        printer: RuntimePrinter,
        command: LeasedAgentCommand,
    ) -> CommandExecutionResult:
        remote, _receipt = _remote_from_payload(command.payload, command.command_id)
        adapter = self._adapter_factory(printer, command)
        require_capabilities(adapter, AdapterCapability.PRINT_START)
        receipt = await adapter.start(remote, command_id=command.command_id)
        return CommandExecutionResult(
            {
                "provider": printer.provider,
                "remote_id": receipt.remote_id,
                "printer_reference": receipt.printer_reference,
            },
            ("delivered", "printer_ack", "terminal"),
        )

    async def _reconcile(
        self,
        printer: RuntimePrinter,
        command: LeasedAgentCommand,
    ) -> CommandExecutionResult:
        remote, receipt = _remote_from_payload(command.payload, command.command_id)
        adapter = self._adapter_factory(printer, command)
        require_capabilities(adapter, AdapterCapability.START_RECONCILE)
        result = await adapter.reconcile(
            remote,
            command_id=command.command_id,
            receipt=receipt,
        )
        if result.state is ReconcileState.UNKNOWN:
            raise CommandNeedsReconcile("printer start reconciliation is inconclusive")
        if result.state is ReconcileState.FAILED:
            raise RuntimeError("printer confirmed that the start failed")
        return CommandExecutionResult(
            {
                "provider": printer.provider,
                "remote_id": remote.remote_id,
                "state": result.state.value,
                "printer_reference": result.printer_reference,
            },
            ("printer_ack", "terminal"),
        )


def _remote_from_payload(
    payload: Mapping[str, Any],
    command_id: str,
) -> tuple[RemoteArtifact, StartReceipt | None]:
    allowed = _REMOTE_FIELDS if "printer_reference" in payload else _REMOTE_FIELDS - {"printer_reference"}
    _require_known_payload(payload, allowed, "remote command")
    remote_id = _required_text(payload.get("remote_id"), "remote_id", limit=512)
    path = PurePosixPath(remote_id)
    if path.is_absolute() or ".." in path.parts or "\\" in remote_id or not path.name:
        raise InvalidRuntimePayload("remote_id must be a relative printer file path")
    file_name = _required_text(payload.get("file_name"), "file_name", limit=180)
    if Path(file_name).name != file_name:
        raise InvalidRuntimePayload("file_name must be a plain file name")
    options = payload.get("options", {})
    if not isinstance(options, dict):
        raise InvalidRuntimePayload("options must be an object")
    reference = _optional_text(payload.get("printer_reference"), "printer_reference", limit=256)
    receipt = None
    if reference:
        receipt = StartReceipt(
            command_id=command_id,
            remote_id=remote_id,
            printer_reference=reference,
        )
    return RemoteArtifact(remote_id=remote_id, file_name=file_name), receipt


def _require_exact_payload(payload: Mapping[str, Any], fields: frozenset[str], name: str) -> None:
    if set(payload) != fields:
        missing = fields - set(payload)
        unexpected = set(payload) - fields
        details = []
        if missing:
            details.append(f"missing {', '.join(sorted(missing))}")
        if unexpected:
            details.append(f"unexpected {', '.join(sorted(unexpected))}")
        raise InvalidRuntimePayload(f"{name} payload is invalid: {'; '.join(details)}")


def _require_known_payload(payload: Mapping[str, Any], fields: frozenset[str], name: str) -> None:
    unexpected = set(payload) - fields
    if unexpected:
        raise InvalidRuntimePayload(
            f"{name} payload has unexpected fields: {', '.join(sorted(unexpected))}"
        )


def _required_text(value: object, field: str, *, limit: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise InvalidRuntimePayload(f"{field} must be non-empty text")
    normalized = value.strip()
    if len(normalized) > limit or "\x00" in normalized:
        raise InvalidRuntimePayload(f"{field} is invalid")
    return normalized


def _optional_text(value: object, field: str, *, limit: int) -> str | None:
    if value is None:
        return None
    return _required_text(value, field, limit=limit)


def _required_nonnegative_int(value: object, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise InvalidRuntimePayload(f"{field} must be a non-negative integer")
    return value


def _optional_wire_timestamp(value: object) -> float | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise InvalidRuntimePayload("expires_at must be an ISO timestamp or null")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise InvalidRuntimePayload("expires_at must be an ISO timestamp") from exc
    if parsed.tzinfo is None:
        raise InvalidRuntimePayload("expires_at must include timezone")
    return parsed.astimezone(timezone.utc).timestamp()


def _url_host(host: str) -> str:
    return f"[{host}]" if ":" in host and not host.startswith("[") else host


def _normalize_artifact_host(value: str) -> str:
    normalized = value.strip().rstrip(".").lower()
    try:
        parsed = urlsplit(f"//{normalized}")
        port = parsed.port
    except ValueError as exc:
        raise InvalidRuntimeConfig("runtime artifact host is invalid") from exc
    if (
        not parsed.hostname
        or parsed.hostname.rstrip(".").lower() != normalized
        or parsed.username is not None
        or parsed.password is not None
        or port is not None
    ):
        raise InvalidRuntimeConfig("runtime artifact host must be a plain hostname")
    try:
        address = ipaddress.ip_address(normalized)
    except ValueError:
        if "." not in normalized or normalized.endswith((".local", ".localhost")):
            raise InvalidRuntimeConfig("runtime artifact host must be a public hostname")
    else:
        if not address.is_global:
            raise InvalidRuntimeConfig("runtime artifact host must be a public address")
    return normalized


def _ignore_progress(sent: int, total: int) -> None:
    del sent, total
