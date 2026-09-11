import asyncio
from types import SimpleNamespace

from core import runtime
from core.runtime import _websocket_error_code


def test_websocket_error_code_supports_legacy_handshake_status() -> None:
    error = SimpleNamespace(status_code=403)

    assert _websocket_error_code(error) == 403


def test_websocket_error_code_supports_current_handshake_status() -> None:
    error = SimpleNamespace(response=SimpleNamespace(status_code=401))

    assert _websocket_error_code(error) == 401


def test_websocket_error_code_supports_current_close_frame() -> None:
    error = SimpleNamespace(rcvd=SimpleNamespace(code=4001))

    assert _websocket_error_code(error) == 4001


def test_websocket_error_code_supports_legacy_close_code() -> None:
    error = SimpleNamespace(code=4002)

    assert _websocket_error_code(error) == 4002


def test_relay_stops_after_current_websockets_auth_rejection(monkeypatch) -> None:
    class AuthRejected(runtime.websocket_exceptions.WebSocketException):
        response = SimpleNamespace(status_code=403)

    class RejectedConnection:
        async def __aenter__(self):
            raise AuthRejected("forbidden")

        async def __aexit__(self, *_args):
            return False

    attempts = 0

    def reject_connection(*_args, **_kwargs):
        nonlocal attempts
        attempts += 1
        return RejectedConnection()

    monkeypatch.setattr(runtime.websockets, "connect", reject_connection)
    monkeypatch.setattr(runtime.bambu, "ensure_bambu_mqtt_dependency", lambda: None)
    monkeypatch.setattr(runtime.telegram, "configure", lambda *_args: None)
    states: list[str] = []

    asyncio.run(
        runtime.run(
            "https://example.test",
            "invalid-token",
            agent_version="0.8.16",
            on_state=states.append,
            run_updates=False,
        )
    )

    assert attempts == 1
    assert states == ["connecting", "disconnected"]
