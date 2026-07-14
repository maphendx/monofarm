import os
import ssl
import unittest
from unittest.mock import AsyncMock, patch

from network_policy import (
    NetworkPolicyError,
    configured_tcp_targets,
    require_cloud_server_url,
    require_loopback_web_request,
    require_public_https_url,
    require_registered_http_url,
    require_registered_tcp_target,
    tls_verification_for_local_url,
)


class RegisteredHttpTargetTests(unittest.TestCase):
    def test_cloud_server_requires_https_except_explicit_loopback_development(self) -> None:
        self.assertEqual(
            require_cloud_server_url("https://api.monofarm.app"),
            "https://api.monofarm.app",
        )
        self.assertEqual(
            require_cloud_server_url("http://127.0.0.1:8000"),
            "http://127.0.0.1:8000",
        )
        for blocked in (
            "http://api.monofarm.app",
            "http://192.168.1.20:8000",
            "https://user:secret@api.monofarm.app",
            "https://api.monofarm.app/path",
        ):
            with self.subTest(blocked=blocked):
                with self.assertRaises(NetworkPolicyError):
                    require_cloud_server_url(blocked)

    def test_accepts_registered_private_printer_host(self) -> None:
        url = "http://192.168.10.25:7125/printer/info"

        self.assertEqual(
            require_registered_http_url(url, {"192.168.10.25"}),
            url,
        )

    def test_accepts_registered_local_hostname(self) -> None:
        url = "http://voron-01.local:7125/printer/objects/query"

        self.assertEqual(
            require_registered_http_url(url, {"VORON-01.LOCAL"}),
            url,
        )

    def test_rejects_unregistered_private_host(self) -> None:
        with self.assertRaisesRegex(NetworkPolicyError, "not registered"):
            require_registered_http_url(
                "http://192.168.10.99:8080/admin",
                {"192.168.10.25"},
            )

    def test_rejects_loopback_link_local_public_and_metadata_targets(self) -> None:
        blocked = (
            "http://127.0.0.1:8000/private",
            "http://[::1]:8000/private",
            "http://169.254.169.254/latest/meta-data",
            "http://8.8.8.8/",
        )

        for url in blocked:
            with self.subTest(url=url):
                with self.assertRaises(NetworkPolicyError):
                    require_registered_http_url(url, {url.split("/")[2]})

    def test_rejects_credentials_and_non_http_schemes(self) -> None:
        with self.assertRaises(NetworkPolicyError):
            require_registered_http_url(
                "http://admin:secret@192.168.10.25:7125/printer/info",
                {"192.168.10.25"},
            )
        with self.assertRaises(NetworkPolicyError):
            require_registered_http_url(
                "file:///etc/passwd",
                {"192.168.10.25"},
            )

    def test_local_https_verification_requires_exact_explicit_override(self) -> None:
        with patch.dict(
            os.environ,
            {"MONOFARM_MOONRAKER_INSECURE_TARGETS": "192.168.10.25"},
            clear=False,
        ):
            self.assertFalse(
                tls_verification_for_local_url(
                    "https://192.168.10.25:7125/printer/info",
                    "MONOFARM_MOONRAKER_INSECURE_TARGETS",
                )
            )

    def test_cloud_artifacts_require_public_https_targets(self) -> None:
        url = "https://files.monofarm.app/jobs/part.gcode?signature=abc"
        self.assertEqual(require_public_https_url(url), url)

        for blocked in (
            "http://files.monofarm.app/part.gcode",
            "https://192.168.1.20/part.gcode",
            "https://169.254.169.254/latest/meta-data",
            "https://printer.local/part.gcode",
            "https://localhost/part.gcode",
        ):
            with self.subTest(blocked=blocked):
                with self.assertRaises(NetworkPolicyError):
                    require_public_https_url(blocked)
            self.assertTrue(
                tls_verification_for_local_url(
                    "https://192.168.10.26:7125/printer/info",
                    "MONOFARM_MOONRAKER_INSECURE_TARGETS",
                )
            )


class RegisteredTcpTargetTests(unittest.TestCase):
    def test_configured_targets_are_explicit_and_normalized(self) -> None:
        with patch.dict(
            os.environ,
            {"MONOFARM_ZPL_TARGETS": "192.168.10.50:9100, 192.168.10.51"},
            clear=False,
        ):
            self.assertEqual(
                configured_tcp_targets("MONOFARM_ZPL_TARGETS", default_port=9100),
                {("192.168.10.50", 9100), ("192.168.10.51", 9100)},
            )

    def test_rejects_target_not_explicitly_configured(self) -> None:
        with self.assertRaisesRegex(NetworkPolicyError, "not registered"):
            require_registered_tcp_target(
                "192.168.10.99",
                9100,
                {("192.168.10.50", 9100)},
            )

    def test_rejects_invalid_port_and_non_private_ip(self) -> None:
        with self.assertRaises(NetworkPolicyError):
            require_registered_tcp_target(
                "192.168.10.50",
                22,
                {("192.168.10.50", 22)},
            )
        with self.assertRaises(NetworkPolicyError):
            require_registered_tcp_target(
                "8.8.8.8",
                9100,
                {("8.8.8.8", 9100)},
            )


class LoopbackWebUiTests(unittest.TestCase):
    def test_accepts_same_origin_loopback_post(self) -> None:
        require_loopback_web_request(
            client_host="127.0.0.1",
            host_header="localhost:8723",
            origin_header="http://localhost:8723",
            require_origin=True,
        )

    def test_rejects_remote_client_dns_rebinding_and_cross_site_post(self) -> None:
        blocked = (
            ("192.168.1.10", "localhost:8723", "http://localhost:8723"),
            ("127.0.0.1", "evil.example:8723", "http://evil.example"),
            ("127.0.0.1", "localhost:8723", "https://evil.example"),
            ("127.0.0.1", "localhost:8723", ""),
        )
        for client, host, origin in blocked:
            with self.subTest(client=client, host=host, origin=origin):
                with self.assertRaises(NetworkPolicyError):
                    require_loopback_web_request(
                        client_host=client,
                        host_header=host,
                        origin_header=origin,
                        require_origin=True,
                    )

    def test_agent_web_ui_binds_only_to_loopback(self) -> None:
        import monofarm_agent

        with (
            patch("http.server.ThreadingHTTPServer") as server,
            patch.object(monofarm_agent.threading.Thread, "start"),
        ):
            monofarm_agent._start_web_ui(8723)

        self.assertEqual(server.call_args.args[0], ("127.0.0.1", 8723))

class _WebSocketStub:
    def __init__(self) -> None:
        self.messages: list[dict] = []

    async def send(self, payload: str) -> None:
        import json

        self.messages.append(json.loads(payload))


class AgentHandlerPolicyTests(unittest.IsolatedAsyncioTestCase):
    async def test_generic_proxy_rejects_unregistered_target_before_network(self) -> None:
        import monofarm_agent

        ws = _WebSocketStub()
        monofarm_agent._moonraker_names.clear()
        monofarm_agent._moonraker_sub_tasks.clear()
        with patch.object(
            monofarm_agent.httpx,
            "AsyncClient",
            side_effect=AssertionError("network must not be reached"),
        ):
            await monofarm_agent.handle_request(
                ws,
                {
                    "id": "blocked-http",
                    "method": "GET",
                    "url": "http://169.254.169.254/latest/meta-data",
                },
            )

        self.assertEqual(ws.messages[-1]["status"], 403)
        self.assertIn("forbidden", ws.messages[-1]["error"].lower())

    async def test_zpl_requires_explicit_local_target_allowlist(self) -> None:
        import monofarm_agent

        ws = _WebSocketStub()
        with (
            patch.dict(os.environ, {"MONOFARM_ZPL_TARGETS": ""}, clear=False),
            patch.object(
                monofarm_agent.asyncio,
                "open_connection",
                new=AsyncMock(side_effect=AssertionError("network must not be reached")),
            ),
        ):
            await monofarm_agent.handle_print_zpl(
                ws,
                {
                    "id": "blocked-zpl",
                    "body": {"ip": "192.168.10.50", "port": 9100, "zpl": "^XA^XZ"},
                },
            )

        self.assertEqual(ws.messages[-1]["status"], 403)


class BambuTlsPolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        import monofarm_agent

        monofarm_agent._bambu_tls_insecure.clear()
        monofarm_agent._bambu_tls_timeouts.clear()

    def test_certificate_failure_never_silently_downgrades_target(self) -> None:
        import monofarm_agent

        with patch.dict(os.environ, {"MONOFARM_BAMBU_INSECURE_TARGETS": ""}, clear=False):
            monofarm_agent._bambu_mark_tls_failure(
                "192.168.10.20",
                ssl.SSLError("certificate verify failed"),
            )
            context = monofarm_agent._bambu_ssl_context("192.168.10.20")

        self.assertNotIn("192.168.10.20", monofarm_agent._bambu_tls_insecure)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)

    def test_insecure_bambu_tls_requires_explicit_per_target_opt_in(self) -> None:
        import monofarm_agent

        with patch.dict(
            os.environ,
            {"MONOFARM_BAMBU_INSECURE_TARGETS": "192.168.10.20"},
            clear=False,
        ):
            context = monofarm_agent._bambu_ssl_context("192.168.10.20")

        self.assertEqual(context.verify_mode, ssl.CERT_NONE)


if __name__ == "__main__":
    unittest.main()
