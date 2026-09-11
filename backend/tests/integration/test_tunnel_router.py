"""Real Redis transport tests; TEST_REDIS_URL must point at an isolated test service.

The multiprocessing test deliberately keeps the agent socket in another OS process.
No physical printers or cloud services are contacted. Every test owns a random key prefix.
"""
import asyncio
import base64
import json
import multiprocessing
import os
import uuid
from unittest.mock import AsyncMock

import pytest
import redis.asyncio as aioredis

from app.services import tunnel, tunnel_router
from app.services.tunnel_router import RedisTunnelRouter, TunnelRoutingError

pytestmark = pytest.mark.skipif(not os.environ.get("TEST_REDIS_URL"), reason="TEST_REDIS_URL is required")


class Socket:
    def __init__(self):
        self.messages = asyncio.Queue()
        self.close = AsyncMock()

    async def send_text(self, text):
        await self.messages.put(json.loads(text))


@pytest.fixture
async def routers():
    prefix = f"test:tunnel:{uuid.uuid4().hex}"
    url = os.environ["TEST_REDIS_URL"]
    instances = []

    async def create():
        received = asyncio.Queue()
        failures = asyncio.Queue()

        async def on_response(data, org_id):
            await received.put((org_id, data))
            return True

        router = RedisTunnelRouter(url, on_response, lambda *args: failures.put_nowait(args), prefix=prefix)
        router.received = received
        router.failures = failures
        await router.start()
        instances.append(router)
        return router

    yield create
    await asyncio.gather(*(router.stop() for router in instances))
    async with aioredis.from_url(url) as client:
        keys = [key async for key in client.scan_iter(match=f"{prefix}:*")]
        if keys:
            await client.delete(*keys)


@pytest.mark.asyncio
async def test_discovery_capabilities_and_requests_are_scoped_to_org(routers):
    owner, caller, other = await routers(), await routers(), await routers()
    own_socket, other_socket = Socket(), Socket()
    await owner.register(1, own_socket)
    await other.register(2, other_socket)
    await owner.set_capabilities(1, {"moonraker_upload_chunks", "moonraker_upload_url"})
    route = caller.owner(1)
    assert route.worker == owner.worker
    assert "moonraker_upload_url" in route.capabilities
    assert caller.owner(3) is None
    request = {"id": "private-request", "method": "GET", "url": "http://192.168.1.100/printer/info"}
    await caller.send(1, route, json.dumps(request), tracked=True)
    assert await own_socket.messages.get() == request
    assert other_socket.messages.empty()
    assert not await other.forward_response(2, {"id": "private-request", "body": "foreign"})
    assert caller.received.empty()
    await owner.forward_response(1, {"id": "private-request", "status": 200, "body": "own"})
    assert await caller.received.get() == (1, {"id": "private-request", "status": 200, "body": "own"})
    assert not owner.incoming
    await caller.release(1, "private-request")
    assert not caller.outgoing


@pytest.mark.asyncio
async def test_upload_progress_and_camera_frames_return_to_requesting_worker(routers):
    owner, caller = await routers(), await routers()
    socket = Socket()
    await owner.register(1, socket)
    route = caller.owner(1)
    for method, request_id, messages in [
        ("MOONRAKER_UPLOAD", "upload", [
            {"type": "upload_progress", "sent": 123, "total": 456},
            {"status": 201, "body": {"print_started": False}},
        ]),
        ("BAMBU_CAMERA", "camera", [
            {"type": "stream_start", "status": 200},
            {"type": "chunk", "data": base64.b64encode(b"\xff\xd8private-jpeg\xff\xd9").decode()},
            {"type": "stream_end"},
        ]),
    ]:
        await caller.send(1, route, json.dumps({"id": request_id, "method": method}), tracked=True)
        await socket.messages.get()
        for data in messages:
            await owner.forward_response(1, {"id": request_id, **data})
            assert await caller.received.get() == (1, {"id": request_id, **data})
        await caller.release(1, request_id)
    assert not owner.incoming
    assert not caller.outgoing


@pytest.mark.asyncio
async def test_large_payloads_are_fragmented_without_changing_agent_protocol(routers, monkeypatch):
    monkeypatch.setattr(tunnel_router, "FRAME_CHARS", 1024)
    owner, caller = await routers(), await routers()
    socket = Socket()
    await owner.register(1, socket)
    content = base64.b64encode(bytes(range(256)) * 128).decode()
    request = {"id": "upload", "method": "BAMBU_UPLOAD", "data_b64": content}
    await caller.send(1, caller.owner(1), json.dumps(request), tracked=True)
    assert await socket.messages.get() == request
    assert socket.messages.empty()  # one WebSocket message, despite dozens of Redis frames
    reply = {"id": "upload", "status": 200, "body": {"data": content}}
    await owner.forward_response(1, reply)
    assert await caller.received.get() == (1, reply)
    assert not caller._assemblies
    assert not owner._assemblies
    await caller.release(1, "upload")


@pytest.mark.asyncio
async def test_reconnect_fences_old_upload_and_stale_unregister(routers):
    first, second, caller = await routers(), await routers(), await routers()
    old_socket, new_socket = Socket(), Socket()
    await first.register(1, old_socket)
    old_route = caller.owner(1)
    await caller.send(1, old_route, json.dumps({"id": "old-upload", "method": "MOONRAKER_UPLOAD"}), tracked=True)
    await second.register(1, new_socket)
    failure = await asyncio.wait_for(caller.failures.get(), timeout=2)
    assert failure[:2] == ("old-upload", 1)
    old_socket.close.assert_awaited()
    await first.unregister(1, old_socket)
    assert caller.owner(1).worker == second.worker
    with pytest.raises(TunnelRoutingError):
        await caller.send(1, old_route, json.dumps({"id": "old-upload", "method": "MOONRAKER_UPLOAD_CHUNK"}), tracked=True)
    assert new_socket.messages.empty()
    await caller.release(1, "old-upload")
    await caller.send(1, caller.owner(1), json.dumps({"id": "new", "method": "GET"}), tracked=True)
    assert (await new_socket.messages.get())["id"] == "new"
    await caller.release(1, "new")


@pytest.mark.asyncio
async def test_releasing_camera_removes_remote_route(routers):
    owner, caller = await routers(), await routers()
    await owner.register(1, Socket())
    await caller.send(1, caller.owner(1), json.dumps({"id": "camera", "method": "STREAM"}), tracked=True)
    assert (1, "camera") in owner.incoming
    await caller.release(1, "camera")
    assert (1, "camera") not in owner.incoming
    assert not await owner.forward_response(1, {"id": "camera", "type": "chunk", "data": ""})


@pytest.mark.asyncio
async def test_lost_ack_never_retries_a_printer_command(routers, monkeypatch):
    owner, caller = await routers(), await routers()
    socket = Socket()
    await owner.register(1, socket)
    publish = owner.client.publish

    async def drop_ack(channel, raw):
        if json.loads(raw).get("kind") == "ack":
            return 1
        return await publish(channel, raw)

    monkeypatch.setattr(owner.client, "publish", drop_ack)
    monkeypatch.setattr(tunnel_router, "DELIVERY_TIMEOUT", 0.1)
    with pytest.raises(TunnelRoutingError, match="unknown"):
        await caller.send(1, caller.owner(1), json.dumps({"id": "pause", "method": "POST"}), tracked=True)
    assert (await socket.messages.get())["id"] == "pause"
    assert socket.messages.empty()
    monkeypatch.setattr(owner.client, "publish", publish)
    await caller.release(1, "pause")


@pytest.mark.asyncio
async def test_no_redis_discovery_does_not_fall_back_to_local_socket(routers, monkeypatch):
    owner = await routers()
    await owner.register(1, Socket())
    monkeypatch.setattr(tunnel, "_router", owner)
    monkeypatch.setattr(tunnel, "_tunnels", {1: Socket()})
    owner._ready.clear()
    with pytest.raises(TunnelRoutingError, match="unavailable"):
        tunnel.has_tunnel(1)


def _agent_process(url, prefix, pipe):
    """A socket owner in a separate interpreter (no shared dictionaries/asyncio loop)."""
    async def run():
        async def ignore_response(data, org):
            return False

        router = RedisTunnelRouter(url, ignore_response, lambda *args: None, prefix=prefix)
        await router.start()

        class AgentSocket:
            async def send_text(self, raw):
                request = json.loads(raw)
                if request["method"] == "WAIT":
                    return
                async def answer():
                    await router.forward_response(1, {"id": request["id"], "status": 200,
                                                  "body": {"agent_pid": os.getpid(), "method": request["method"]}})
                asyncio.create_task(answer())

            async def close(self, **kwargs):
                pass

        await router.register(1, AgentSocket())
        pipe.send(os.getpid())
        try:
            await asyncio.Future()
        finally:
            await router.stop()

    asyncio.run(run())


@pytest.mark.asyncio
async def test_tunnel_request_reaches_socket_in_another_os_process(routers, monkeypatch):
    caller = await routers()
    # Exercise tunnel.proxy_request itself, not only the Redis transport methods.
    caller.on_response = tunnel._deliver_agent_response
    caller.on_failure = tunnel._fail_request
    monkeypatch.setattr(tunnel, "_router", caller)
    monkeypatch.setattr(tunnel, "_tunnels", {})
    ctx = multiprocessing.get_context("spawn")
    pipe, child_pipe = ctx.Pipe()
    process = ctx.Process(target=_agent_process, args=(os.environ["TEST_REDIS_URL"], caller.prefix, child_pipe))
    process.start()
    try:
        assert await asyncio.to_thread(pipe.poll, 10), "Agent process did not start"
        agent_pid = pipe.recv()
        assert agent_pid != os.getpid()
        assert tunnel.has_tunnel(1)
        result = await tunnel.proxy_request(1, "GET", "http://192.168.1.100/printer/info")
        assert result["body"] == {"agent_pid": agent_pid, "method": "GET"}
        assert not tunnel._pending
        assert not caller.outgoing
    finally:
        process.terminate()
        await asyncio.to_thread(process.join, 5)
        if process.is_alive():
            process.kill()
            await asyncio.to_thread(process.join, 5)
        pipe.close()
        child_pipe.close()


@pytest.mark.asyncio
async def test_owner_disconnect_fails_only_that_organization(routers):
    owner, caller = await routers(), await routers()
    first, second = Socket(), Socket()
    await owner.register(1, first)
    await owner.register(2, second)
    for org_id in (1, 2):
        await caller.send(org_id, caller.owner(org_id), json.dumps({"id": str(org_id), "method": "GET"}), tracked=True)
    await owner.unregister(1, first)
    assert (await caller.failures.get())[:2] == ("1", 1)
    assert caller.failures.empty()
    await owner.forward_response(2, {"id": "2", "status": 200})
    assert await caller.received.get() == (2, {"id": "2", "status": 200})
    for org_id in (1, 2):
        await caller.release(org_id, str(org_id))


@pytest.mark.asyncio
async def test_foreign_or_stale_response_is_rejected_even_with_a_known_request_id(routers):
    owner, caller, foreign = await routers(), await routers(), await routers()
    await owner.register(1, Socket())
    route = caller.owner(1)
    await caller.send(1, route, json.dumps({"id": "known-id", "method": "GET"}), tracked=True)
    for sender, org_id, connection in [(foreign.worker, 1, route.connection),
                                       (owner.worker, 2, route.connection), (owner.worker, 1, "old-session")]:
        with pytest.raises(TunnelRoutingError):
            await caller._handle_message(sender, {"kind": "response", "org": org_id, "connection": connection,
                                         "data": {"id": "known-id", "body": "foreign"}})
    assert caller.received.empty()
    await caller.release(1, "known-id")


@pytest.mark.asyncio
async def test_request_timeout_removes_remote_waiter(routers, monkeypatch):
    owner, caller = await routers(), await routers()
    await owner.register(1, Socket())
    caller.on_response = tunnel._deliver_agent_response
    caller.on_failure = tunnel._fail_request
    monkeypatch.setattr(tunnel, "_router", caller)
    with pytest.raises(RuntimeError, match="timed out"):
        await tunnel.proxy_request(1, "GET", "http://printer/printer/info", timeout=0.01)
    assert not caller.outgoing
    assert not owner.incoming
    assert not tunnel._pending
    assert not tunnel._pending_org


@pytest.mark.asyncio
async def test_camera_generator_cancellation_releases_remote_route(routers, monkeypatch):
    owner, caller = await routers(), await routers()
    socket = Socket()
    await owner.register(1, socket)
    caller.on_response = tunnel._deliver_agent_response
    caller.on_failure = tunnel._fail_request
    monkeypatch.setattr(tunnel, "_router", caller)
    stream = tunnel.bambu_camera_stream(1, "192.168.1.100", "test-access-code")
    first_frame = asyncio.create_task(anext(stream))
    request = await socket.messages.get()
    await owner.forward_response(1, {"id": request["id"], "type": "chunk", "data": base64.b64encode(b"jpeg").decode()})
    assert await first_frame == b"jpeg"
    await stream.aclose()
    assert not owner.incoming
    assert not caller.outgoing
    assert not tunnel._pending_streams


@pytest.mark.asyncio
async def test_redis_failure_disconnects_agent_and_fails_inflight_work(routers, monkeypatch):
    import redis

    monkeypatch.setattr(tunnel_router, "HEARTBEAT_SECONDS", 0.01)
    owner = await routers()
    socket = Socket()
    await owner.register(1, socket)
    await owner.send(1, owner.owner(1), json.dumps({"id": "waiting", "method": "GET"}), tracked=True)
    monkeypatch.setattr(owner.client, "eval", AsyncMock(side_effect=redis.ConnectionError("test outage")))
    failure = await asyncio.wait_for(owner.failures.get(), timeout=2)
    assert failure[:2] == ("waiting", 1)
    for _ in range(100):
        if socket.close.await_count:
            break
        await asyncio.sleep(0.01)
    socket.close.assert_awaited()
    with pytest.raises(TunnelRoutingError):
        owner.owner(1)
    await owner.release(1, "waiting")


@pytest.mark.asyncio
async def test_slow_camera_consumer_has_bounded_queue(routers, monkeypatch):
    owner, caller = await routers(), await routers()
    socket = Socket()
    await owner.register(1, socket)
    caller.on_response = tunnel._deliver_agent_response
    caller.on_failure = tunnel._fail_request
    monkeypatch.setattr(tunnel, "_router", caller)
    stream = tunnel.proxy_stream(1, "http://printer/camera")
    first_frame = asyncio.create_task(anext(stream))
    request = await socket.messages.get()
    chunk = {"id": request["id"], "type": "chunk", "data": base64.b64encode(b"jpeg").decode()}
    await owner.forward_response(1, chunk)
    assert await first_frame == b"jpeg"
    for _ in range(17):
        await owner.forward_response(1, chunk)
    assert tunnel._pending_streams[request["id"]].qsize() <= 16
    with pytest.raises(RuntimeError, match="too slow"):
        await anext(stream)
    assert not owner.incoming


@pytest.mark.asyncio
async def test_cancelled_queued_command_is_never_sent_after_an_upload(routers):
    owner, caller = await routers(), await routers()
    entered, unblock = asyncio.Event(), asyncio.Event()
    sent = []

    class SlowSocket(Socket):
        async def send_text(self, text):
            request = json.loads(text)
            if request["id"] == "first":
                entered.set()
                await unblock.wait()
            sent.append(request["id"])

    await owner.register(1, SlowSocket())
    route = caller.owner(1)
    first = asyncio.create_task(caller.send(1, route, json.dumps({"id": "first", "method": "UPLOAD"}), tracked=True))
    await entered.wait()
    queued = asyncio.create_task(caller.send(1, route, json.dumps({"id": "cancelled", "method": "POST"}), tracked=True))
    # The owner is waiting on its socket lock, while the caller cancels the HTTP request.
    for _ in range(100):
        if (1, "cancelled") in owner.incoming:
            break
        await asyncio.sleep(0.001)
    queued.cancel()
    await asyncio.gather(queued, return_exceptions=True)
    await caller.release(1, "cancelled")
    unblock.set()
    await first
    await caller.release(1, "first")
    assert sent == ["first"]


@pytest.mark.asyncio
async def test_dead_owner_lease_expires_and_unblocks_request(routers, monkeypatch):
    monkeypatch.setattr(tunnel_router, "HEARTBEAT_SECONDS", 0.02)
    caller = await routers()
    caller.on_response = tunnel._deliver_agent_response
    caller.on_failure = tunnel._fail_request
    monkeypatch.setattr(tunnel, "_router", caller)
    ctx = multiprocessing.get_context("spawn")
    pipe, child_pipe = ctx.Pipe()
    process = ctx.Process(target=_agent_process, args=(os.environ["TEST_REDIS_URL"], caller.prefix, child_pipe))
    process.start()
    request = None
    try:
        assert await asyncio.to_thread(pipe.poll, 10)
        pipe.recv()
        request = asyncio.create_task(tunnel.proxy_request(1, "WAIT", "http://printer/status", timeout=60))
        for _ in range(100):
            if caller.outgoing and not caller._acks:
                break
            await asyncio.sleep(0.005)
        assert caller.outgoing
        process.terminate()  # abrupt exit: no unregister or Python finally block
        await asyncio.to_thread(process.join, 5)
        assert not process.is_alive()
        # Shorten the real Redis lease to keep the test fast; the dead process cannot renew it.
        await caller.client.pexpire(caller._key(1), 100)
        with pytest.raises(RuntimeError, match="lease expired"):
            await asyncio.wait_for(request, timeout=2)
        assert caller.owner(1) is None
        assert not caller.outgoing
    finally:
        if request and not request.done():
            request.cancel()
            await asyncio.gather(request, return_exceptions=True)
        if process.is_alive():
            process.kill()
            await asyncio.to_thread(process.join, 5)
        pipe.close()
        child_pipe.close()


@pytest.mark.asyncio
async def test_duplicate_pubsub_frame_cannot_execute_a_command_twice(routers, monkeypatch):
    owner, caller = await routers(), await routers()
    socket = Socket()
    await owner.register(1, socket)
    published = []
    publish = caller.client.publish

    async def capture(channel, raw):
        if json.loads(raw).get("kind") == "frame":
            published.append((channel, raw))
        return await publish(channel, raw)

    monkeypatch.setattr(caller.client, "publish", capture)
    await caller.send(1, caller.owner(1), json.dumps({"id": "start", "method": "POST"}), tracked=True)
    assert (await socket.messages.get())["id"] == "start"
    # Even an externally duplicated frame has no remaining single-use Redis permit.
    await owner._handle_frame(json.loads(published[0][1]))
    assert socket.messages.empty()
    await owner.forward_response(1, {"id": "start", "status": 200})
    assert await caller.received.get() == (1, {"id": "start", "status": 200})
    await caller.release(1, "start")


@pytest.mark.asyncio
async def test_remote_moonraker_upload_uses_capabilities_and_preserves_chunk_order(routers, monkeypatch):
    owner, caller = await routers(), await routers()
    caller.on_response = tunnel._deliver_agent_response
    caller.on_failure = tunnel._fail_request
    monkeypatch.setattr(tunnel, "_router", caller)
    data = b"G28\n" * (600 * 1024)
    assembled = bytearray()
    offsets = []
    seen_progress = []

    class UploadSocket(Socket):
        async def send_text(self, text):
            request = json.loads(text)
            if request["method"] == "MOONRAKER_UPLOAD":
                assert request["chunked"] is True
                assert "data_b64" not in request
                return
            assert request["method"] == "MOONRAKER_UPLOAD_CHUNK"
            offsets.append(request["offset"])
            assert request["offset"] == len(assembled)
            assembled.extend(base64.b64decode(request["data_b64"]))
            await owner.forward_response(1, {"id": request["id"], "type": "upload_progress",
                                         "sent": len(assembled), "total": len(data)})
            if request["final"]:
                await owner.forward_response(1, {"id": request["id"], "status": 201, "body": {"result": {"ok": True}}})

    await owner.register(1, UploadSocket())
    await owner.set_capabilities(1, {"moonraker_upload_chunks"})
    result = await tunnel.send_moonraker_upload(1, "http://printer/", "part.gcode", data,
                                              progress_callback=lambda event: seen_progress.append(event["sent"]))
    assert result == {"result": {"ok": True}}
    assert assembled == data
    assert offsets == [0, 1024 * 1024, 2 * 1024 * 1024]
    assert seen_progress[-1] == len(data)
    assert not owner.incoming
    assert not caller.outgoing


@pytest.mark.asyncio
async def test_telegram_configuration_and_notifications_route_without_request_futures(routers, monkeypatch):
    owner, caller = await routers(), await routers()
    socket = Socket()
    await owner.register(1, socket)
    monkeypatch.setattr(tunnel, "_router", caller)
    await tunnel.send_tg_config(1, "test-token")
    assert await socket.messages.get() == {"type": "TG_CONFIG", "token": "test-token"}
    assert await tunnel.send_telegram(1, 1234, "Private plan") is True
    assert (await socket.messages.get())["text"] == "Private plan"
    assert await tunnel.send_telegram(2, 1234, "Foreign") is False
    assert socket.messages.empty()
    assert not caller.outgoing
    assert not owner.incoming


@pytest.mark.asyncio
async def test_idle_connection_lease_is_renewed(routers, monkeypatch):
    monkeypatch.setattr(tunnel_router, "LEASE_SECONDS", 1)
    monkeypatch.setattr(tunnel_router, "HEARTBEAT_SECONDS", 0.1)
    owner, caller = await routers(), await routers()
    socket = Socket()
    await owner.register(1, socket)
    original = caller.owner(1)
    await asyncio.sleep(1.1)
    assert caller.owner(1) == original
    socket.close.assert_not_awaited()


@pytest.mark.asyncio
async def test_scheduler_lease_works_with_decoded_redis_and_keeps_another_owner(routers, monkeypatch):
    from app.core import leader
    from app.services import cache

    router = await routers()
    monkeypatch.setattr(cache, "_r", lambda: router.discovery)
    monkeypatch.setattr(leader, "LOCK_KEY", f"{router.prefix}:scheduler")
    monkeypatch.setattr(leader, "_worker_id", lambda: "first-worker")
    assert leader.try_acquire()
    assert leader.renew()  # cache's Redis client returns str, not bytes
    monkeypatch.setattr(leader, "_worker_id", lambda: "other-worker")
    assert not leader.renew()
    leader.release()
    assert router.discovery.get(leader.LOCK_KEY) == "first-worker"
    monkeypatch.setattr(leader, "_worker_id", lambda: "first-worker")
    leader.release()
    assert router.discovery.get(leader.LOCK_KEY) is None


@pytest.mark.asyncio
async def test_new_org_request_during_heartbeat_does_not_disconnect_existing_work(routers, monkeypatch):
    monkeypatch.setattr(tunnel_router, "HEARTBEAT_SECONDS", 0.01)
    owner, caller = await routers(), await routers()
    await owner.register(1, Socket())
    await owner.register(2, Socket())
    await caller.send(1, caller.owner(1), json.dumps({"id": "first-org", "method": "GET"}), tracked=True)
    read = caller.client.hgetall
    started = asyncio.Event()

    async def add_request_during_read(key):
        if not started.is_set():
            started.set()
            await caller.send(2, caller.owner(2), json.dumps({"id": "second-org", "method": "GET"}), tracked=True)
        return await read(key)

    monkeypatch.setattr(caller.client, "hgetall", add_request_during_read)
    await asyncio.wait_for(started.wait(), timeout=1)
    await asyncio.sleep(0.05)
    assert caller.owner(1) is not None
    assert caller.owner(2) is not None
    assert caller.failures.empty()
    await caller.release(1, "first-org")
    await caller.release(2, "second-org")
