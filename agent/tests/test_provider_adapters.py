import asyncio
import hashlib
import json
import ssl
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
import pytest

from agent.command_runtime import CommandNeedsReconcile, LeasedAgentCommand
from agent.edge_runtime.adapters import LocalArtifact, ReconcileState, RemoteArtifact
from agent.printer_runtime import RuntimePrinter
from agent.provider_adapters import (
    BambuLanAdapter,
    MoonrakerAdapter,
    UnsupportedProviderModel,
    build_provider_adapter,
)


COMMAND_ID = "019f0000-0000-7000-8000-000000000010"


def _command(
    command_type: str, payload: dict[str, Any] | None = None
) -> LeasedAgentCommand:
    payload = payload or {}
    digest = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    now = datetime.now(timezone.utc)
    return LeasedAgentCommand.from_wire(
        {
            "id": COMMAND_ID,
            "agent_device_id": "019f0000-0000-7000-8000-000000000001",
            "printer_id": 7,
            "command_type": command_type,
            "payload": payload,
            "payload_sha256": digest,
            "state": "leased",
            "attempt": 1,
            "deadline_at": (now + timedelta(minutes=5)).isoformat(),
            "lease_expires_at": (now + timedelta(seconds=30)).isoformat(),
        }
    )


def _moonraker_printer() -> RuntimePrinter:
    return RuntimePrinter(
        id=7,
        provider="moonraker",
        name="U1-07",
        kind="snapmaker_u1",
        model="snapmaker_u1",
        moonraker_url="https://192.168.1.70:7125/mainsail?printer=u1",
    )


def _bambu_printer(model: str = "a1_mini") -> RuntimePrinter:
    return RuntimePrinter(
        id=7,
        provider="bambu",
        name="Bambu-07",
        kind="bambu",
        model=model,
        dev_id="01P00A123456789",
        ip="192.168.1.71",
        access_code="12345678",
    )


def _artifact(tmp_path: Path, name: str = "велика модель.gcode.3mf") -> LocalArtifact:
    data = bytes(range(251)) * 1_100
    path = tmp_path / "artifact.bin"
    path.write_bytes(data)
    return LocalArtifact(
        path=path,
        file_name=name,
        size=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
        expires_at=None,
    )


class FakeTime:
    def __init__(self) -> None:
        self.value = 0.0

    def monotonic(self) -> float:
        return self.value

    async def sleep(self, seconds: float) -> None:
        self.value += seconds


class FakeFtp:
    def __init__(self) -> None:
        self.connected: tuple[str, int, float] | None = None
        self.login_args: tuple[str, str] | None = None
        self.events: list[tuple[str, float | None]] = []
        self._timeout: float | None = None
        self.sock = FakeFtpSocket(self.events)
        self.protected = False
        self.cwd_calls: list[str] = []
        self.stor_command: str | None = None
        self.read_sizes: list[int] = []
        self.uploaded = bytearray()
        self.quit_called = False

    def connect(self, host: str, port: int, timeout: float) -> None:
        self.connected = (host, port, timeout)
        self.events.append(("connect", timeout))

    def login(self, user: str, passwd: str) -> None:
        self.login_args = (user, passwd)
        self.events.append(("login", None))

    @property
    def timeout(self) -> float | None:
        return self._timeout

    @timeout.setter
    def timeout(self, value: float) -> None:
        self._timeout = value
        self.events.append(("ftp_timeout", value))

    def prot_p(self) -> None:
        self.protected = True

    def cwd(self, path: str) -> None:
        self.cwd_calls.append(path)

    def storbinary(self, command, file_obj, blocksize, callback) -> None:
        self.stor_command = command
        self.events.append(("storbinary", None))
        while True:
            chunk = file_obj.read(blocksize * 8)
            self.read_sizes.append(len(chunk))
            if not chunk:
                break
            self.uploaded.extend(chunk)
            callback(chunk)

    def quit(self) -> None:
        self.quit_called = True

    def close(self) -> None:
        self.quit_called = True


class FakeFtpSocket:
    def __init__(self, events: list[tuple[str, float | None]]) -> None:
        self.events = events
        self.timeout: float | None = None

    def settimeout(self, value: float) -> None:
        self.timeout = value
        self.events.append(("socket_timeout", value))


def test_moonraker_upload_is_bounded_multipart_and_never_starts(tmp_path: Path) -> None:
    requests: list[tuple[str, str, bytes]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        body = await request.aread()
        requests.append((request.method, request.url.path, body))
        return httpx.Response(
            200,
            request=request,
            json={"result": {"item": {"path": "large.gcode"}}},
        )

    progress: list[int] = []
    adapter = MoonrakerAdapter(
        _moonraker_printer(),
        _command("printer.upload"),
        tls_verify=ssl.create_default_context(),
        http_transport=httpx.MockTransport(handler),
    )
    artifact = _artifact(tmp_path, "large.gcode")

    remote = asyncio.run(
        adapter.upload(artifact, lambda sent, _total: progress.append(sent))
    )

    assert remote == RemoteArtifact(remote_id="large.gcode", file_name="large.gcode")
    assert [item[:2] for item in requests] == [("POST", "/server/files/upload")]
    assert b'name="print"' in requests[0][2]
    assert b"false" in requests[0][2]
    assert b"/printer/print/start" not in requests[0][2]
    assert progress[-1] == artifact.size
    assert (
        max(current - previous for previous, current in zip([0, *progress], progress))
        <= 64 * 1024
    )


def test_moonraker_upload_then_separate_start_waits_for_semantic_state(
    tmp_path: Path,
) -> None:
    events: list[str] = []
    statuses = ["standby", "printing"]

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/server/files/upload":
            await request.aread()
            events.append("upload")
            return httpx.Response(
                200,
                request=request,
                json={"result": {"item": {"path": "model.gcode"}}},
            )
        if request.url.path == "/printer/print/start":
            events.append("start")
            assert dict(request.url.params) == {"filename": "model.gcode"}
            return httpx.Response(200, request=request, json={"result": "ok"})
        events.append("status")
        state = statuses.pop(0)
        return _moonraker_status(request, "model.gcode", state)

    fake_time = FakeTime()
    adapter = MoonrakerAdapter(
        _moonraker_printer(),
        _command("printer.start"),
        tls_verify=True,
        http_transport=httpx.MockTransport(handler),
        sleep=fake_time.sleep,
        monotonic=fake_time.monotonic,
        confirm_timeout=2,
        poll_interval=1,
    )
    artifact = _artifact(tmp_path, "model.gcode")

    remote = asyncio.run(adapter.upload(artifact, lambda *_: None))
    receipt = asyncio.run(adapter.start(remote, command_id=COMMAND_ID))

    assert events == ["upload", "start", "status", "status"]
    assert receipt.command_id == COMMAND_ID
    assert receipt.remote_id == "model.gcode"
    assert receipt.printer_reference == "model.gcode"


def test_moonraker_lost_start_ack_is_resolved_by_semantic_reconcile() -> None:
    calls: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        if request.url.path == "/printer/print/start":
            raise httpx.ReadTimeout("ACK lost", request=request)
        return _moonraker_status(request, "model.gcode", "printing")

    adapter = MoonrakerAdapter(
        _moonraker_printer(),
        _command("printer.start"),
        tls_verify=True,
        http_transport=httpx.MockTransport(handler),
    )

    receipt = asyncio.run(
        adapter.start(
            RemoteArtifact("model.gcode", "model.gcode"), command_id=COMMAND_ID
        )
    )

    assert calls == ["/printer/print/start", "/printer/objects/query"]
    assert receipt.printer_reference == "model.gcode"


def test_moonraker_reconcile_does_not_match_a_different_filename() -> None:
    adapter = MoonrakerAdapter(
        _moonraker_printer(),
        _command("printer.reconcile"),
        tls_verify=True,
        http_transport=httpx.MockTransport(
            lambda request: _moonraker_status(request, "other.gcode", "printing")
        ),
    )

    result = asyncio.run(
        adapter.reconcile(
            RemoteArtifact("model.gcode", "model.gcode"),
            command_id=COMMAND_ID,
            receipt=None,
        )
    )

    assert result.state is ReconcileState.UNKNOWN


@pytest.mark.parametrize(
    ("state", "expected"),
    [
        ("printing", ReconcileState.PRINTING),
        ("paused", ReconcileState.PRINTING),
        ("error", ReconcileState.FAILED),
        ("standby", ReconcileState.UNKNOWN),
    ],
)
def test_moonraker_reconcile_uses_exact_filename_and_semantic_state(
    state: str,
    expected: ReconcileState,
) -> None:
    transport = httpx.MockTransport(
        lambda request: _moonraker_status(request, "model.gcode", state)
    )
    adapter = MoonrakerAdapter(
        _moonraker_printer(),
        _command("printer.reconcile"),
        tls_verify=True,
        http_transport=transport,
    )

    result = asyncio.run(
        adapter.reconcile(
            RemoteArtifact("model.gcode", "model.gcode"),
            command_id=COMMAND_ID,
            receipt=None,
        )
    )

    assert result.state is expected


@pytest.mark.parametrize(
    ("command_type", "path", "confirmed_state"),
    [
        ("printer.pause", "/printer/print/pause", "paused"),
        ("printer.resume", "/printer/print/resume", "printing"),
        ("printer.cancel", "/printer/print/cancel", "cancelled"),
    ],
)
def test_moonraker_controls_use_fixed_endpoints_and_confirm_state(
    command_type: str,
    path: str,
    confirmed_state: str,
) -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        if request.url.path == path:
            return httpx.Response(200, request=request, json={"result": "ok"})
        return _moonraker_status(request, "model.gcode", confirmed_state)

    adapter = MoonrakerAdapter(
        _moonraker_printer(),
        _command(command_type),
        tls_verify=True,
        http_transport=httpx.MockTransport(handler),
    )

    result = asyncio.run(adapter.execute_control(command_type))

    assert calls == [path, "/printer/objects/query"]
    assert result.payload["state"] == confirmed_state
    assert result.milestones == ("delivered", "printer_ack", "terminal")


@pytest.mark.parametrize(
    ("model", "expected_prefix"),
    [("a1", ""), ("a1 mini", ""), ("N1", ""), ("p1s", "cache/")],
)
def test_bambu_ftps_upload_streams_to_model_aware_safe_path(
    tmp_path: Path,
    model: str,
    expected_prefix: str,
) -> None:
    ftp = FakeFtp()
    progress: list[int] = []
    adapter = _bambu_adapter(
        _command("printer.upload"),
        model=model,
        ftp=ftp,
    )
    artifact = _artifact(tmp_path)

    remote = asyncio.run(
        adapter.upload(artifact, lambda sent, _total: progress.append(sent))
    )

    assert remote.remote_id.startswith(expected_prefix)
    assert remote.remote_id.isascii()
    assert remote.remote_id.endswith(".gcode.3mf")
    assert "/" not in remote.remote_id.removeprefix("cache/")
    assert ftp.connected == ("192.168.1.71", 990, 15.0)
    assert ftp.login_args == ("bblp", "12345678")
    assert ftp.timeout == 120.0
    assert ftp.sock.timeout == 120.0
    event_names = [event[0] for event in ftp.events]
    assert event_names.index("connect") < event_names.index("login")
    assert event_names.index("login") < event_names.index("ftp_timeout")
    assert event_names.index("ftp_timeout") < event_names.index("socket_timeout")
    assert event_names.index("socket_timeout") < event_names.index("storbinary")
    assert ftp.protected is True
    assert ftp.cwd_calls == (["cache"] if model == "p1s" else [])
    assert bytes(ftp.uploaded) == artifact.path.read_bytes()
    assert max(ftp.read_sizes) <= 64 * 1024
    assert progress[-1] == artifact.size
    assert ftp.quit_called is True


def test_bambu_start_uses_stable_task_id_validated_options_and_exact_correlation() -> (
    None
):
    published: list[tuple[RuntimePrinter, dict[str, Any], int]] = []
    states = [
        {"print": {"task_id": "different-task", "gcode_state": "RUNNING"}},
        {"print": {"task_id": COMMAND_ID, "gcode_state": "PREPARE"}},
    ]

    async def publish(printer, payload, qos) -> None:
        published.append((printer, payload, qos))

    async def state_provider(_printer) -> dict[str, Any]:
        return states.pop(0)

    fake_time = FakeTime()
    command = _command(
        "printer.start",
        {
            "remote_id": "cache/model.gcode.3mf",
            "file_name": "Original model.gcode.3mf",
            "options": {
                "ams_mapping": [0, 1, -1, 3],
                "use_ams": True,
                "plate_gcode": "Metadata/plate_2.gcode",
                "auto_bed_leveling": False,
                "flow_calibration": True,
            },
        },
    )
    adapter = _bambu_adapter(
        command,
        model="p1s",
        publish=publish,
        state_provider=state_provider,
        sleep=fake_time.sleep,
        monotonic=fake_time.monotonic,
    )

    receipt = asyncio.run(
        adapter.start(
            RemoteArtifact("cache/model.gcode.3mf", "Original model.gcode.3mf"),
            command_id=COMMAND_ID,
        )
    )

    assert len(published) == 1
    printer, payload, qos = published[0]
    assert printer.id == 7
    assert qos == 1
    assert payload["print"]["command"] == "project_file"
    assert payload["print"]["task_id"] == COMMAND_ID
    assert payload["print"]["url"] == "file:///sdcard/cache/model.gcode.3mf"
    assert payload["print"]["param"] == "Metadata/plate_2.gcode"
    assert payload["print"]["ams_mapping"] == [0, 1, -1, 3]
    assert payload["print"]["bed_leveling"] is False
    assert payload["print"]["flow_cali"] is True
    assert receipt.printer_reference == COMMAND_ID


def test_bambu_start_delivery_without_matching_push_requires_reconcile() -> None:
    async def publish(*_args) -> None:
        return None

    async def wrong_state(_printer) -> dict[str, Any]:
        return {"print": {"task_id": "wrong", "gcode_state": "RUNNING"}}

    fake_time = FakeTime()
    adapter = _bambu_adapter(
        _command("printer.start"),
        publish=publish,
        state_provider=wrong_state,
        sleep=fake_time.sleep,
        monotonic=fake_time.monotonic,
        confirm_timeout=2,
        poll_interval=1,
    )

    with pytest.raises(CommandNeedsReconcile, match="matching task_id"):
        asyncio.run(
            adapter.start(
                RemoteArtifact("model.gcode.3mf", "model.gcode.3mf"),
                command_id=COMMAND_ID,
            )
        )


def test_bambu_start_can_use_job_correlation_distinct_from_command_id() -> None:
    task_id = "219f0000-0000-7000-8000-000000000010"
    published: list[dict[str, Any]] = []

    async def publish(_printer, payload, _qos) -> None:
        published.append(payload)

    async def state_provider(_printer) -> dict[str, Any]:
        return {"print": {"task_id": task_id, "gcode_state": "RUNNING"}}

    command = _command(
        "printer.start",
        {
            "remote_id": "model.gcode.3mf",
            "file_name": "model.gcode.3mf",
            "options": {"task_id": task_id},
        },
    )
    adapter = _bambu_adapter(
        command,
        publish=publish,
        state_provider=state_provider,
    )

    receipt = asyncio.run(
        adapter.start(
            RemoteArtifact("model.gcode.3mf", "model.gcode.3mf"),
            command_id=COMMAND_ID,
        )
    )

    assert published[0]["print"]["task_id"] == task_id
    assert receipt.command_id == COMMAND_ID
    assert receipt.printer_reference == task_id


def test_bambu_lost_mqtt_delivery_ack_still_uses_exact_push_correlation() -> None:
    async def lost_delivery_ack(*_args) -> None:
        raise TimeoutError("PUBACK lost")

    async def matching_state(_printer) -> dict[str, Any]:
        return {"print": {"task_id": COMMAND_ID, "gcode_state": "RUNNING"}}

    adapter = _bambu_adapter(
        _command("printer.start"),
        publish=lost_delivery_ack,
        state_provider=matching_state,
    )

    receipt = asyncio.run(
        adapter.start(
            RemoteArtifact("model.gcode.3mf", "model.gcode.3mf"),
            command_id=COMMAND_ID,
        )
    )

    assert receipt.printer_reference == COMMAND_ID


@pytest.mark.parametrize(
    ("task_id", "state", "expected"),
    [
        (COMMAND_ID, "RUNNING", ReconcileState.PRINTING),
        (COMMAND_ID, "PAUSE", ReconcileState.PRINTING),
        (COMMAND_ID, "FAILED", ReconcileState.FAILED),
        (COMMAND_ID, "FINISH", ReconcileState.PRINTER_ACK),
        ("different", "RUNNING", ReconcileState.UNKNOWN),
    ],
)
def test_bambu_reconcile_requires_exact_task_id(
    task_id: str,
    state: str,
    expected: ReconcileState,
) -> None:
    async def state_provider(_printer) -> dict[str, Any]:
        return {"print": {"task_id": task_id, "gcode_state": state}}

    adapter = _bambu_adapter(
        _command("printer.reconcile"),
        state_provider=state_provider,
    )

    result = asyncio.run(
        adapter.reconcile(
            RemoteArtifact("model.gcode.3mf", "model.gcode.3mf"),
            command_id=COMMAND_ID,
            receipt=None,
        )
    )

    assert result.state is expected


@pytest.mark.parametrize(
    ("command_type", "mqtt_command", "confirmed_state", "public_state"),
    [
        ("printer.pause", "pause", "PAUSE", "paused"),
        ("printer.resume", "resume", "RUNNING", "printing"),
        ("printer.cancel", "stop", "IDLE", "idle"),
    ],
)
def test_bambu_controls_wait_for_semantic_state(
    command_type: str,
    mqtt_command: str,
    confirmed_state: str,
    public_state: str,
) -> None:
    published: list[tuple[dict[str, Any], int]] = []
    states = ["PREPARE", confirmed_state]

    async def publish(_printer, payload, qos) -> None:
        published.append((payload, qos))

    async def state_provider(_printer) -> dict[str, Any]:
        return {"print": {"gcode_state": states.pop(0)}}

    fake_time = FakeTime()
    adapter = _bambu_adapter(
        _command(command_type),
        publish=publish,
        state_provider=state_provider,
        sleep=fake_time.sleep,
        monotonic=fake_time.monotonic,
    )

    result = asyncio.run(adapter.execute_control(command_type))

    assert published[0][0]["print"]["command"] == mqtt_command
    assert published[0][1] == 1
    assert result.payload["state"] == public_state
    assert result.milestones == ("delivered", "printer_ack", "terminal")


def test_bambu_rejects_arbitrary_remote_urls_and_unknown_options() -> None:
    command = _command(
        "printer.start",
        {
            "remote_id": "https://attacker.invalid/model.3mf",
            "file_name": "model.3mf",
            "options": {"custom_url": "https://attacker.invalid/model.3mf"},
        },
    )
    adapter = _bambu_adapter(command)

    with pytest.raises(ValueError, match="remote path"):
        asyncio.run(
            adapter.start(
                RemoteArtifact("https://attacker.invalid/model.3mf", "model.3mf"),
                command_id=COMMAND_ID,
            )
        )

    safe_remote = RemoteArtifact("model.3mf", "model.3mf")
    with pytest.raises(ValueError, match="options"):
        asyncio.run(adapter.start(safe_remote, command_id=COMMAND_ID))


def test_factory_reuses_truthful_models_and_rejects_unassigned_command() -> None:
    kwargs = {
        "bambu_ssl_context": ssl.create_default_context,
        "bambu_mqtt_publish": _noop_publish,
        "bambu_state_provider": _idle_state,
        "moonraker_tls_verify": True,
    }

    adapter = build_provider_adapter(
        _bambu_printer("A1 mini"), _command("printer.status"), **kwargs
    )
    assert isinstance(adapter, BambuLanAdapter)

    with pytest.raises(UnsupportedProviderModel):
        build_provider_adapter(
            _bambu_printer("x1c"), _command("printer.status"), **kwargs
        )

    wrong_printer = _command("printer.status")
    object.__setattr__(wrong_printer, "printer_id", 99)
    with pytest.raises(ValueError, match="not assigned"):
        build_provider_adapter(_moonraker_printer(), wrong_printer, **kwargs)


def _moonraker_status(
    request: httpx.Request,
    filename: str,
    state: str,
) -> httpx.Response:
    assert request.url.path == "/printer/objects/query"
    assert dict(request.url.params) == {"print_stats": ""}
    return httpx.Response(
        200,
        request=request,
        json={
            "result": {
                "status": {
                    "print_stats": {
                        "filename": filename,
                        "state": state,
                        "message": "",
                    }
                }
            }
        },
    )


def _bambu_adapter(
    command: LeasedAgentCommand,
    *,
    model: str = "a1_mini",
    ftp: FakeFtp | None = None,
    publish=None,
    state_provider=None,
    sleep=asyncio.sleep,
    monotonic=None,
    confirm_timeout: float = 5,
    poll_interval: float = 0.1,
) -> BambuLanAdapter:
    ftp = ftp or FakeFtp()
    return BambuLanAdapter(
        _bambu_printer(model),
        command,
        ssl_context_factory=ssl.create_default_context,
        mqtt_publish=publish or _noop_publish,
        state_provider=state_provider or _idle_state,
        ftps_factory=lambda _context: ftp,
        sleep=sleep,
        monotonic=monotonic,
        confirm_timeout=confirm_timeout,
        poll_interval=poll_interval,
    )


async def _noop_publish(*_args) -> None:
    return None


async def _idle_state(_printer) -> dict[str, Any]:
    return {"print": {"gcode_state": "IDLE"}}
