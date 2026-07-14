import asyncio
import unittest

import monofarm_agent as agent


class StreamControlTests(unittest.TestCase):
    def tearDown(self) -> None:
        agent._cancel_all_stream_tasks()

    def test_cancel_targets_only_requested_stream(self) -> None:
        async def exercise() -> None:
            started = asyncio.Event()

            async def handler(_ws, _req) -> None:
                started.set()
                await asyncio.Event().wait()

            first = agent._start_stream_task(None, {"id": "first"}, handler)
            second = agent._start_stream_task(None, {"id": "second"}, handler)
            await started.wait()

            self.assertTrue(agent._cancel_stream_task("first"))
            await asyncio.sleep(0)

            self.assertTrue(first.cancelled())
            self.assertFalse(second.done())
            self.assertNotIn("first", agent._active_stream_tasks)
            self.assertIn("second", agent._active_stream_tasks)
            second.cancel()
            await asyncio.gather(second, return_exceptions=True)

        asyncio.run(exercise())

    def test_completed_stream_is_removed_from_registry(self) -> None:
        async def exercise() -> None:
            async def handler(_ws, _req) -> None:
                return

            task = agent._start_stream_task(None, {"id": "done"}, handler)
            await task
            await asyncio.sleep(0)

            self.assertNotIn("done", agent._active_stream_tasks)

        asyncio.run(exercise())

    def test_disconnect_cancels_every_active_stream(self) -> None:
        async def exercise() -> None:
            async def handler(_ws, _req) -> None:
                await asyncio.Event().wait()

            tasks = [
                agent._start_stream_task(None, {"id": request_id}, handler)
                for request_id in ("camera", "ffmpeg", "mjpeg")
            ]
            await asyncio.sleep(0)

            agent._cancel_all_stream_tasks()
            await asyncio.gather(*tasks, return_exceptions=True)

            self.assertFalse(agent._active_stream_tasks)
            self.assertTrue(all(task.cancelled() for task in tasks))

        asyncio.run(exercise())


if __name__ == "__main__":
    unittest.main()
