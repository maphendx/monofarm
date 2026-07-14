import base64
import builtins
import hashlib
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

import legacy_bootstrap


class LegacyBootstrapTrustTests(unittest.TestCase):
    def setUp(self) -> None:
        self.now = datetime.now(timezone.utc)
        self.private_key = Ed25519PrivateKey.generate()
        public_key = self.private_key.public_key().public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )
        self.public_key = base64.b64encode(public_key).decode("ascii")
        self.key_id = hashlib.sha256(public_key).hexdigest()[:16]
        self.contents = {
            name: f"# content:{name}\n".encode("utf-8")
            for name in legacy_bootstrap.RUNTIME_SOURCE_FILES
        }
        self.manifest = self._signed_manifest()

    def _signed_manifest(self) -> dict:
        manifest = {
            "schema_version": 2,
            "algorithm": "Ed25519",
            "key_id": self.key_id,
            "version": "0.9.0",
            "issued_at": self.now.isoformat(),
            "expires_at": (self.now + timedelta(hours=1)).isoformat(),
            "artifacts": {
                **{
                    f"source-{name}": {
                        "url": f"https://api.monofarm.app/agent/releases/0.9.0/runtime/{name}",
                        "size": len(data),
                        "sha256": hashlib.sha256(data).hexdigest(),
                    }
                    for name, data in self.contents.items()
                },
                "windows-x86_64": {
                    "url": "https://api.monofarm.app/agent/releases/0.9.0/monofarm-agent.exe",
                    "size": 4,
                    "sha256": hashlib.sha256(b"safe").hexdigest(),
                },
            },
        }
        canonical = json.dumps(
            manifest,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
        manifest["signature"] = base64.b64encode(
            self.private_key.sign(canonical)
        ).decode("ascii")
        return manifest

    def test_accepts_only_https_urls_and_redirects(self) -> None:
        self.assertEqual(
            legacy_bootstrap.require_https_url("https://api.monofarm.app/"),
            "https://api.monofarm.app/",
        )
        for url in ("http://api.monofarm.app", "file:///tmp/agent.py"):
            with self.subTest(url=url):
                with self.assertRaises(legacy_bootstrap.BootstrapError):
                    legacy_bootstrap.require_https_url(url)

        handler = legacy_bootstrap.HTTPSOnlyRedirectHandler()
        with self.assertRaises(legacy_bootstrap.BootstrapError):
            handler.redirect_request(None, None, 302, "Found", {}, "http://r2.example/a.exe")

    def test_verifies_signed_complete_source_manifest(self) -> None:
        verified = legacy_bootstrap.verify_signed_manifest(
            self.manifest,
            trusted_public_keys=[self.public_key],
            now=self.now,
        )

        self.assertEqual(verified["version"], "0.9.0")
        self.assertEqual(
            {
                name.removeprefix("source-")
                for name in verified["artifacts"]
                if name.startswith("source-")
            },
            legacy_bootstrap.RUNTIME_SOURCE_FILES,
        )

    def test_rejects_tampered_or_incomplete_manifest(self) -> None:
        tampered = json.loads(json.dumps(self.manifest))
        tampered["artifacts"]["source-monofarm_agent.py"]["size"] += 1
        with self.assertRaisesRegex(legacy_bootstrap.BootstrapError, "signature"):
            legacy_bootstrap.verify_signed_manifest(
                tampered,
                trusted_public_keys=[self.public_key],
                now=self.now,
            )

        incomplete = self._signed_manifest()
        incomplete["artifacts"].pop("source-device_identity.py")
        canonical = json.dumps(
            {key: value for key, value in incomplete.items() if key != "signature"},
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
        incomplete["signature"] = base64.b64encode(
            self.private_key.sign(canonical)
        ).decode("ascii")
        with self.assertRaisesRegex(legacy_bootstrap.BootstrapError, "artifact set"):
            legacy_bootstrap.verify_signed_manifest(
                incomplete,
                trusted_public_keys=[self.public_key],
                now=self.now,
            )

    def test_openssl_fallback_verifies_before_python_dependencies_exist(self) -> None:
        signature = base64.b64decode(self.manifest["signature"], validate=True)
        payload = legacy_bootstrap._canonical_manifest_bytes(self.manifest)
        real_import = builtins.__import__

        def import_without_cryptography(name, *args, **kwargs):
            if name.startswith("cryptography"):
                raise ImportError("cryptography intentionally unavailable")
            return real_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=import_without_cryptography):
            self.assertTrue(
                legacy_bootstrap._verify_ed25519_signature(
                    self.public_key,
                    signature,
                    payload,
                )
            )

    def test_server_supplied_key_is_not_a_bootstrap_trust_root(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with (
                patch.object(
                    legacy_bootstrap,
                    "fetch_json",
                    return_value={
                        "version": self.manifest["version"],
                        "manifest": self.manifest,
                        "update_public_key": self.public_key,
                    },
                ),
                patch.dict("os.environ", {"MONOFARM_UPDATE_PUBLIC_KEYS": ""}),
            ):
                with self.assertRaisesRegex(
                    legacy_bootstrap.BootstrapError,
                    "manifest signing key is not pinned",
                ):
                    legacy_bootstrap.run(
                        args=["--server", "https://api.monofarm.app", "--install-only"],
                        config_dir=root,
                    )


class LegacyBootstrapActivationTests(unittest.TestCase):
    def _manifest_and_contents(self) -> tuple[dict, dict[str, bytes]]:
        contents = {
            name: f"# content:{name}\n".encode("utf-8")
            for name in legacy_bootstrap.RUNTIME_SOURCE_FILES
        }
        return (
            {
                "version": "0.9.0",
                "artifacts": {
                    **{
                        f"source-{name}": {
                            "url": f"https://api.monofarm.app/agent/releases/0.9.0/runtime/{name}",
                            "size": len(data),
                            "sha256": hashlib.sha256(data).hexdigest(),
                        }
                        for name, data in contents.items()
                    },
                    "windows-x86_64": {
                        "url": "https://api.monofarm.app/agent/releases/0.9.0/monofarm-agent.exe",
                        "size": 4,
                        "sha256": hashlib.sha256(b"safe").hexdigest(),
                    },
                },
            },
            contents,
        )

    def test_partial_download_keeps_previous_release_active(self) -> None:
        manifest, contents = self._manifest_and_contents()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            releases = root / "releases"
            old = releases / "old"
            old.mkdir(parents=True)
            (old / ".complete").write_text("old\n")
            current = root / "current"
            current.symlink_to(old, target_is_directory=True)

            def fetch(url: str, max_bytes: int) -> bytes:
                name = url.removeprefix(
                    "https://api.monofarm.app/agent/releases/0.9.0/runtime/"
                )
                if name == "device_identity.py":
                    raise legacy_bootstrap.BootstrapError("interrupted")
                return contents[name]

            with self.assertRaisesRegex(legacy_bootstrap.BootstrapError, "interrupted"):
                legacy_bootstrap.install_release(
                    manifest,
                    releases_dir=releases,
                    current_link=current,
                    fetch=fetch,
                )

            self.assertEqual(current.resolve(), old.resolve())
            self.assertEqual({path.name for path in releases.iterdir()}, {"old"})

    def test_complete_verified_bundle_is_activated_with_one_symlink_swap(self) -> None:
        manifest, contents = self._manifest_and_contents()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            releases = root / "releases"
            current = root / "current"

            release = legacy_bootstrap.install_release(
                manifest,
                releases_dir=releases,
                current_link=current,
                fetch=lambda url, max_bytes: contents[
                    url.removeprefix(
                        "https://api.monofarm.app/agent/releases/0.9.0/runtime/"
                    )
                ],
            )

            self.assertEqual(current.resolve(), release.resolve())
            self.assertEqual((release / ".complete").read_text().strip(), "0.9.0")
            for name, expected in contents.items():
                self.assertEqual((release / name).read_bytes(), expected)

    def test_pinning_update_key_preserves_existing_config(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / ".env"
            config.write_text(
                "# keep me\nMONOFARM_SERVER=https://api.monofarm.app\n"
                "MONOFARM_TOKEN=legacy-token\nALERT_CHAT_IDS=1,2\n",
                encoding="utf-8",
            )

            legacy_bootstrap.persist_update_key(config, "trusted-key")

            updated = config.read_text(encoding="utf-8")
            self.assertIn("# keep me", updated)
            self.assertIn("MONOFARM_TOKEN=legacy-token", updated)
            self.assertIn("ALERT_CHAT_IDS=1,2", updated)
            self.assertIn("MONOFARM_UPDATE_PUBLIC_KEYS=trusted-key", updated)

    def test_manifest_is_verified_before_requirements_are_downloaded_or_installed(
        self,
    ) -> None:
        manifest, contents = self._manifest_and_contents()
        order: list[str] = []

        def verify(*_args, **_kwargs) -> dict:
            order.append("verify-manifest")
            return manifest

        def fetch(_url: str, _limit: int) -> bytes:
            order.append("download-requirements")
            return contents["requirements.txt"]

        def install_requirements(_data: bytes, _config_dir: Path) -> None:
            order.append("install-requirements")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with (
                patch.object(
                    legacy_bootstrap,
                    "fetch_json",
                    return_value={
                        "version": manifest["version"],
                        "manifest": manifest,
                        "update_public_key": "bootstrap-key",
                    },
                ),
                patch.object(legacy_bootstrap, "verify_signed_manifest", side_effect=verify),
                patch.object(legacy_bootstrap, "fetch_bytes", side_effect=fetch),
                patch.object(
                    legacy_bootstrap,
                    "install_requirements",
                    side_effect=install_requirements,
                ),
                patch.object(
                    legacy_bootstrap,
                    "install_release",
                    return_value=root / "release",
                ),
                patch.object(legacy_bootstrap, "_exec_agent"),
            ):
                legacy_bootstrap.run(
                    args=["--server", "https://api.monofarm.app"],
                    config_dir=root,
                )

        self.assertEqual(
            order,
            ["verify-manifest", "download-requirements", "install-requirements"],
        )


if __name__ == "__main__":
    unittest.main()
