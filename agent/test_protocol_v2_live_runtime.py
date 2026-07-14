import hashlib
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

import monofarm_agent as agent
from command_runtime import CommandExecutionResult, LeasedAgentCommand
from device_identity import DeviceCredentials
from printer_runtime import RuntimePrinter


DEVICE_ID = "019f5d2d-a569-7c51-8bd4-d91ff6ac6a9e"
COMMAND_ID = "119f5d2d-a569-7c51-8bd4-d91ff6ac6a9e"


def _command(command_type: str, *, printer_id: int = 7) -> LeasedAgentCommand:
    now = datetime.now(timezone.utc)
    return LeasedAgentCommand(
        command_id=COMMAND_ID,
        agent_device_id=DEVICE_ID,
        printer_id=printer_id,
        command_type=command_type,
        payload={},
        payload_sha256=hashlib.sha256(b"{}").hexdigest(),
        attempt=1,
        deadline_at=now + timedelta(minutes=10),
        lease_expires_at=now + timedelta(minutes=5),
    )


class ProtocolV2LiveRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_worker_dispatches_only_through_authenticated_runtime_registry(self) -> None:
        agent._runtime_printer_registry.replace(
            {
                "device_id": DEVICE_ID,
                "organization_id": 1,
                "artifact_hosts": ["files.monofarm.app"],
                "printers": [
                    {
                        "id": 7,
                        "transport": "moonraker",
                        "name": "U1-07",
                        "kind": "snapmaker_u1",
                        "moonraker_url": "http://192.168.10.7:7125",
                    }
                ],
            }
        )
        control = AsyncMock(
            return_value=CommandExecutionResult(
                {"provider": "moonraker", "state": "idle"}
            )
        )

        with (
            tempfile.TemporaryDirectory() as tmp,
            patch.object(
                agent,
                "_configured_device_credentials",
                return_value=DeviceCredentials(DEVICE_ID, "device-secret"),
            ),
            patch.object(agent, "CONFIG_DIR", Path(tmp)),
            patch.object(agent, "_runtime_control_handler", new=control),
        ):
            worker, journal, artifact_client = agent._build_protocol_v2_runtime(
                "https://api.monofarm.app",
                "",
            )
            try:
                result = await worker.handler(_command("printer.status"))
                self.assertEqual(result.payload["state"], "idle")
                assigned_printer = control.await_args.args[0]
                self.assertEqual(assigned_printer.id, 7)
                self.assertEqual(
                    journal.path,
                    Path(tmp) / "runtime" / DEVICE_ID / "commands.sqlite3",
                )
            finally:
                await worker.close()
                await artifact_client.aclose()
                journal.close()

    async def test_snapshot_returns_bounded_metadata_not_image_bytes(self) -> None:
        frame = b"small-jpeg-frame"
        printer = RuntimePrinter(
            id=7,
            provider="bambu",
            name="A1 mini",
            kind="bambu",
            model="A1 mini",
            dev_id="01P00A000000001",
            ip="192.168.10.8",
            access_code="12345678",
        )
        with patch.object(agent, "_bambu_grab_frame", AsyncMock(return_value=frame)):
            result = await agent._runtime_control_handler(
                printer,
                _command("printer.snapshot"),
            )

        self.assertEqual(
            result.payload,
            {
                "provider": "bambu",
                "captured": True,
                "size": len(frame),
                "sha256": hashlib.sha256(frame).hexdigest(),
            },
        )
        self.assertNotIn("data", result.payload)


if __name__ == "__main__":
    unittest.main()
