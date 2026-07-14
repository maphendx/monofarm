import asyncio
import base64
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import monofarm_agent as agent


class _WebSocket:
    def __init__(self) -> None:
        self.messages: list[str] = []

    async def send(self, payload: str) -> None:
        self.messages.append(payload)


class MoonrakerChunkSpoolTests(unittest.IsolatedAsyncioTestCase):
    def tearDown(self) -> None:
        for state in agent._moonraker_upload_buffers.values():
            path = state.get("path")
            if isinstance(path, Path):
                path.unlink(missing_ok=True)
        agent._moonraker_upload_buffers.clear()

    async def test_chunks_are_written_to_disk_not_accumulated_in_ram(self) -> None:
        ws = _WebSocket()
        with tempfile.NamedTemporaryFile(suffix=".upload", delete=False) as spool:
            spool_path = Path(spool.name)
        agent._moonraker_upload_buffers["upload-1"] = {
            "meta": {
                "id": "upload-1",
                "url": "http://192.168.1.40:7125",
                "filename": "part.gcode",
            },
            "path": spool_path,
            "next_offset": 0,
            "total_bytes": 6,
        }
        captured_path: Path | None = None

        async def capture(_ws, request: dict) -> None:
            nonlocal captured_path
            captured_path = request["_data_path"]
            self.assertIsInstance(captured_path, Path)
            self.assertEqual(captured_path.read_bytes(), b"abcdef")
            captured_path.unlink(missing_ok=True)

        with (
            patch.object(agent, "handle_moonraker_upload", new=capture),
            patch.object(agent, "_require_spool_quota"),
        ):
            await agent.handle_moonraker_upload_chunk(
                ws,
                {
                    "id": "upload-1",
                    "offset": 0,
                    "final": False,
                    "data_b64": base64.b64encode(b"abc").decode(),
                },
            )
            self.assertNotIn("data", agent._moonraker_upload_buffers["upload-1"])
            self.assertEqual(spool_path.read_bytes(), b"abc")
            await agent.handle_moonraker_upload_chunk(
                ws,
                {
                    "id": "upload-1",
                    "offset": 3,
                    "final": True,
                    "data_b64": base64.b64encode(b"def").decode(),
                },
            )
            await asyncio.sleep(0)

        self.assertIsNotNone(captured_path)
        self.assertNotIn("upload-1", agent._moonraker_upload_buffers)

    async def test_declared_oversize_is_rejected_and_spool_removed(self) -> None:
        ws = _WebSocket()
        with tempfile.NamedTemporaryFile(suffix=".upload", delete=False) as spool:
            spool_path = Path(spool.name)
        agent._moonraker_upload_buffers["upload-big"] = {
            "meta": {"id": "upload-big"},
            "path": spool_path,
            "next_offset": 0,
            "total_bytes": 101,
        }

        with patch.object(agent, "_max_artifact_bytes", return_value=100):
            await agent.handle_moonraker_upload_chunk(
                ws,
                {
                    "id": "upload-big",
                    "offset": 0,
                    "final": False,
                    "data_b64": base64.b64encode(b"a").decode(),
                },
            )

        self.assertFalse(spool_path.exists())
        self.assertNotIn("upload-big", agent._moonraker_upload_buffers)
        self.assertTrue(ws.messages)

    async def test_cloud_string_cannot_select_an_agent_local_path(self) -> None:
        ws = AsyncMock()
        secret_path = Path(tempfile.gettempdir()) / "monofarm-agent-secret-test"
        secret_path.write_bytes(b"must-not-be-read")
        try:
            with patch.object(agent, "_registered_moonraker_hosts", return_value=set()):
                await agent.handle_moonraker_upload(
                    ws,
                    {
                        "id": "upload-local-path",
                        "url": "http://192.168.1.40:7125",
                        "filename": "part.gcode",
                        "_data_path": str(secret_path),
                    },
                )
            self.assertTrue(secret_path.exists())
            self.assertEqual(secret_path.read_bytes(), b"must-not-be-read")
        finally:
            secret_path.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
