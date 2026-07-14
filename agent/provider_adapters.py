"""Concrete, bounded-memory printer adapters for the protocol-v2 edge runtime."""

from __future__ import annotations

import asyncio
import ftplib
import re
import ssl
import time
import unicodedata
from collections.abc import Awaitable, Callable, Mapping
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO, Protocol
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID

import httpx

try:
    from .command_runtime import (
        CommandExecutionResult,
        CommandNeedsReconcile,
        LeasedAgentCommand,
    )
    from .edge_runtime.adapters import (
        LocalArtifact,
        ProgressSink,
        ReconcileResult,
        ReconcileState,
        RemoteArtifact,
        StartReceipt,
    )
    from .edge_runtime.registry import BAMBU_DESCRIPTOR, MOONRAKER_DESCRIPTOR
    from .network_policy import NetworkPolicyError, require_registered_http_url
    from .printer_runtime import RuntimePrinter
except ImportError:  # source-script / PyInstaller execution from agent directory
    from command_runtime import (
        CommandExecutionResult,
        CommandNeedsReconcile,
        LeasedAgentCommand,
    )
    from edge_runtime.adapters import (
        LocalArtifact,
        ProgressSink,
        ReconcileResult,
        ReconcileState,
        RemoteArtifact,
        StartReceipt,
    )
    from edge_runtime.registry import BAMBU_DESCRIPTOR, MOONRAKER_DESCRIPTOR
    from network_policy import NetworkPolicyError, require_registered_http_url
    from printer_runtime import RuntimePrinter


_TRANSFER_CHUNK_SIZE = 64 * 1024
# Keep the proven legacy-agent split: fail a dead LAN endpoint quickly, then
# allow slow A1/A1 Mini MicroSD writes enough time once FTPS is authenticated.
_BAMBU_FTPS_CONNECT_TIMEOUT = 15.0
_BAMBU_FTPS_IO_TIMEOUT = 120.0
_MOONRAKER_STATUS_PATH = "/printer/objects/query"
_MOONRAKER_UPLOAD_PATH = "/server/files/upload"
_MOONRAKER_START_PATH = "/printer/print/start"
_MOONRAKER_CONTROL_PATHS = {
    "printer.pause": "/printer/print/pause",
    "printer.resume": "/printer/print/resume",
    "printer.cancel": "/printer/print/cancel",
}
_MOONRAKER_CONTROL_STATES = {
    "printer.pause": frozenset({"paused"}),
    "printer.resume": frozenset({"printing"}),
    "printer.cancel": frozenset(
        {"cancelled", "canceled", "complete", "completed", "standby", "ready"}
    ),
}
_MOONRAKER_ACTIVE_STATES = frozenset({"printing", "paused"})
_MOONRAKER_FAILED_STATES = frozenset({"error"})

_BAMBU_MODELS = frozenset(BAMBU_DESCRIPTOR.supported_models)
_BAMBU_MODEL_ALIASES = {"n1": "a1_mini"}
_MOONRAKER_MODELS = frozenset(MOONRAKER_DESCRIPTOR.supported_models)
_BAMBU_A1_MODELS = frozenset({"a1", "a1_mini"})
_BAMBU_ACTIVE_STATES = frozenset({"PREPARE", "RUNNING", "PAUSE", "SLICING"})
_BAMBU_FAILED_STATES = frozenset({"FAILED"})
_BAMBU_CONTROL_COMMANDS = {
    "printer.pause": "pause",
    "printer.resume": "resume",
    "printer.cancel": "stop",
}
_BAMBU_CONTROL_STATES = {
    "printer.pause": frozenset({"PAUSE"}),
    "printer.resume": frozenset({"RUNNING", "PREPARE"}),
    "printer.cancel": frozenset({"IDLE", "FINISH", "FAILED"}),
}
_BAMBU_OPTION_FIELDS = frozenset(
    {
        "ams_mapping",
        "auto_bed_leveling",
        "flow_calibration",
        "plate_gcode",
        "plate_index",
        "task_id",
        "timelapse",
        "use_ams",
    }
)
_PLATE_GCODE_PATTERN = re.compile(r"Metadata/plate_([1-9][0-9]*)\.gcode\Z")
_SAFE_REMOTE_NAME_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,159}\Z")

TlsVerify = bool | ssl.SSLContext
SslContextFactory = Callable[[], ssl.SSLContext]
Sleep = Callable[[float], Awaitable[None]]
Clock = Callable[[], float]
BambuMqttPublisher = Callable[[RuntimePrinter, Mapping[str, Any], int], Awaitable[None]]
BambuStateProvider = Callable[[RuntimePrinter], Awaitable[Mapping[str, Any]]]


class UnsupportedProviderModel(ValueError):
    """Raised when runtime config claims a model not validated by the provider."""


class ProviderProtocolError(RuntimeError):
    """Raised when a printer returns a structurally invalid response."""


class FtpsClient(Protocol):
    def connect(self, host: str, port: int, timeout: float) -> Any: ...

    def login(self, user: str, passwd: str) -> Any: ...

    def prot_p(self) -> Any: ...

    def cwd(self, path: str) -> Any: ...

    def storbinary(
        self,
        command: str,
        file_obj: BinaryIO,
        blocksize: int,
        callback: Callable[[bytes], None],
    ) -> Any: ...

    def quit(self) -> Any: ...

    def close(self) -> Any: ...


FtpsFactory = Callable[[ssl.SSLContext], FtpsClient]


class _BoundedProgressReader:
    """Cap every consumer read even when a transport asks for the whole file."""

    def __init__(self, file_obj: BinaryIO, total: int, progress: ProgressSink) -> None:
        self._file_obj = file_obj
        self._total = total
        self._progress = progress
        self._sent = 0

    def read(self, size: int = -1) -> bytes:
        requested = (
            _TRANSFER_CHUNK_SIZE if size < 0 else min(size, _TRANSFER_CHUNK_SIZE)
        )
        chunk = self._file_obj.read(requested)
        if chunk:
            self._sent += len(chunk)
            self._progress(self._sent, self._total)
        return chunk

    def seek(self, offset: int, whence: int = 0) -> int:
        return self._file_obj.seek(offset, whence)

    def tell(self) -> int:
        return self._file_obj.tell()

    def fileno(self) -> int:
        return self._file_obj.fileno()


class _ImplicitFTP_TLS(ftplib.FTP_TLS):
    """Implicit TLS command channel used by Bambu LAN FTPS on port 990."""

    _implicit_hostname: str | None = None

    def connect(
        self,
        host: str = "",
        port: int = 0,
        timeout: float = -999,
        source_address: tuple[str, int] | None = None,
    ) -> str:
        self._implicit_hostname = host
        return super().connect(host, port, timeout, source_address)

    @property
    def sock(self) -> Any:
        return self._sock

    @sock.setter
    def sock(self, value: Any) -> None:
        if value is not None and not isinstance(value, ssl.SSLSocket):
            server_hostname = (
                self._implicit_hostname if self.context.check_hostname else None
            )
            value = self.context.wrap_socket(value, server_hostname=server_hostname)
        self._sock = value

    def storbinary(
        self,
        cmd: str,
        fp: BinaryIO,
        blocksize: int = _TRANSFER_CHUNK_SIZE,
        callback: Callable[[bytes], None] | None = None,
        rest: int | None = None,
    ) -> str:
        # Bambu firmware may omit TLS close_notify on the data socket. The 226
        # command-channel response is the transfer confirmation.
        self.voidcmd("TYPE I")
        connection = self.transfercmd(cmd, rest)
        try:
            while chunk := fp.read(blocksize):
                connection.sendall(chunk)
                if callback is not None:
                    callback(chunk)
        finally:
            connection.close()
        return self.voidresp()


class MoonrakerAdapter:
    """Moonraker HTTP adapter with fixed endpoints and semantic confirmation."""

    adapter_id = MOONRAKER_DESCRIPTOR.provider_id
    capabilities = MOONRAKER_DESCRIPTOR.capabilities

    def __init__(
        self,
        printer: RuntimePrinter,
        command: LeasedAgentCommand,
        *,
        tls_verify: TlsVerify,
        http_transport: httpx.AsyncBaseTransport | None = None,
        sleep: Sleep = asyncio.sleep,
        monotonic: Clock | None = None,
        confirm_timeout: float = 20.0,
        poll_interval: float = 0.5,
    ) -> None:
        _require_assigned_command(printer, command)
        if printer.provider != "moonraker" or not printer.moonraker_url:
            raise ValueError(
                "Moonraker adapter requires a fixed Moonraker printer config"
            )
        model = _normalize_model(printer.model or "generic_klipper")
        if model not in _MOONRAKER_MODELS:
            raise UnsupportedProviderModel(
                f"Moonraker model {printer.model!r} is not validated"
            )
        self.printer = printer
        self.command = command
        self._base_url = _fixed_moonraker_base(printer.moonraker_url)
        self._tls_verify = tls_verify
        self._http_transport = http_transport
        self._sleep = sleep
        self._monotonic = monotonic or time.monotonic
        self._confirm_timeout = _positive_timeout(confirm_timeout, "confirm_timeout")
        self._poll_interval = _positive_timeout(poll_interval, "poll_interval")

    async def upload(
        self, artifact: LocalArtifact, progress: ProgressSink
    ) -> RemoteArtifact:
        _validate_local_artifact(artifact)
        _require_plain_file_name(artifact.file_name)
        progress(0, artifact.size)
        with artifact.path.open("rb") as file_obj:
            reader = _BoundedProgressReader(file_obj, artifact.size, progress)
            async with self._client() as client:
                response = await client.post(
                    self._url(_MOONRAKER_UPLOAD_PATH),
                    data={"root": "gcodes", "path": "", "print": "false"},
                    files={
                        "file": (
                            artifact.file_name,
                            reader,
                            "application/octet-stream",
                        )
                    },
                )
        _raise_for_printer_status(response, "Moonraker upload")
        returned_path = _moonraker_upload_path(_response_object(response))
        if returned_path is not None and returned_path != artifact.file_name:
            raise ProviderProtocolError("Moonraker returned an unexpected upload path")
        return RemoteArtifact(
            remote_id=artifact.file_name, file_name=artifact.file_name
        )

    async def start(self, remote: RemoteArtifact, *, command_id: str) -> StartReceipt:
        remote_id = _validate_moonraker_remote(remote.remote_id)
        try:
            await self._post(_MOONRAKER_START_PATH, params={"filename": remote_id})
        except httpx.TransportError:
            try:
                reconciled = await self.reconcile(
                    remote,
                    command_id=command_id,
                    receipt=None,
                )
            except (httpx.TransportError, ProviderProtocolError) as exc:
                raise CommandNeedsReconcile(
                    "Moonraker start ACK was lost and status is unavailable"
                ) from exc
            if reconciled.state is ReconcileState.PRINTING:
                return StartReceipt(command_id, remote_id, reconciled.printer_reference)
            if reconciled.state is ReconcileState.FAILED:
                raise RuntimeError("Moonraker confirmed that the print start failed")
            raise CommandNeedsReconcile("Moonraker start ACK was lost") from None

        state = await self._wait_for_filename(remote_id)
        if state in _MOONRAKER_FAILED_STATES:
            raise RuntimeError("Moonraker confirmed that the print start failed")
        if state not in _MOONRAKER_ACTIVE_STATES:
            raise CommandNeedsReconcile("Moonraker did not confirm the print start")
        return StartReceipt(command_id, remote_id, remote_id)

    async def reconcile(
        self,
        remote: RemoteArtifact,
        *,
        command_id: str,
        receipt: StartReceipt | None,
    ) -> ReconcileResult:
        del receipt
        remote_id = _validate_moonraker_remote(remote.remote_id)
        status = await self._status()
        if status["filename"] != remote_id:
            state = ReconcileState.UNKNOWN
        elif status["state"] in _MOONRAKER_ACTIVE_STATES:
            state = ReconcileState.PRINTING
        elif status["state"] in _MOONRAKER_FAILED_STATES:
            state = ReconcileState.FAILED
        else:
            state = ReconcileState.UNKNOWN
        reference = remote_id if state is not ReconcileState.UNKNOWN else None
        return ReconcileResult(command_id, state, reference)

    async def execute_control(self, command_type: str) -> CommandExecutionResult:
        _require_matching_control_command(self.command, command_type)
        if command_type == "printer.status":
            status = await self._status()
            return CommandExecutionResult(
                {
                    "provider": self.adapter_id,
                    "state": _moonraker_public_state(status["state"]),
                    "raw_state": status["state"],
                    "filename": status["filename"] or None,
                    "message": status["message"] or None,
                }
            )
        path = _MOONRAKER_CONTROL_PATHS.get(command_type)
        if path is None:
            raise ValueError(f"unsupported Moonraker control {command_type!r}")
        await self._post(path)
        status = await self._wait_for_states(_MOONRAKER_CONTROL_STATES[command_type])
        return CommandExecutionResult(
            {
                "provider": self.adapter_id,
                "state": status["state"],
                "filename": status["filename"] or None,
            },
            ("delivered", "printer_ack", "terminal"),
        )

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            verify=self._tls_verify,
            transport=self._http_transport,
            timeout=httpx.Timeout(60.0, connect=10.0),
        )

    def _url(self, path: str) -> str:
        return f"{self._base_url}{path}"

    async def _post(
        self,
        path: str,
        *,
        params: Mapping[str, str] | None = None,
    ) -> None:
        async with self._client() as client:
            response = await client.post(self._url(path), params=params)
        _raise_for_printer_status(response, f"Moonraker {path}")

    async def _status(self) -> dict[str, str]:
        async with self._client() as client:
            response = await client.get(
                self._url(_MOONRAKER_STATUS_PATH),
                params={"print_stats": ""},
            )
        _raise_for_printer_status(response, "Moonraker status")
        body = _response_object(response)
        try:
            print_stats = body["result"]["status"]["print_stats"]
        except (KeyError, TypeError) as exc:
            raise ProviderProtocolError(
                "Moonraker status is missing print_stats"
            ) from exc
        if not isinstance(print_stats, Mapping):
            raise ProviderProtocolError("Moonraker print_stats is not an object")
        return {
            "filename": _optional_protocol_text(print_stats.get("filename")),
            "state": _optional_protocol_text(print_stats.get("state")).lower(),
            "message": _optional_protocol_text(print_stats.get("message")),
        }

    async def _wait_for_filename(self, filename: str) -> str:
        deadline = self._monotonic() + self._confirm_timeout
        while True:
            try:
                status = await self._status()
            except httpx.TransportError:
                status = {"filename": "", "state": "unknown", "message": ""}
            if status["filename"] == filename and status["state"] in (
                _MOONRAKER_ACTIVE_STATES | _MOONRAKER_FAILED_STATES
            ):
                return status["state"]
            if self._monotonic() >= deadline:
                return "unknown"
            await self._sleep(self._poll_interval)

    async def _wait_for_states(self, expected: frozenset[str]) -> dict[str, str]:
        deadline = self._monotonic() + self._confirm_timeout
        while True:
            try:
                status = await self._status()
            except httpx.TransportError:
                status = {"filename": "", "state": "unknown", "message": ""}
            if status["state"] in expected:
                return status
            if status["state"] in _MOONRAKER_FAILED_STATES:
                raise RuntimeError(
                    f"Moonraker entered {status['state']} during control"
                )
            if self._monotonic() >= deadline:
                raise CommandNeedsReconcile(
                    "Moonraker did not confirm the control command"
                )
            await self._sleep(self._poll_interval)


class BambuLanAdapter:
    """Bambu LAN adapter: implicit FTPS delivery plus correlated MQTT control."""

    adapter_id = BAMBU_DESCRIPTOR.provider_id
    capabilities = BAMBU_DESCRIPTOR.capabilities

    def __init__(
        self,
        printer: RuntimePrinter,
        command: LeasedAgentCommand,
        *,
        ssl_context_factory: SslContextFactory,
        mqtt_publish: BambuMqttPublisher,
        state_provider: BambuStateProvider,
        ftps_factory: FtpsFactory | None = None,
        sleep: Sleep = asyncio.sleep,
        monotonic: Clock | None = None,
        confirm_timeout: float = 30.0,
        poll_interval: float = 0.5,
        ftps_connect_timeout: float = _BAMBU_FTPS_CONNECT_TIMEOUT,
        ftps_io_timeout: float = _BAMBU_FTPS_IO_TIMEOUT,
    ) -> None:
        _require_assigned_command(printer, command)
        if (
            printer.provider != "bambu"
            or not printer.dev_id
            or not printer.ip
            or not printer.access_code
        ):
            raise ValueError("Bambu adapter requires fixed LAN credentials")
        normalized_model = _normalize_model(printer.model or "")
        model = _BAMBU_MODEL_ALIASES.get(normalized_model, normalized_model)
        if model not in _BAMBU_MODELS:
            raise UnsupportedProviderModel(
                f"Bambu model {printer.model!r} is not validated"
            )
        self.printer = printer
        self.command = command
        self._model = model
        self._ssl_context_factory = ssl_context_factory
        self._mqtt_publish = mqtt_publish
        self._state_provider = state_provider
        self._ftps_factory = ftps_factory or (
            lambda context: _ImplicitFTP_TLS(context=context)
        )
        self._sleep = sleep
        self._monotonic = monotonic or time.monotonic
        self._confirm_timeout = _positive_timeout(confirm_timeout, "confirm_timeout")
        self._poll_interval = _positive_timeout(poll_interval, "poll_interval")
        self._ftps_connect_timeout = _positive_timeout(
            ftps_connect_timeout, "ftps_connect_timeout"
        )
        self._ftps_io_timeout = _positive_timeout(ftps_io_timeout, "ftps_io_timeout")

    async def upload(
        self, artifact: LocalArtifact, progress: ProgressSink
    ) -> RemoteArtifact:
        _validate_local_artifact(artifact)
        remote_name = _safe_bambu_file_name(artifact)
        progress(0, artifact.size)
        remote_id = await asyncio.to_thread(
            self._upload_sync, artifact, remote_name, progress
        )
        return RemoteArtifact(remote_id=remote_id, file_name=artifact.file_name)

    async def start(self, remote: RemoteArtifact, *, command_id: str) -> StartReceipt:
        remote_id = self._validate_remote(remote.remote_id)
        options = _validated_bambu_options(self.command.payload.get("options", {}))
        task_id = str(options.get("task_id") or command_id)
        payload = _bambu_start_payload(
            remote,
            remote_id,
            command_id,
            task_id,
            options,
        )
        delivery_error: OSError | None = None
        try:
            await self._mqtt_publish(self.printer, payload, 1)
        except OSError as exc:
            # A lost PUBACK is ambiguous: project_file may already be running.
            delivery_error = exc
        state = await self._wait_for_task(task_id)
        if state in _BAMBU_FAILED_STATES:
            raise RuntimeError("Bambu printer confirmed that the print start failed")
        if state is None:
            error = CommandNeedsReconcile(
                "Bambu push state did not contain matching task_id"
            )
            if delivery_error is not None:
                raise error from delivery_error
            raise error
        return StartReceipt(command_id, remote_id, task_id)

    async def reconcile(
        self,
        remote: RemoteArtifact,
        *,
        command_id: str,
        receipt: StartReceipt | None,
    ) -> ReconcileResult:
        self._validate_remote(remote.remote_id)
        options = _validated_bambu_options(self.command.payload.get("options", {}))
        expected_task_id = (
            receipt.printer_reference
            if receipt is not None and receipt.printer_reference
            else str(options.get("task_id") or command_id)
        )
        print_state = _bambu_print_state(await self._state_provider(self.printer))
        if _bambu_task_id(print_state) != expected_task_id:
            return ReconcileResult(command_id, ReconcileState.UNKNOWN)
        raw_state = _bambu_raw_state(print_state)
        if raw_state in _BAMBU_ACTIVE_STATES:
            state = ReconcileState.PRINTING
        elif raw_state in _BAMBU_FAILED_STATES:
            state = ReconcileState.FAILED
        else:
            state = ReconcileState.PRINTER_ACK
        return ReconcileResult(command_id, state, expected_task_id)

    async def execute_control(self, command_type: str) -> CommandExecutionResult:
        _require_matching_control_command(self.command, command_type)
        if command_type == "printer.status":
            state = _bambu_print_state(await self._state_provider(self.printer))
            raw_state = _bambu_raw_state(state)
            return CommandExecutionResult(
                {
                    "provider": self.adapter_id,
                    "state": _bambu_public_state(raw_state),
                    "raw_state": raw_state,
                    "filename": _bambu_filename(state),
                    "task_id": _bambu_task_id(state),
                }
            )
        mqtt_command = _BAMBU_CONTROL_COMMANDS.get(command_type)
        if mqtt_command is None:
            raise ValueError(f"unsupported Bambu control {command_type!r}")
        payload = {
            "print": {
                "command": mqtt_command,
                "param": "",
                "sequence_id": _stable_sequence_id(self.command.command_id),
            }
        }
        try:
            await self._mqtt_publish(self.printer, payload, 1)
        except OSError:
            # Pause/resume/stop are idempotent; state remains authoritative.
            pass
        state = await self._wait_for_states(_BAMBU_CONTROL_STATES[command_type])
        raw_state = _bambu_raw_state(state)
        return CommandExecutionResult(
            {
                "provider": self.adapter_id,
                "state": _bambu_public_state(raw_state),
                "raw_state": raw_state,
                "filename": _bambu_filename(state),
            },
            ("delivered", "printer_ack", "terminal"),
        )

    def _upload_sync(
        self,
        artifact: LocalArtifact,
        remote_name: str,
        progress: ProgressSink,
    ) -> str:
        context = self._ssl_context_factory()
        if not isinstance(context, ssl.SSLContext):
            raise TypeError("ssl_context_factory must return SSLContext")
        ftp = self._ftps_factory(context)
        connected = False
        try:
            ftp.connect(
                self.printer.ip or "",
                990,
                timeout=self._ftps_connect_timeout,
            )
            connected = True
            ftp.login(user="bblp", passwd=self.printer.access_code or "")
            ftp.timeout = self._ftps_io_timeout
            command_socket = getattr(ftp, "sock", None)
            if command_socket is None or not callable(
                getattr(command_socket, "settimeout", None)
            ):
                raise ProviderProtocolError("Bambu FTPS command socket is unavailable")
            command_socket.settimeout(self._ftps_io_timeout)
            ftp.prot_p()
            prefix = ""
            if self._model not in _BAMBU_A1_MODELS:
                try:
                    ftp.cwd("cache")
                except ftplib.error_perm:
                    mkd = getattr(ftp, "mkd", None)
                    if not callable(mkd):
                        raise
                    mkd("cache")
                    ftp.cwd("cache")
                prefix = "cache/"
            with artifact.path.open("rb") as file_obj:
                reader = _BoundedProgressReader(file_obj, artifact.size, progress)
                ftp.storbinary(
                    f"STOR {remote_name}",
                    reader,
                    blocksize=_TRANSFER_CHUNK_SIZE,
                    callback=lambda _chunk: None,
                )
            ftp.quit()
            connected = False
            return f"{prefix}{remote_name}"
        finally:
            if connected:
                try:
                    ftp.close()
                except ftplib.all_errors:
                    pass

    def _validate_remote(self, remote_id: str) -> str:
        expected_prefix = "" if self._model in _BAMBU_A1_MODELS else "cache/"
        if expected_prefix:
            if not remote_id.startswith(expected_prefix):
                raise ValueError("Bambu remote path does not match the printer model")
            name = remote_id.removeprefix(expected_prefix)
        else:
            name = remote_id
        if (
            not _SAFE_REMOTE_NAME_PATTERN.fullmatch(name)
            or not name.lower().endswith(".3mf")
            or "/" in name
            or "\\" in name
        ):
            raise ValueError("invalid Bambu remote path")
        return remote_id

    async def _wait_for_task(self, command_id: str) -> str | None:
        deadline = self._monotonic() + self._confirm_timeout
        while True:
            try:
                state = _bambu_print_state(await self._state_provider(self.printer))
            except OSError:
                state = {}
            if _bambu_task_id(state) == command_id:
                return _bambu_raw_state(state)
            if self._monotonic() >= deadline:
                return None
            await self._sleep(self._poll_interval)

    async def _wait_for_states(self, expected: frozenset[str]) -> Mapping[str, Any]:
        deadline = self._monotonic() + self._confirm_timeout
        while True:
            try:
                state = _bambu_print_state(await self._state_provider(self.printer))
            except OSError:
                state = {}
            if _bambu_raw_state(state) in expected:
                return state
            if self._monotonic() >= deadline:
                raise CommandNeedsReconcile(
                    "Bambu printer did not confirm the control command"
                )
            await self._sleep(self._poll_interval)


def build_provider_adapter(
    printer: RuntimePrinter,
    command: LeasedAgentCommand,
    *,
    bambu_ssl_context: SslContextFactory,
    bambu_mqtt_publish: BambuMqttPublisher,
    bambu_state_provider: BambuStateProvider,
    moonraker_tls_verify: TlsVerify,
    moonraker_http_transport: httpx.AsyncBaseTransport | None = None,
    bambu_ftps_factory: FtpsFactory | None = None,
    sleep: Sleep = asyncio.sleep,
    monotonic: Clock | None = None,
    confirm_timeout: float = 30.0,
    poll_interval: float = 0.5,
) -> MoonrakerAdapter | BambuLanAdapter:
    """Build an adapter only from an authenticated, assigned runtime printer."""

    _require_assigned_command(printer, command)
    if printer.provider == "moonraker":
        return MoonrakerAdapter(
            printer,
            command,
            tls_verify=moonraker_tls_verify,
            http_transport=moonraker_http_transport,
            sleep=sleep,
            monotonic=monotonic,
            confirm_timeout=confirm_timeout,
            poll_interval=poll_interval,
        )
    if printer.provider == "bambu":
        return BambuLanAdapter(
            printer,
            command,
            ssl_context_factory=bambu_ssl_context,
            mqtt_publish=bambu_mqtt_publish,
            state_provider=bambu_state_provider,
            ftps_factory=bambu_ftps_factory,
            sleep=sleep,
            monotonic=monotonic,
            confirm_timeout=confirm_timeout,
            poll_interval=poll_interval,
        )
    raise ValueError(f"unsupported runtime printer provider {printer.provider!r}")


def _fixed_moonraker_base(raw_url: str) -> str:
    parsed = urlsplit(raw_url.strip())
    host = parsed.hostname or ""
    try:
        require_registered_http_url(raw_url, {host})
    except NetworkPolicyError as exc:
        raise ValueError(f"invalid fixed Moonraker URL: {exc}") from exc
    return urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))


def _validate_local_artifact(artifact: LocalArtifact) -> None:
    try:
        stat_result = artifact.path.stat()
    except OSError as exc:
        raise ValueError("local artifact is unavailable") from exc
    if not artifact.path.is_file() or stat_result.st_size != artifact.size:
        raise ValueError("local artifact size does not match metadata")
    if len(artifact.sha256) != 64 or any(
        character not in "0123456789abcdef" for character in artifact.sha256.lower()
    ):
        raise ValueError("local artifact SHA-256 is invalid")


def _require_plain_file_name(file_name: str) -> None:
    if (
        not file_name
        or Path(file_name).name != file_name
        or "\x00" in file_name
        or len(file_name) > 180
    ):
        raise ValueError("artifact file_name must be a plain file name")


def _safe_bambu_file_name(artifact: LocalArtifact) -> str:
    _require_plain_file_name(artifact.file_name)
    lower = artifact.file_name.lower()
    if lower.endswith(".gcode.3mf"):
        suffix = ".gcode.3mf"
    elif lower.endswith(".3mf"):
        suffix = ".3mf"
    else:
        raise ValueError("Bambu LAN upload requires a 3MF artifact")
    stem = artifact.file_name[: -len(suffix)]
    ascii_stem = unicodedata.normalize("NFKD", stem).encode("ascii", "ignore").decode()
    safe_stem = re.sub(r"[^A-Za-z0-9._-]+", "-", ascii_stem).strip("._-")
    digest = artifact.sha256.lower()[:12]
    safe_stem = (safe_stem or "print")[:120].rstrip("._-")
    return f"{safe_stem}-{digest}{suffix}"


def _validate_moonraker_remote(remote_id: str) -> str:
    path = PurePosixPath(remote_id)
    if (
        not remote_id
        or path.is_absolute()
        or ".." in path.parts
        or "\\" in remote_id
        or "\x00" in remote_id
        or len(remote_id) > 512
    ):
        raise ValueError("invalid Moonraker remote path")
    return remote_id


def _response_object(response: httpx.Response) -> Mapping[str, Any]:
    try:
        body = response.json()
    except ValueError as exc:
        raise ProviderProtocolError("printer returned invalid JSON") from exc
    if not isinstance(body, Mapping):
        raise ProviderProtocolError("printer response must be an object")
    return body


def _moonraker_upload_path(body: Mapping[str, Any]) -> str | None:
    result = body.get("result")
    if not isinstance(result, Mapping):
        return None
    item = result.get("item")
    candidate = item.get("path") if isinstance(item, Mapping) else result.get("path")
    if candidate is None:
        return None
    if not isinstance(candidate, str):
        raise ProviderProtocolError("Moonraker upload path is not text")
    return candidate.removeprefix("gcodes/")


def _raise_for_printer_status(response: httpx.Response, action: str) -> None:
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise ProviderProtocolError(
            f"{action} failed with HTTP {response.status_code}"
        ) from exc


def _optional_protocol_text(value: object) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ProviderProtocolError("printer status text field has invalid type")
    return value.strip()


def _validated_bambu_options(value: object) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError("Bambu options must be an object")
    unexpected = set(value) - _BAMBU_OPTION_FIELDS
    if unexpected:
        raise ValueError(f"unsupported Bambu options: {', '.join(sorted(unexpected))}")
    options = dict(value)
    for field in ("use_ams", "auto_bed_leveling", "flow_calibration", "timelapse"):
        if field in options and not isinstance(options[field], bool):
            raise ValueError(f"Bambu option {field} must be boolean")
    plate_index = options.get("plate_index", 1)
    if (
        not isinstance(plate_index, int)
        or isinstance(plate_index, bool)
        or not 1 <= plate_index <= 999
    ):
        raise ValueError("Bambu option plate_index must be between 1 and 999")
    options["plate_index"] = plate_index
    plate_gcode = options.get("plate_gcode")
    if plate_gcode is not None and (
        not isinstance(plate_gcode, str)
        or not _PLATE_GCODE_PATTERN.fullmatch(plate_gcode)
    ):
        raise ValueError("Bambu option plate_gcode is invalid")
    mapping = options.get("ams_mapping")
    if mapping is not None:
        if (
            not isinstance(mapping, list)
            or len(mapping) > 16
            or any(
                not isinstance(slot, int)
                or isinstance(slot, bool)
                or not -1 <= slot <= 255
                for slot in mapping
            )
        ):
            raise ValueError("Bambu option ams_mapping is invalid")
        options["ams_mapping"] = list(mapping)
    task_id = options.get("task_id")
    if task_id is not None:
        if not isinstance(task_id, str) or len(task_id) not in {32, 36}:
            raise ValueError("Bambu option task_id must be a UUID")
        try:
            UUID(task_id)
        except ValueError as exc:
            raise ValueError("Bambu option task_id must be a UUID") from exc
    return options


def _bambu_start_payload(
    remote: RemoteArtifact,
    remote_id: str,
    command_id: str,
    task_id: str,
    options: Mapping[str, Any],
) -> dict[str, Any]:
    _require_plain_file_name(remote.file_name)
    plate_gcode = options.get("plate_gcode") or (
        f"Metadata/plate_{options.get('plate_index', 1)}.gcode"
    )
    bed_leveling = options.get("auto_bed_leveling", True)
    print_payload: dict[str, Any] = {
        "command": "project_file",
        "sequence_id": _stable_sequence_id(command_id),
        "task_id": task_id,
        "profile_id": "0",
        "project_id": "0",
        "subtask_id": "0",
        "param": plate_gcode,
        "subtask_name": remote.file_name,
        "url": f"file:///sdcard/{remote_id}",
        "file": "",
        "md5": "",
        "bed_type": "auto",
        "use_ams": options.get("use_ams", True),
        "timelapse": options.get("timelapse", False),
        "bed_leveling": bed_leveling,
        "bed_levelling": bed_leveling,
        "flow_cali": options.get("flow_calibration", False),
        "vibration_cali": True,
        "layer_inspect": False,
    }
    if "ams_mapping" in options:
        print_payload["ams_mapping"] = options["ams_mapping"]
    return {"print": print_payload}


def _bambu_print_state(value: Mapping[str, Any]) -> Mapping[str, Any]:
    nested = value.get("print")
    if isinstance(nested, Mapping):
        return nested
    return value


def _bambu_task_id(state: Mapping[str, Any]) -> str | None:
    for field in ("task_id", "taskId", "subtask_id", "subtaskId"):
        value = state.get(field)
        if isinstance(value, str) and value:
            return value
    return None


def _bambu_raw_state(state: Mapping[str, Any]) -> str:
    value = state.get("gcode_state", state.get("state", ""))
    return value.strip().upper() if isinstance(value, str) else ""


def _bambu_filename(state: Mapping[str, Any]) -> str | None:
    for field in ("subtask_name", "gcode_file", "filename"):
        value = state.get(field)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _bambu_public_state(raw_state: str) -> str:
    return {
        "IDLE": "idle",
        "RUNNING": "printing",
        "PREPARE": "printing",
        "SLICING": "printing",
        "PAUSE": "paused",
        "FINISH": "operational",
        "FAILED": "error",
    }.get(raw_state, "unknown")


def _moonraker_public_state(raw_state: str) -> str:
    return {
        "standby": "idle",
        "ready": "idle",
        "printing": "printing",
        "paused": "paused",
        "error": "error",
        "complete": "operational",
        "completed": "operational",
        "cancelled": "idle",
        "canceled": "idle",
    }.get(raw_state, "unknown")


def _normalize_model(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.strip().lower()).strip("_")


def _stable_sequence_id(command_id: str) -> str:
    try:
        value = UUID(command_id).int
    except ValueError as exc:
        raise ValueError("command_id must be a UUID") from exc
    return str(value % 2_147_483_647)


def _positive_timeout(value: float, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        raise ValueError(f"{field} must be positive")
    return float(value)


def _require_assigned_command(
    printer: RuntimePrinter,
    command: LeasedAgentCommand,
) -> None:
    if command.printer_id != printer.id:
        raise ValueError("command is not assigned to this runtime printer")


def _require_matching_control_command(
    command: LeasedAgentCommand,
    command_type: str,
) -> None:
    if command.command_type != command_type:
        raise ValueError("control command does not match the leased command")
