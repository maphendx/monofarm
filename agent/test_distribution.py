import ast
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
AGENT_DIR = ROOT / "agent"
RUNTIME_FILES = (
    "monofarm_agent.py",
    "monofarm_tray.py",
    "command_runtime.py",
    "command_worker.py",
    "device_identity.py",
    "network_policy.py",
    "printer_runtime.py",
    "provider_adapters.py",
    "update_policy.py",
    "requirements.txt",
    "edge_runtime/__init__.py",
    "edge_runtime/adapters.py",
    "edge_runtime/artifact_spool.py",
    "edge_runtime/journal.py",
    "edge_runtime/registry.py",
    "edge_runtime/transfer.py",
)


class LinuxInstallerContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.script = (AGENT_DIR / "install.sh").read_text(encoding="utf-8")

    def test_stages_every_source_runtime_file_before_atomic_activation(self) -> None:
        self.assertIn("/agent/monofarm_agent.py", self.script)
        self.assertIn("--install-only", self.script)
        self.assertIn("CURRENT_LINK", self.script)

    def test_requires_out_of_band_ci_release_key(self) -> None:
        self.assertIn("--release-public-key", self.script)
        self.assertIn("MONOFARM_UPDATE_PUBLIC_KEYS", self.script)
        self.assertIn('MONOFARM_UPDATE_PUBLIC_KEYS="$RELEASE_PUBLIC_KEY"', self.script)

    def test_runtime_is_installed_only_through_signed_bootstrap(self) -> None:
        self.assertNotIn('"$SERVER/agent/runtime/$runtime_file"', self.script)
        self.assertNotIn("RUNTIME_FILES=(", self.script)

    def test_downloads_require_tls_and_fail_on_http_errors(self) -> None:
        for curl_flag in (
            "--fail",
            "--show-error",
            "--location",
            "--proto '=https'",
            "--proto-redir '=https'",
            "--tlsv1.2",
        ):
            with self.subTest(curl_flag=curl_flag):
                self.assertIn(curl_flag, self.script)

        self.assertIn('"$SERVER/agent/monofarm_agent.py"', self.script)
        self.assertIn('[[ -s "$BOOTSTRAP_DOWNLOAD" ]]', self.script)

    def test_installs_dependencies_from_the_distributed_requirements_file(self) -> None:
        self.assertNotRegex(self.script, r"pip.*(?:--requirement|-r)")
        self.assertNotIn(
            "pip\" install --quiet websockets httpx paho-mqtt",
            self.script,
        )

    def test_prefers_pairing_code_without_writing_an_empty_legacy_token(self) -> None:
        self.assertIn("--pairing-code", self.script)
        self.assertIn("MONOFARM_PAIRING_CODE", self.script)
        self.assertIn("TOKEN_PROVIDED", self.script)
        self.assertNotIn("MONOFARM_TOKEN=${TOKEN}\nEOF", self.script)


class RuntimePackagingContractTests(unittest.TestCase):
    def test_source_updater_uses_the_exact_distributed_runtime_set(self) -> None:
        tree = ast.parse(
            (AGENT_DIR / "monofarm_agent.py").read_text(encoding="utf-8")
        )
        source_update_files = None
        for node in tree.body:
            if isinstance(node, ast.Assign) and any(
                isinstance(target, ast.Name) and target.id == "_SOURCE_UPDATE_FILES"
                for target in node.targets
            ):
                source_update_files = ast.literal_eval(node.value)
                break

        self.assertEqual(source_update_files, set(RUNTIME_FILES))

    def test_runtime_declares_update_signature_dependency(self) -> None:
        requirements = (AGENT_DIR / "requirements.txt").read_text(encoding="utf-8")

        self.assertRegex(requirements, r"(?m)^cryptography(?:[<>=!~].*)?$")

    def test_runtime_dependencies_are_exactly_pinned(self) -> None:
        requirements = (AGENT_DIR / "requirements.txt").read_text(encoding="utf-8")

        for line in requirements.splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            with self.subTest(requirement=stripped):
                self.assertRegex(stripped, r"^[A-Za-z0-9_.-]+==[^=<>!~]+$")

    def test_runtime_never_pip_installs_mqtt_code_on_startup(self) -> None:
        source = (AGENT_DIR / "monofarm_agent.py").read_text(encoding="utf-8")

        self.assertNotIn(
            '[sys.executable, "-m", "pip", "install", "--quiet", "paho-mqtt"]',
            source,
        )

    def test_windows_bundle_includes_clean_room_runtime_modules(self) -> None:
        spec = (AGENT_DIR / "monofarm-agent.spec").read_text(encoding="utf-8")

        for module in (
            "command_runtime",
            "command_worker",
            "device_identity",
            "network_policy",
            "printer_runtime",
            "provider_adapters",
            "update_policy",
            "edge_runtime",
            "edge_runtime.adapters",
            "edge_runtime.artifact_spool",
            "edge_runtime.journal",
            "edge_runtime.registry",
            "edge_runtime.transfer",
        ):
            with self.subTest(module=module):
                self.assertIn(f"'{module}'", spec)


class WindowsInstallerContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.script = (AGENT_DIR / "install.ps1").read_text(encoding="utf-8")

    def test_requires_https_and_tls_1_2(self) -> None:
        self.assertIn("UriSchemeHttps", self.script)
        self.assertIn("SecurityProtocolType]::Tls12", self.script)

    def test_downloads_and_validates_before_atomic_exe_replacement(self) -> None:
        self.assertIn("monofarm-agent.exe.download", self.script)
        self.assertIn("[System.IO.File]::Replace", self.script)
        self.assertIn("[System.IO.File]::Move", self.script)
        self.assertRegex(self.script, r"Get-Item .*DownloadPath.*\.Length")
        self.assertIn("/api/agent/version", self.script)
        self.assertIn("windows-x86_64", self.script)
        self.assertIn("Get-FileHash", self.script)
        self.assertIn("ExpectedSha256", self.script)
        self.assertIn("ExpectedSize", self.script)
        self.assertLess(
            self.script.index("Get-FileHash"),
            self.script.index("Stop-Process"),
        )

    def test_first_install_pins_update_key_and_supports_device_pairing(self) -> None:
        self.assertIn("MONOFARM_UPDATE_PUBLIC_KEYS", self.script)
        self.assertIn("MONOFARM_PAIRING_CODE", self.script)
        self.assertIn("[string]$PairingCode", self.script)
        self.assertIn("[string]$ReleasePublicKey", self.script)
        self.assertIn("[string]$ExpectedSha256", self.script)
        self.assertIn("out-of-band CI digest", self.script)

    def test_keeps_previous_exe_until_candidate_health_check_passes(self) -> None:
        self.assertIn("/healthz", self.script)
        self.assertIn("candidate failed its health check", self.script)
        self.assertIn("Move-Item -LiteralPath $BackupPath", self.script)
        self.assertLess(
            self.script.index("Start-Process -FilePath $ExePath"),
            self.script.rindex("Remove-Item -LiteralPath $BackupPath"),
        )


class WindowsReleaseContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.workflow = (ROOT / ".github/workflows/agent-build.yml").read_text(
            encoding="utf-8"
        )

    def test_r2_release_is_mandatory_and_validates_all_inputs(self) -> None:
        self.assertNotIn("if: env.R2_ENDPOINT != ''", self.workflow)
        for name in (
            "R2_ENDPOINT",
            "R2_ACCESS_KEY",
            "R2_SECRET_KEY",
            "R2_BUCKET",
        ):
            with self.subTest(name=name):
                self.assertRegex(self.workflow, rf"(?m)^\s+{name}:")
        self.assertIn('test -s "$ARTIFACT"', self.workflow)

    def test_r2_object_uses_immutable_signed_release_attestation(self) -> None:
        self.assertIn("hashlib.sha256", self.workflow)
        self.assertRegex(self.workflow, r"\[0-9a-f\]\{64\}")
        self.assertIn('OBJECT_KEY="agent/releases/${VERSION}/monofarm-agent.exe"', self.workflow)
        self.assertIn("AGENT_RELEASE_ATTESTATION_PRIVATE_KEY", self.workflow)
        self.assertIn("ATTESTATION_SIGNATURE", self.workflow)
        self.assertIn("schema_version=1,algorithm=Ed25519", self.workflow)
        self.assertIn("immutable release already exists", self.workflow)


if __name__ == "__main__":
    unittest.main()
