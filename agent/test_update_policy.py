import base64
import hashlib
import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from update_policy import (
    RELEASE_MANIFEST_ALGORITHM,
    RELEASE_MANIFEST_SCHEMA_VERSION,
    RELEASE_SOURCE_FILES,
    UpdatePolicyError,
    canonical_manifest_bytes,
    require_newer_version,
    verify_artifact_bytes,
    verify_signed_manifest,
)


class VersionPolicyTests(unittest.TestCase):
    def test_accepts_only_strictly_newer_semantic_version(self) -> None:
        self.assertEqual(require_newer_version("0.9.0", "0.8.10"), "0.9.0")

        for remote in ("0.8.10", "0.8.9", "invalid", "1.0"):
            with self.subTest(remote=remote):
                with self.assertRaises(UpdatePolicyError):
                    require_newer_version(remote, "0.8.10")


class SignedManifestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.private_key = Ed25519PrivateKey.generate()
        public_bytes = self.private_key.public_key().public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )
        self.public_key = base64.b64encode(public_bytes).decode("ascii")
        key_id = hashlib.sha256(public_bytes).hexdigest()[:16]
        self.payload = {
            "schema_version": RELEASE_MANIFEST_SCHEMA_VERSION,
            "algorithm": RELEASE_MANIFEST_ALGORITHM,
            "key_id": key_id,
            "version": "0.9.0",
            "issued_at": datetime.now(timezone.utc).isoformat(),
            "expires_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
            "artifacts": {
                **{
                    f"source-{filename}": {
                        "url": f"https://api.monofarm.app/agent/releases/0.9.0/runtime/{filename}",
                        "size": 4,
                        "sha256": hashlib.sha256(b"safe").hexdigest(),
                    }
                    for filename in RELEASE_SOURCE_FILES
                },
                "windows-x86_64": {
                    "url": "https://api.monofarm.app/agent/monofarm-agent.exe",
                    "size": 4,
                    "sha256": hashlib.sha256(b"safe").hexdigest(),
                }
            },
        }

    def _signed(self) -> dict:
        manifest = dict(self.payload)
        manifest["signature"] = base64.b64encode(
            self.private_key.sign(canonical_manifest_bytes(manifest))
        ).decode("ascii")
        return manifest

    def test_verifies_signature_expiry_version_and_artifact_shape(self) -> None:
        verified = verify_signed_manifest(
            self._signed(),
            trusted_public_keys=[self.public_key],
            current_version="0.8.10",
        )

        self.assertEqual(verified["version"], "0.9.0")
        self.assertEqual(verified["artifacts"]["windows-x86_64"]["size"], 4)

    def test_rejects_tampered_manifest(self) -> None:
        manifest = self._signed()
        manifest["artifacts"]["windows-x86_64"]["size"] = 5

        with self.assertRaisesRegex(UpdatePolicyError, "signature"):
            verify_signed_manifest(
                manifest,
                trusted_public_keys=[self.public_key],
                current_version="0.8.10",
            )

    def test_rejects_expired_manifest(self) -> None:
        self.payload["expires_at"] = (
            datetime.now(timezone.utc) - timedelta(seconds=1)
        ).isoformat()

        with self.assertRaisesRegex(UpdatePolicyError, "expired"):
            verify_signed_manifest(
                self._signed(),
                trusted_public_keys=[self.public_key],
                current_version="0.8.10",
            )

    def test_rejects_ambiguous_or_credentialed_artifact_urls(self) -> None:
        invalid_urls = (
            "https://user:secret@api.monofarm.app/agent/update.exe",
            "https://api.monofarm.app/agent/update.exe#fragment",
            "https:///agent/update.exe",
            "https://api.monofarm.app:99999/agent/update.exe",
        )

        for url in invalid_urls:
            with self.subTest(url=url):
                self.payload["artifacts"]["windows-x86_64"]["url"] = url
                with self.assertRaisesRegex(UpdatePolicyError, "artifact"):
                    verify_signed_manifest(
                        self._signed(),
                        trusted_public_keys=[self.public_key],
                        current_version="0.8.10",
                    )


class ArtifactIntegrityTests(unittest.TestCase):
    def test_accepts_exact_size_and_sha256(self) -> None:
        data = b"safe"
        verify_artifact_bytes(
            data,
            expected_size=len(data),
            expected_sha256=hashlib.sha256(data).hexdigest(),
        )

    def test_rejects_truncated_or_modified_artifact(self) -> None:
        digest = hashlib.sha256(b"safe").hexdigest()

        with self.assertRaisesRegex(UpdatePolicyError, "size"):
            verify_artifact_bytes(b"saf", expected_size=4, expected_sha256=digest)
        with self.assertRaisesRegex(UpdatePolicyError, "SHA-256"):
            verify_artifact_bytes(b"evil", expected_size=4, expected_sha256=digest)


class AgentUpdateIntegrationTests(unittest.IsolatedAsyncioTestCase):
    def _signed_manifest(self) -> tuple[dict, str]:
        private_key = Ed25519PrivateKey.generate()
        public_bytes = private_key.public_key().public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )
        public_key = base64.b64encode(public_bytes).decode("ascii")
        data = b"print('new agent')\n"
        manifest = {
            "schema_version": RELEASE_MANIFEST_SCHEMA_VERSION,
            "algorithm": RELEASE_MANIFEST_ALGORITHM,
            "key_id": hashlib.sha256(public_bytes).hexdigest()[:16],
            "version": "0.9.2",
            "issued_at": datetime.now(timezone.utc).isoformat(),
            "expires_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
            "artifacts": {
                **{
                    f"source-{filename}": {
                        "url": f"https://api.monofarm.app/agent/releases/0.9.2/runtime/{filename}",
                        "size": len(data),
                        "sha256": hashlib.sha256(data).hexdigest(),
                    }
                    for filename in RELEASE_SOURCE_FILES
                },
                "windows-x86_64": {
                    "url": "https://api.monofarm.app/agent/releases/0.9.2/monofarm-agent.exe",
                    "size": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                },
            },
        }
        manifest["signature"] = base64.b64encode(
            private_key.sign(canonical_manifest_bytes(manifest))
        ).decode("ascii")
        return manifest, public_key

    @staticmethod
    def _client_for(payload: dict):
        response = MagicMock(status_code=200)
        response.json.return_value = payload
        client = AsyncMock()
        client.get.return_value = response
        manager = AsyncMock()
        manager.__aenter__.return_value = client
        manager.__aexit__.return_value = None
        return manager

    async def test_unsigned_version_response_never_applies_update(self) -> None:
        import monofarm_agent

        manager = self._client_for({"version": "0.9.0"})
        with (
            patch.object(monofarm_agent.httpx, "AsyncClient", return_value=manager),
            patch.object(monofarm_agent, "_apply_source_update", new=AsyncMock()) as apply,
            patch.dict(os.environ, {"MONOFARM_UPDATE_PUBLIC_KEYS": ""}, clear=False),
        ):
            await monofarm_agent.check_for_update("https://api.monofarm.app")

        apply.assert_not_awaited()

    async def test_valid_signed_manifest_is_passed_to_update_stage(self) -> None:
        import monofarm_agent

        manifest, public_key = self._signed_manifest()
        manager = self._client_for({"manifest": manifest})
        with (
            patch.object(monofarm_agent.httpx, "AsyncClient", return_value=manager),
            patch.object(monofarm_agent, "_apply_source_update", new=AsyncMock()) as apply,
            patch.dict(
                os.environ,
                {"MONOFARM_UPDATE_PUBLIC_KEYS": public_key},
                clear=False,
            ),
        ):
            await monofarm_agent.check_for_update("https://api.monofarm.app")

        apply.assert_awaited_once()
        self.assertEqual(apply.await_args.args[2]["version"], "0.9.2")

    async def test_server_key_is_never_trusted_without_a_local_pin(self) -> None:
        import monofarm_agent

        manifest, public_key = self._signed_manifest()
        manager = self._client_for(
            {"manifest": manifest, "update_public_key": public_key}
        )
        with (
            patch.object(monofarm_agent.httpx, "AsyncClient", return_value=manager),
            patch.object(monofarm_agent, "_apply_source_update", new=AsyncMock()) as apply,
            patch.dict(os.environ, {"MONOFARM_UPDATE_PUBLIC_KEYS": ""}, clear=False),
        ):
            await monofarm_agent.check_for_update("https://api.monofarm.app")

        apply.assert_not_awaited()

    async def test_persisted_update_key_is_reused_after_process_restart(self) -> None:
        import monofarm_agent

        manifest, public_key = self._signed_manifest()
        manager = self._client_for({"manifest": manifest})
        with (
            patch.object(monofarm_agent.httpx, "AsyncClient", return_value=manager),
            patch.object(monofarm_agent, "_apply_source_update", new=AsyncMock()) as apply,
            patch.object(
                monofarm_agent,
                "_load_config",
                return_value={"MONOFARM_UPDATE_PUBLIC_KEYS": public_key},
            ),
            patch.dict(os.environ, {"MONOFARM_UPDATE_PUBLIC_KEYS": ""}, clear=False),
        ):
            await monofarm_agent.check_for_update("https://api.monofarm.app")

        apply.assert_awaited_once()

    async def test_update_check_rejects_cleartext_non_loopback_server(self) -> None:
        import monofarm_agent

        client_factory = MagicMock()
        with patch.object(monofarm_agent.httpx, "AsyncClient", client_factory):
            await monofarm_agent.check_for_update("http://api.monofarm.app")

        client_factory.assert_not_called()

    async def test_artifact_download_allows_one_https_presigned_redirect(self) -> None:
        import monofarm_agent

        artifact = {
            "url": "https://api.monofarm.app/agent/update.exe",
            "size": 4,
            "sha256": hashlib.sha256(b"safe").hexdigest(),
        }
        redirect = MagicMock(
            status_code=302,
            headers={"location": "https://r2.example/releases/update.exe?sig=x"},
        )
        response = MagicMock(status_code=200, content=b"safe")
        response.raise_for_status.return_value = None
        client = AsyncMock()
        client.get.side_effect = [redirect, response]

        data = await monofarm_agent._download_verified_artifact(client, artifact)

        self.assertEqual(data, b"safe")
        self.assertEqual(client.get.await_count, 2)
        client.get.assert_any_await(
            "https://r2.example/releases/update.exe?sig=x",
            follow_redirects=False,
        )

    async def test_artifact_download_rejects_cleartext_redirect(self) -> None:
        import monofarm_agent

        artifact = {
            "url": "https://api.monofarm.app/agent/update.exe",
            "size": 4,
            "sha256": hashlib.sha256(b"safe").hexdigest(),
        }
        response = MagicMock(
            status_code=302,
            headers={"location": "http://r2.example/update.exe"},
        )
        client = AsyncMock()
        client.get.return_value = response

        with self.assertRaisesRegex(UpdatePolicyError, "HTTPS"):
            await monofarm_agent._download_verified_artifact(client, artifact)

    def test_source_update_allowlist_contains_real_edge_runtime_package(self) -> None:
        import monofarm_agent

        self.assertNotIn("edge_runtime.py", monofarm_agent._SOURCE_UPDATE_FILES)
        self.assertEqual(
            {
                "edge_runtime/__init__.py",
                "edge_runtime/adapters.py",
                "edge_runtime/artifact_spool.py",
                "edge_runtime/journal.py",
                "edge_runtime/registry.py",
                "edge_runtime/transfer.py",
            },
            {
                name
                for name in monofarm_agent._SOURCE_UPDATE_FILES
                if name.startswith("edge_runtime/")
            },
        )


if __name__ == "__main__":
    unittest.main()
