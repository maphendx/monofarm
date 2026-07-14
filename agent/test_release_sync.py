import os
import re
import unittest
from pathlib import Path
from unittest.mock import patch

import legacy_bootstrap
import monofarm_agent
import update_policy


ROOT = Path(__file__).resolve().parents[1]


class ReleaseTrustSyncTests(unittest.TestCase):
    def test_builtin_key_bootstraps_legacy_and_current_agents(self) -> None:
        with (
            patch.dict(os.environ, {"MONOFARM_UPDATE_PUBLIC_KEYS": ""}),
            patch.object(monofarm_agent, "_load_config", return_value={}),
        ):
            self.assertEqual(
                monofarm_agent._configured_update_public_keys(),
                [update_policy.BUILTIN_RELEASE_PUBLIC_KEY],
            )
            self.assertEqual(
                legacy_bootstrap._configured_public_keys({}),
                [update_policy.BUILTIN_RELEASE_PUBLIC_KEY],
            )

    def test_committed_public_key_matches_every_runtime_surface(self) -> None:
        public_key = (ROOT / "agent" / "release_public_key.b64").read_text().strip()
        self.assertRegex(public_key, r"^[A-Za-z0-9+/]{43}=$")
        self.assertEqual(update_policy.BUILTIN_RELEASE_PUBLIC_KEY, public_key)
        self.assertEqual(legacy_bootstrap.BUILTIN_RELEASE_PUBLIC_KEY, public_key)

        backend = (ROOT / "backend" / "app" / "core" / "agent_release_trust.py").read_text()
        frontend = (ROOT / "frontend" / "src" / "lib" / "agentReleaseTrust.ts").read_text()
        installer = (ROOT / "agent" / "install.sh").read_text()
        windows_installer = (ROOT / "agent" / "install.ps1").read_text()
        for source in (backend, frontend, installer, windows_installer):
            self.assertIn(public_key, source)
        self.assertNotIn(
            "ExpectedSha256 must come from a trusted CI release channel",
            windows_installer,
        )

    def test_ci_publishes_agent_before_the_existing_deploy_gate(self) -> None:
        ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
        release = (ROOT / ".github" / "workflows" / "agent-build.yml").read_text()

        self.assertIn("release_plan:", ci)
        self.assertIn("agent_release:", ci)
        self.assertIn("uses: ./.github/workflows/agent-build.yml", ci)
        self.assertRegex(ci, r"agent_release:[\s\S]+needs:[\s\S]+release_plan")
        self.assertIn("workflow_call:", release)
        self.assertIn("agent/release_public_key.b64", release)
        self.assertIn("does not match committed release public key", release)

    def test_ci_requires_a_version_bump_for_runtime_changes(self) -> None:
        ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text()

        self.assertIn("Agent runtime changed without AGENT_VERSION bump", ci)
        self.assertTrue(re.search(r"publish=true", ci))


if __name__ == "__main__":
    unittest.main()
