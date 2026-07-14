import base64
import hashlib
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

import monofarm_agent
from update_policy import (
    EXPECTED_RELEASE_ARTIFACTS,
    RELEASE_SOURCE_FILES,
    UpdatePolicyError,
    canonical_manifest_bytes,
    verify_signed_manifest,
)


def _release_contents() -> dict[str, bytes]:
    return {
        filename: (
            b"# pinned dependencies\n"
            if filename == "requirements.txt"
            else f"# {filename}\n".encode("utf-8")
        )
        for filename in RELEASE_SOURCE_FILES
    }


def _release_manifest(contents: dict[str, bytes]) -> dict:
    return {
        "schema_version": 2,
        "algorithm": "Ed25519",
        "key_id": "0" * 16,
        "version": "0.9.1",
        "issued_at": datetime.now(timezone.utc).isoformat(),
        "expires_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
        "artifacts": {
            **{
                f"source-{filename}": {
                    "url": f"https://api.monofarm.app/agent/releases/0.9.1/runtime/{filename}",
                    "size": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                }
                for filename, data in contents.items()
            },
            "windows-x86_64": {
                "url": "https://api.monofarm.app/agent/releases/0.9.1/monofarm-agent.exe",
                "size": 4,
                "sha256": hashlib.sha256(b"safe").hexdigest(),
            },
        },
    }


class ExactReleaseContractTests(unittest.TestCase):
    def test_signed_manifest_requires_the_exact_cross_platform_artifact_set(self) -> None:
        private = Ed25519PrivateKey.generate()
        public = base64.b64encode(
            private.public_key().public_bytes(
                encoding=serialization.Encoding.Raw,
                format=serialization.PublicFormat.Raw,
            )
        ).decode("ascii")
        manifest = _release_manifest(_release_contents())
        manifest["key_id"] = hashlib.sha256(base64.b64decode(public)).hexdigest()[:16]
        manifest["signature"] = base64.b64encode(
            private.sign(canonical_manifest_bytes(manifest))
        ).decode("ascii")

        verified = verify_signed_manifest(
            manifest,
            trusted_public_keys=[public],
            current_version="0.9.0",
        )
        self.assertEqual(set(verified["artifacts"]), EXPECTED_RELEASE_ARTIFACTS)

        manifest["artifacts"].pop("source-network_policy.py")
        manifest["signature"] = base64.b64encode(
            private.sign(canonical_manifest_bytes(manifest))
        ).decode("ascii")
        with self.assertRaisesRegex(UpdatePolicyError, "artifact set"):
            verify_signed_manifest(
                manifest,
                trusted_public_keys=[public],
                current_version="0.9.0",
            )


class TransactionalSourceReleaseTests(unittest.IsolatedAsyncioTestCase):
    async def test_health_failure_keeps_previous_release_active(self) -> None:
        contents = _release_contents()
        manifest = _release_manifest(contents)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            releases = root / "releases"
            previous = releases / "0.9.0-old"
            previous.mkdir(parents=True)
            (previous / ".complete").write_text("0.9.0\n")
            current = root / "current"
            current.symlink_to(previous, target_is_directory=True)

            async def download(_client, artifact):
                filename = artifact["url"].split("/runtime/", 1)[1]
                return contents[filename]

            with (
                patch.object(
                    monofarm_agent,
                    "_download_verified_artifact",
                    side_effect=download,
                ),
                patch.object(monofarm_agent, "_install_source_requirements"),
                patch.object(
                    monofarm_agent,
                    "_preflight_source_release",
                    side_effect=UpdatePolicyError("candidate health check failed"),
                ),
            ):
                with self.assertRaisesRegex(UpdatePolicyError, "health"):
                    await monofarm_agent._stage_source_release(
                        AsyncMock(),
                        manifest,
                        active_dir=previous,
                        releases_dir=releases,
                        current_link=current,
                    )

            self.assertEqual(current.resolve(), previous.resolve())
            self.assertEqual({path.name for path in releases.iterdir()}, {previous.name})

    async def test_healthy_release_activates_atomically_and_retains_previous(self) -> None:
        contents = _release_contents()
        manifest = _release_manifest(contents)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            releases = root / "releases"
            previous = releases / "0.9.0-old"
            previous.mkdir(parents=True)
            (previous / ".complete").write_text("0.9.0\n")
            current = root / "current"
            current.symlink_to(previous, target_is_directory=True)

            async def download(_client, artifact):
                filename = artifact["url"].split("/runtime/", 1)[1]
                return contents[filename]

            with (
                patch.object(
                    monofarm_agent,
                    "_download_verified_artifact",
                    side_effect=download,
                ),
                patch.object(monofarm_agent, "_install_source_requirements"),
                patch.object(monofarm_agent, "_preflight_source_release"),
            ):
                release = await monofarm_agent._stage_source_release(
                    AsyncMock(),
                    manifest,
                    active_dir=previous,
                    releases_dir=releases,
                    current_link=current,
                )

            self.assertEqual(current.resolve(), release.resolve())
            self.assertTrue(previous.is_dir())
            self.assertEqual((release / ".complete").read_text().strip(), "0.9.1")
            self.assertEqual(
                {path.name for path in releases.iterdir()},
                {previous.name, release.name},
            )


if __name__ == "__main__":
    unittest.main()
