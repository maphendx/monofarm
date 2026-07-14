import base64
import asyncio
import json
import tempfile
import unittest
from urllib.parse import parse_qs, urlsplit
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import httpx

from device_identity import (
    DeviceCredentials,
    DeviceTokenProvider,
    pair_device,
)


class _Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def _response(payload: dict, status_code: int = 200) -> MagicMock:
    response = MagicMock(status_code=status_code)
    response.json.return_value = payload
    response.raise_for_status.return_value = None
    return response


class DeviceCredentialsTests(unittest.TestCase):
    def test_loads_only_complete_device_credentials(self) -> None:
        self.assertEqual(
            DeviceCredentials.from_mapping(
                {
                    "MONOFARM_DEVICE_ID": "device-1",
                    "MONOFARM_DEVICE_SECRET": "secret-1",
                }
            ),
            DeviceCredentials("device-1", "secret-1"),
        )
        self.assertIsNone(DeviceCredentials.from_mapping({"MONOFARM_DEVICE_ID": "device-1"}))


class DevicePairingTests(unittest.IsolatedAsyncioTestCase):
    async def test_pairing_generates_local_ed25519_identity(self) -> None:
        client = AsyncMock()
        client.post.return_value = _response(
            {
                "device_id": "019f-device",
                "device_secret": "mf_agent_secret",
                "access_token": "short-lived",
                "token_type": "bearer",
                "expires_in": 300,
            },
            status_code=201,
        )

        result = await pair_device(
            client,
            server="https://api.monofarm.app",
            pairing_code="mf_pair_once",
            name="Farm PC",
            capabilities=["protocol_v2", "durable_journal"],
        )

        request = client.post.await_args
        self.assertEqual(request.args[0], "https://api.monofarm.app/api/agent/v2/pair")
        self.assertEqual(request.kwargs["json"]["pairing_code"], "mf_pair_once")
        self.assertEqual(len(base64.b64decode(request.kwargs["json"]["public_key"])), 32)
        self.assertEqual(len(base64.b64decode(result.private_key)), 32)
        self.assertEqual(result.credentials.device_id, "019f-device")
        self.assertEqual(result.access_token, "short-lived")


class DeviceTokenProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_caches_then_refreshes_short_lived_token(self) -> None:
        clock = _Clock()
        client = AsyncMock()
        client.post.side_effect = [
            _response({"access_token": "first", "token_type": "bearer", "expires_in": 120}),
            _response({"access_token": "second", "token_type": "bearer", "expires_in": 120}),
        ]
        provider = DeviceTokenProvider(
            "https://api.monofarm.app",
            DeviceCredentials("device-1", "secret-1"),
            clock=clock,
        )

        self.assertEqual(await provider.get(client), "first")
        clock.now += 30
        self.assertEqual(await provider.get(client), "first")
        clock.now += 61
        self.assertEqual(await provider.get(client), "second")

        self.assertEqual(client.post.await_count, 2)
        self.assertEqual(
            client.post.await_args_list[0].kwargs["json"],
            {"device_id": "device-1", "device_secret": "secret-1"},
        )


class AgentRuntimeIdentityTests(unittest.TestCase):
    def test_browser_pairing_callback_accepts_only_matching_one_time_code(self) -> None:
        import monofarm_agent

        payload = monofarm_agent._parse_browser_pairing_payload(
            json.dumps(
                {
                    "pairing_code": "mf_pair_once_long_enough",
                    "state": "browser-state",
                }
            ).encode("utf-8"),
            expected_state="browser-state",
        )

        self.assertEqual(payload, "mf_pair_once_long_enough")
        with self.assertRaises(ValueError):
            monofarm_agent._parse_browser_pairing_payload(
                json.dumps(
                    {
                        "pairing_code": "mf_pair_once_long_enough",
                        "state": "wrong-state",
                    }
                ).encode("utf-8"),
                expected_state="browser-state",
            )
        with self.assertRaises(ValueError):
            monofarm_agent._parse_browser_pairing_payload(
                json.dumps(
                    {
                        "token": "legacy-user-jwt",
                        "state": "browser-state",
                    }
                ).encode("utf-8"),
                expected_state="browser-state",
            )

    def test_persisting_device_identity_removes_legacy_user_jwt(self) -> None:
        import monofarm_agent
        from device_identity import DevicePairingResult

        with tempfile.TemporaryDirectory() as directory:
            config_dir = Path(directory)
            config_file = config_dir / ".env"
            with (
                unittest.mock.patch.object(monofarm_agent, "CONFIG_DIR", config_dir),
                unittest.mock.patch.object(monofarm_agent, "CONFIG_FILE", config_file),
            ):
                monofarm_agent._write_config(
                    {
                        "MONOFARM_SERVER": "https://old.example",
                        "MONOFARM_TOKEN": "user-jwt-must-go",
                    }
                )
                monofarm_agent._save_device_pairing(
                    "https://api.monofarm.app",
                    DevicePairingResult(
                        credentials=DeviceCredentials("device-1", "secret-1"),
                        private_key=base64.b64encode(b"k" * 32).decode("ascii"),
                        access_token="short-lived",
                        expires_in=300,
                    ),
                )
                saved = monofarm_agent._load_config()

            self.assertEqual(saved["MONOFARM_DEVICE_ID"], "device-1")
            self.assertEqual(saved["MONOFARM_DEVICE_SECRET"], "secret-1")
            self.assertNotIn("MONOFARM_TOKEN", config_file.read_text(encoding="utf-8"))


class AgentRuntimeAuthTests(unittest.IsolatedAsyncioTestCase):
    async def test_browser_pairing_flow_transfers_only_code_with_state_and_exact_origin(self) -> None:
        import monofarm_agent

        opened: list[str] = []
        with (
            unittest.mock.patch.object(
                monofarm_agent,
                "_load_config",
                return_value={"MONOFARM_FRONTEND": "https://monofarm.app"},
            ),
            unittest.mock.patch("webbrowser.open", side_effect=opened.append),
        ):
            pending = asyncio.create_task(
                monofarm_agent._pair_flow("https://api.monofarm.app")
            )
            for _ in range(100):
                if opened:
                    break
                await asyncio.sleep(0.01)
            self.assertTrue(opened)
            browser_url = urlsplit(opened[0])
            query = parse_qs(browser_url.query)
            port = int(query["agent_pair"][0])
            state = query["agent_state"][0]
            callback = f"http://127.0.0.1:{port}/pair"

            async with httpx.AsyncClient(timeout=2) as client:
                rejected = await client.post(
                    callback,
                    headers={"Origin": "https://attacker.example"},
                    json={
                        "pairing_code": "mf_pair_once_long_enough",
                        "state": state,
                    },
                )
                self.assertEqual(rejected.status_code, 403)
                accepted = await client.post(
                    callback,
                    headers={"Origin": "https://monofarm.app"},
                    json={
                        "pairing_code": "mf_pair_once_long_enough",
                        "state": state,
                    },
                )
                self.assertEqual(accepted.status_code, 200)

            self.assertEqual(await pending, "mf_pair_once_long_enough")
            self.assertEqual(query["section"], ["integrations"])
            self.assertEqual(query["integration"], ["agent"])
            self.assertNotIn("token", query)

    async def test_device_identity_selects_v2_websocket(self) -> None:
        import monofarm_agent

        with (
            unittest.mock.patch.object(
                monofarm_agent,
                "_configured_device_credentials",
                return_value=DeviceCredentials("device-1", "secret-1"),
            ),
            unittest.mock.patch.object(
                monofarm_agent,
                "_get_runtime_access_token",
                new=AsyncMock(return_value="scoped-token"),
            ),
        ):
            ws_url, token = await monofarm_agent._websocket_credentials(
                "https://api.monofarm.app",
                "legacy-user-token",
            )

        self.assertEqual(token, "scoped-token")
        self.assertEqual(
            ws_url,
            "wss://api.monofarm.app/api/agent/v2/connect",
        )

    async def test_runtime_config_is_device_bound_and_populates_fixed_targets(self) -> None:
        import monofarm_agent
        from printer_runtime import RuntimePrinterRegistry

        response = MagicMock(status_code=200)
        response.raise_for_status.return_value = None
        response.json.return_value = {
            "device_id": "device-1",
            "organization_id": 7,
            "artifact_hosts": ["files.monofarm.app"],
            "printers": [
                {
                    "transport": "moonraker",
                    "id": 42,
                    "name": "U1",
                    "kind": "snapmaker_u1",
                    "moonraker_url": "http://192.168.1.42:7125",
                }
            ],
        }
        registry = RuntimePrinterRegistry()
        with (
            unittest.mock.patch.object(
                monofarm_agent,
                "_configured_device_credentials",
                return_value=DeviceCredentials("device-1", "secret-1"),
            ),
            unittest.mock.patch.object(
                monofarm_agent,
                "_agent_api_request",
                new=AsyncMock(return_value=response),
            ) as request,
            unittest.mock.patch.object(
                monofarm_agent,
                "_runtime_printer_registry",
                registry,
            ),
        ):
            payload = await monofarm_agent._refresh_v2_runtime_config(
                "https://api.monofarm.app",
                "",
            )

        self.assertEqual(payload["organization_id"], 7)
        self.assertEqual(registry.require(42).provider, "moonraker")
        registry.require_artifact_source("https://files.monofarm.app/model.gcode")
        self.assertEqual(request.await_args.args[1:5], ("GET", "https://api.monofarm.app", "", "runtime-config"))

    def test_paired_identity_selects_v2_auxiliary_agent_apis(self) -> None:
        import monofarm_agent

        with unittest.mock.patch.object(
            monofarm_agent,
            "_configured_device_credentials",
            return_value=DeviceCredentials("device-1", "secret-1"),
        ):
            self.assertEqual(
                monofarm_agent._agent_api_path("tg-config"),
                "/api/agent/v2/tg-config",
            )


if __name__ == "__main__":
    unittest.main()
