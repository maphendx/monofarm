import asyncio
import json
import unittest
from contextlib import suppress
from unittest.mock import AsyncMock, MagicMock, patch

import monofarm_tray


class _FakeWebSocket:
    def __init__(
        self,
        *,
        host: str,
        origin: str | None,
        messages: list[str] | None = None,
    ) -> None:
        self.request_headers = {"Host": host}
        if origin is not None:
            self.request_headers["Origin"] = origin
        self._messages = iter(messages or [])
        self.sent: list[str] = []
        self.closed: list[tuple[int, str]] = []

    async def send(self, message: str) -> None:
        self.sent.append(message)

    async def close(self, *, code: int, reason: str) -> None:
        self.closed.append((code, reason))

    def __aiter__(self):
        return self

    async def __anext__(self) -> str:
        try:
            return next(self._messages)
        except StopIteration as exc:
            raise StopAsyncIteration from exc


class _FakeWebSocketServer:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args) -> None:
        return None


class AgentUiTests(unittest.IsolatedAsyncioTestCase):
    async def test_refresh_printers_updates_cache_and_broadcasts(self) -> None:
        app = monofarm_tray.App()
        printers = [{"id": "printer-1", "name": "A1 mini"}]
        app._fetch_printers = AsyncMock(return_value=printers)
        app._broadcast = AsyncMock()

        with patch.object(
            monofarm_tray,
            "load_config",
            return_value={
                "MONOFARM_SERVER": "https://api.monofarm.app",
                "MONOFARM_TOKEN": "token",
            },
        ):
            await app._refresh_printers()

        self.assertEqual(app._printers, printers)
        app._fetch_printers.assert_awaited_once_with(
            "https://api.monofarm.app", "token"
        )
        app._broadcast.assert_awaited_once_with(
            {"type": "printers", "printers": printers}
        )

    def test_ui_exposes_printers_logs_and_settings_views(self) -> None:
        html = monofarm_tray._HTML

        self.assertIn('data-view="printers"', html)
        self.assertIn('data-view="logs"', html)
        self.assertIn('data-view="settings"', html)
        self.assertIn('id="log-search"', html)
        self.assertIn("refreshPrinters()", html)

    def test_ui_uses_monofarm_brand_and_simplyprint_client_layout(self) -> None:
        html = monofarm_tray._HTML

        self.assertIn("--bg:#0b0b0d", html)
        self.assertIn('class="brand-wordmark"', html)
        self.assertIn('class="brand-logo"', html)
        self.assertIn("grid-template-columns:256px", html)
        self.assertIn('class="client-topbar"', html)
        self.assertIn('class="nav-cta"', html)
        self.assertIn('class="printer-card', html)
        self.assertIn('stroke-width="1.7"', html)
        self.assertNotIn("Edge bridge", html)
        self.assertNotIn('class="metric-row"', html)
        self.assertNotIn("grid-template-columns:220px", html)

    async def test_websocket_server_binds_only_to_loopback(self) -> None:
        app = monofarm_tray.App()
        serve = AsyncMock(return_value=_FakeWebSocketServer())

        with (
            patch.object(monofarm_tray.websockets, "serve", serve),
            patch.object(
                monofarm_tray,
                "load_config",
                return_value={
                    "MONOFARM_SERVER": "https://api.monofarm.app",
                    "MONOFARM_TOKEN": "",
                },
            ),
        ):
            task = asyncio.create_task(app._main())
            await asyncio.sleep(0)
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

        serve.assert_awaited_once_with(app._ws_handler, "127.0.0.1", monofarm_tray.UI_WS_PORT)

    def test_http_server_binds_only_to_loopback(self) -> None:
        server = MagicMock()
        with (
            patch.object(monofarm_tray, "HTTPServer", return_value=server) as http_server,
            patch.object(monofarm_tray.threading, "Thread") as thread,
        ):
            monofarm_tray._start_http_server()

        http_server.assert_called_once()
        self.assertEqual(
            http_server.call_args.args[0],
            ("127.0.0.1", monofarm_tray.UI_HTTP_PORT),
        )
        thread.assert_called_once_with(target=server.serve_forever, daemon=True)

    async def test_local_websocket_init_omits_token_and_refresh_still_works(self) -> None:
        app = monofarm_tray.App()
        app._run_printer_refresh = AsyncMock()
        secret = "eyJ-secret-user-jwt"
        websocket = _FakeWebSocket(
            host=f"localhost:{monofarm_tray.UI_WS_PORT}",
            origin=f"http://localhost:{monofarm_tray.UI_HTTP_PORT}",
            messages=[json.dumps({"type": "refresh_printers"})],
        )

        with patch.object(
            monofarm_tray,
            "load_config",
            return_value={
                "MONOFARM_SERVER": "https://api.monofarm.app",
                "MONOFARM_TOKEN": secret,
            },
        ):
            await app._ws_handler(websocket)
            await asyncio.sleep(0)

        self.assertFalse(websocket.closed)
        self.assertTrue(websocket.sent)
        init = json.loads(websocket.sent[0])
        self.assertEqual(init["type"], "init")
        self.assertNotIn("token", init)
        self.assertNotIn(secret, websocket.sent[0])
        app._run_printer_refresh.assert_awaited_once_with(websocket)

    async def test_websocket_rejects_non_loopback_host(self) -> None:
        app = monofarm_tray.App()
        websocket = _FakeWebSocket(
            host=f"farm-pc.local:{monofarm_tray.UI_WS_PORT}",
            origin=f"http://localhost:{monofarm_tray.UI_HTTP_PORT}",
        )

        await app._ws_handler(websocket)

        self.assertEqual(websocket.closed, [(1008, "Local UI requires loopback Host and Origin")])
        self.assertFalse(websocket.sent)

    async def test_websocket_rejects_non_loopback_origin(self) -> None:
        app = monofarm_tray.App()
        websocket = _FakeWebSocket(
            host=f"127.0.0.1:{monofarm_tray.UI_WS_PORT}",
            origin="https://attacker.example",
        )

        await app._ws_handler(websocket)

        self.assertEqual(websocket.closed, [(1008, "Local UI requires loopback Host and Origin")])
        self.assertFalse(websocket.sent)

    async def test_connect_without_browser_token_reuses_saved_token(self) -> None:
        app = monofarm_tray.App()
        app._do_start = AsyncMock()
        saved_token = "eyJ-saved-agent-jwt"
        websocket = _FakeWebSocket(
            host=f"127.0.0.1:{monofarm_tray.UI_WS_PORT}",
            origin=f"http://127.0.0.1:{monofarm_tray.UI_HTTP_PORT}",
            messages=[
                json.dumps(
                    {
                        "type": "connect",
                        "server": "https://api.monofarm.app",
                        "token": "",
                    }
                )
            ],
        )

        with (
            patch.object(
                monofarm_tray,
                "load_config",
                return_value={
                    "MONOFARM_SERVER": "https://api.monofarm.app",
                    "MONOFARM_TOKEN": saved_token,
                },
            ),
            patch.object(monofarm_tray, "save_config") as save_config,
        ):
            await app._ws_handler(websocket)

        save_config.assert_called_once_with("https://api.monofarm.app", saved_token)
        app._do_start.assert_awaited_once_with("https://api.monofarm.app", saved_token)

    async def test_successful_login_never_returns_jwt_to_browser(self) -> None:
        app = monofarm_tray.App()
        app._do_start = AsyncMock()
        websocket = AsyncMock()
        response = MagicMock(status_code=200, content=b"login")
        response.json.return_value = {"access_token": "eyJ-login-jwt"}
        pairing = MagicMock(status_code=201, content=b"pairing")
        pairing.json.return_value = {"pairing_code": "mf_pair_once"}
        client = AsyncMock()
        client.post.side_effect = [response, pairing]
        manager = AsyncMock()
        manager.__aenter__.return_value = client
        manager.__aexit__.return_value = None
        runtime = MagicMock()
        runtime._pair_device_flow = AsyncMock()

        with (
            patch.object(monofarm_tray.httpx, "AsyncClient", return_value=manager),
            patch.object(monofarm_tray, "save_config") as save_config,
            patch.object(monofarm_tray, "monofarm_agent", runtime),
        ):
            await app._do_login(
                "operator@example.com",
                "password",
                "https://api.monofarm.app",
                websocket,
            )

        payload = json.loads(websocket.send.await_args.args[0])
        self.assertEqual(payload, {"type": "login_ok"})
        self.assertNotIn("eyJ-login-jwt", websocket.send.await_args.args[0])
        save_config.assert_not_called()
        runtime._pair_device_flow.assert_awaited_once_with(
            "https://api.monofarm.app",
            "mf_pair_once",
        )
        app._do_start.assert_awaited_once_with("https://api.monofarm.app", "")

    async def test_saas_fetch_login_and_claim_clients_verify_tls(self) -> None:
        app = monofarm_tray.App()
        websocket = AsyncMock()
        config = {
            "MONOFARM_SERVER": "https://api.monofarm.app",
            "MONOFARM_TOKEN": "token",
        }

        async def assert_verified(operation, *, response_json) -> None:
            response = MagicMock(status_code=400, content=b"")
            response.json.return_value = response_json
            client = AsyncMock()
            client.get.return_value = response
            client.post.return_value = response
            manager = AsyncMock()
            manager.__aenter__.return_value = client
            manager.__aexit__.return_value = None

            with patch.object(monofarm_tray.httpx, "AsyncClient", return_value=manager) as factory:
                await operation()

            self.assertIsNot(factory.call_args.kwargs.get("verify", True), False)

        await assert_verified(
            lambda: app._fetch_printers(config["MONOFARM_SERVER"], config["MONOFARM_TOKEN"]),
            response_json=[],
        )
        with patch.object(monofarm_tray, "load_config", return_value=config):
            await assert_verified(
                lambda: app._do_claim_printer("device-1", websocket),
                response_json={},
            )
            await assert_verified(
                lambda: app._do_claim_moonraker("http://127.0.0.1", "Printer", websocket),
                response_json={},
            )
        await assert_verified(
            lambda: app._do_login(
                "operator@example.com",
                "password",
                config["MONOFARM_SERVER"],
                websocket,
            ),
            response_json={},
        )


if __name__ == "__main__":
    unittest.main()
