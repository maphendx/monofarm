import asyncio
import base64
import ftplib
import json
import ssl

from printers import bambu


class _FakeWebSocket:
    def __init__(self) -> None:
        self.messages: list[dict] = []

    async def send(self, payload: str) -> None:
        self.messages.append(json.loads(payload))


def test_bambu_ftps_connect_retries_timeouts_without_tls_downgrade(monkeypatch) -> None:
    attempts = 0
    failures: list[tuple[str, Exception]] = []

    def connect():
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise TimeoutError("The handshake operation timed out")
        return "connected"

    monkeypatch.setattr(bambu.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(
        bambu,
        "_bambu_mark_tls_failure",
        lambda ip, exc: failures.append((ip, exc)),
    )

    result = bambu._connect_bambu_ftps_with_retry(
        "192.168.31.73",
        connect,
    )

    assert result == "connected"
    assert attempts == 3
    assert failures == []


def test_bambu_ftps_connect_stops_after_bounded_attempts(monkeypatch) -> None:
    attempts = 0

    def connect():
        nonlocal attempts
        attempts += 1
        raise TimeoutError("The handshake operation timed out")

    monkeypatch.setattr(bambu.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(bambu, "_bambu_mark_tls_failure", lambda _ip, _exc: None)

    try:
        bambu._connect_bambu_ftps_with_retry("192.168.31.73", connect)
    except TimeoutError:
        pass
    else:
        raise AssertionError("expected the final handshake timeout to be raised")

    assert attempts == bambu.BAMBU_FTPS_CONNECT_ATTEMPTS


def test_bambu_ftps_certificate_error_never_downgrades_tls(monkeypatch) -> None:
    attempts = 0
    failures: list[Exception] = []

    def connect():
        nonlocal attempts
        attempts += 1
        raise ssl.SSLCertVerificationError("certificate verify failed")

    monkeypatch.setattr(bambu.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(
        bambu,
        "_bambu_mark_tls_failure",
        lambda _ip, exc: failures.append(exc),
    )

    try:
        bambu._connect_bambu_ftps_with_retry("192.168.31.73", connect)
    except ssl.SSLCertVerificationError:
        pass
    else:
        raise AssertionError("expected certificate verification to remain enforced")

    assert attempts == 1
    assert failures == []


def test_bambu_ftps_connect_closes_partial_socket_before_retry(monkeypatch) -> None:
    created = 0
    closed = 0

    class FailingFTP:
        def __init__(self, **_kwargs) -> None:
            nonlocal created
            created += 1
            self._sock = None

        def connect(self, *_args, **_kwargs) -> None:
            raise TimeoutError("The handshake operation timed out")

        def close(self) -> None:
            nonlocal closed
            closed += 1

    monkeypatch.setattr(ftplib, "FTP_TLS", FailingFTP)
    monkeypatch.setattr(bambu.time, "sleep", lambda _seconds: None)
    ws = _FakeWebSocket()

    asyncio.run(bambu.handle_bambu_upload(ws, {
        "id": "upload-1",
        "ip": "192.168.31.73",
        "access_code": "test-code",
        "filename": "model.3mf",
        "data_b64": base64.b64encode(b"test-3mf").decode(),
        "target_dir": "sdcard",
    }))

    assert created == bambu.BAMBU_FTPS_CONNECT_ATTEMPTS
    assert closed == created
    assert ws.messages[-1]["status"] == 502
