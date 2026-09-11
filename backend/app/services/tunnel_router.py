"""Redis ownership leases and acknowledged Pub/Sub transport for agent tunnels.

Only the owning process touches a WebSocket. A request is pinned to that socket's
connection ID, including subsequent upload chunks. Redis is trusted infrastructure;
its channels must not be accessible to tenants. Pub/Sub is not a durable job queue:
we never retry a printer command after an ambiguous delivery failure.
"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import math
import time
import tempfile
import uuid
from dataclasses import dataclass, field
from typing import Awaitable, Callable

import redis
import redis.asyncio as aioredis
from redis.backoff import NoBackoff
from redis.retry import Retry
from redis.asyncio.retry import Retry as AsyncRetry

log = logging.getLogger(__name__)
PREFIX = "monofarm:tunnel:v1"
LEASE_SECONDS = 15
HEARTBEAT_SECONDS = 4
DELIVERY_TIMEOUT = 15.0
FRAME_CHARS = 256 * 1024
MAX_MESSAGE_CHARS = 704 * 1024 * 1024  # accommodates the existing 500 MiB upload limit + base64
ASSEMBLY_TIMEOUT = 30.0
MAX_ASSEMBLIES = 32
MAX_HANDLERS = 128

_CLAIM = """
local old = redis.call('HGETALL', KEYS[1])
redis.call('HSET', KEYS[1], 'worker', ARGV[1], 'connection', ARGV[2], 'capabilities', '[]')
redis.call('EXPIRE', KEYS[1], ARGV[3])
return old
"""
_RENEW = """
if redis.call('HGET', KEYS[1], 'connection') ~= ARGV[1] then return 0 end
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
"""
_DELETE = """
if redis.call('HGET', KEYS[1], 'connection') ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
"""
_CONSUME_PERMIT = """
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
"""
_CAPABILITIES = """
if redis.call('HGET', KEYS[1], 'connection') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'capabilities', ARGV[2])
return 1
"""


class TunnelRoutingError(RuntimeError):
    """Delivery failed or is uncertain; callers must not automatically resend."""


@dataclass(frozen=True)
class Owner:
    worker: str
    connection: str
    capabilities: frozenset[str] = frozenset()

    @classmethod
    def from_hash(cls, value: dict) -> Owner | None:
        if not value:
            return None
        return cls(value["worker"], value["connection"], frozenset(json.loads(value["capabilities"])))


@dataclass
class LocalConnection:
    owner: Owner
    socket: object
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


@dataclass
class Assembly:
    # Large legacy uploads must not accumulate a second full copy in RAM.
    buffer: io.TextIOBase = field(default_factory=lambda: tempfile.SpooledTemporaryFile(
        max_size=FRAME_CHARS, mode="w+", encoding="utf-8",
    ))
    index: int = 0
    size: int = 0
    touched: float = field(default_factory=time.monotonic)


class RedisTunnelRouter:
    def __init__(
        self,
        url: str,
        on_response: Callable[[dict, int], Awaitable[bool]],
        on_failure: Callable[[str, int, str], None],
        *,
        prefix: str = PREFIX,
    ):
        self.worker = uuid.uuid4().hex
        self.prefix = prefix
        self.on_response = on_response
        self.on_failure = on_failure
        # Discovery is also called by synchronous API/service code. Use a separate,
        # bounded-time client rather than sharing an asyncio client across loops.
        self.discovery = redis.Redis.from_url(
            url, decode_responses=True, socket_timeout=1, socket_connect_timeout=1, retry=Retry(NoBackoff(), 0),
        )
        # redis-py defaults can retry PUBLISH after a lost server reply. Disable
        # transport retries explicitly: these messages can start physical motion.
        self.client = aioredis.Redis.from_url(
            url, decode_responses=True, socket_timeout=2, socket_connect_timeout=2, retry=AsyncRetry(NoBackoff(), 0),
        )
        self.locals: dict[int, LocalConnection] = {}
        self._retiring: dict[tuple[int, str], LocalConnection] = {}
        self.outgoing: dict[str, tuple[int, Owner]] = {}
        self.incoming: dict[tuple[int, str], tuple[str, str]] = {}  # (org, request) -> (caller, connection)
        self._released: dict[tuple[int, str, str], tuple[str, float]] = {}
        self._acks: dict[tuple[str, int], tuple[str, asyncio.Future]] = {}
        self._assemblies: dict[tuple[str, str], Assembly] = {}
        self._handlers: set[asyncio.Task] = set()
        self._ready = asyncio.Event()
        self._runner: asyncio.Task | None = None
        self._stopping = False

    def _key(self, org_id: int) -> str:
        if type(org_id) is not int or org_id <= 0:
            raise TunnelRoutingError("Tunnel requires an organization")
        return f"{self.prefix}:org:{org_id}"

    def _channel(self, worker: str) -> str:
        if len(worker) != 32 or any(ch not in "0123456789abcdef" for ch in worker):
            raise TunnelRoutingError("Invalid tunnel worker")
        return f"{self.prefix}:worker:{worker}"

    def _permit_key(self, sender: str, delivery: str) -> str:
        return f"{self.prefix}:delivery:{sender}:{delivery}"

    def _require_ready(self) -> None:
        if not self._ready.is_set():
            raise TunnelRoutingError("Agent routing is unavailable")

    def accepts_socket(self, org_id: int, socket: object) -> bool:
        local = self.locals.get(org_id)
        return self._ready.is_set() and local is not None and local.socket is socket

    def owner(self, org_id: int) -> Owner | None:
        self._require_ready()
        try:
            return Owner.from_hash(self.discovery.hgetall(self._key(org_id)))
        except redis.RedisError as exc:
            raise TunnelRoutingError("Agent discovery is unavailable") from exc

    async def start(self) -> None:
        self._runner = asyncio.create_task(self._run(), name="agent-redis-router")
        try:
            await asyncio.wait_for(self._ready.wait(), timeout=5)
        except BaseException:
            await self.stop()
            raise

    async def stop(self) -> None:
        self._stopping = True
        self._ready.clear()
        if self._runner:
            self._runner.cancel()
            await asyncio.gather(self._runner, return_exceptions=True)
        await self._fail_transport()
        await self.client.aclose()
        self.discovery.close()

    async def register(self, org_id: int, socket: object) -> None:
        self._require_ready()
        owner = Owner(self.worker, uuid.uuid4().hex)
        old = await self.client.eval(_CLAIM, 1, self._key(org_id), self.worker, owner.connection, LEASE_SECONDS)
        previous = self.locals.get(org_id)
        self.locals[org_id] = LocalConnection(owner, socket)
        if previous:
            await self._retire(org_id, previous)
        previous_owner = Owner.from_hash(dict(zip(old[::2], old[1::2])))
        if previous_owner and previous_owner.worker != self.worker:
            try:
                await self._exchange(previous_owner.worker, {"kind": "replace", "org": org_id,
                                     "connection": previous_owner.connection})
            except TunnelRoutingError:
                # Lease fencing still prevents delivery on the old connection.
                pass

    async def unregister(self, org_id: int, socket: object) -> None:
        local = self.locals.get(org_id)
        if not local or local.socket is not socket:
            return
        self.locals.pop(org_id, None)
        try:
            await self.client.eval(_DELETE, 1, self._key(org_id), local.owner.connection)
        except redis.RedisError:
            pass  # a crashed/unreachable owner expires automatically
        await self._retire(org_id, local)

    async def set_capabilities(self, org_id: int, capabilities: set[str]) -> None:
        local = self.locals.get(org_id)
        if local:
            ok = await self.client.eval(_CAPABILITIES, 1, self._key(org_id), local.owner.connection,
                                        json.dumps(sorted(capabilities)))
            if not ok:
                raise TunnelRoutingError("Agent connection was replaced")

    async def send(self, org_id: int, owner: Owner, raw: str, *, tracked: bool) -> None:
        self._require_ready()
        data = json.loads(raw)
        request_id = data.get("id")
        if tracked:
            binding = self.outgoing.setdefault(request_id, (org_id, owner))
            if binding != (org_id, owner):
                raise TunnelRoutingError("Agent request changed connection")
        if owner.worker == self.worker:
            await self._send_local(org_id, owner.connection, raw)
        else:
            await self._exchange(owner.worker, {"kind": "command", "org": org_id,
                                 "connection": owner.connection, "raw": raw, "tracked": tracked})

    async def release(self, org_id: int, request_id: str) -> None:
        binding = self.outgoing.pop(request_id, None)
        if not binding or binding[0] != org_id or binding[1].worker == self.worker:
            return
        try:
            await asyncio.wait_for(self._exchange(binding[1].worker, {
                "kind": "release", "org": org_id, "connection": binding[1].connection, "request": request_id,
            }), timeout=2)
        except (TunnelRoutingError, asyncio.TimeoutError):
            pass

    async def forward_response(self, org_id: int, data: dict) -> bool:
        """Return True when this response belongs to a remote caller."""
        key = (org_id, data.get("id"))
        route = self.incoming.get(key)
        if not route:
            return False
        caller, connection = route
        local = self.locals.get(org_id)
        if not local or local.owner.connection != connection:
            self.incoming.pop(key, None)
            return True
        try:
            await self._exchange(caller, {"kind": "response", "org": org_id,
                                 "connection": connection, "data": data})
        except TunnelRoutingError:
            self.incoming.pop(key, None)
            return True
        if data.get("type") not in {"chunk", "stream_start", "upload_progress"}:
            self.incoming.pop(key, None)
        return True

    async def _send_local(
        self, org_id: int, connection: str, raw: str, *, caller: str | None = None, request_id: str | None = None,
        permit: tuple[str, str] | None = None,
    ) -> None:
        local = self.locals.get(org_id)
        if not local or local.owner.connection != connection:
            raise TunnelRoutingError("Agent connection was replaced")
        # Include time waiting behind another upload in the delivery budget. A
        # timed-out request must not sit in a send queue and execute minutes later.
        async with asyncio.timeout(DELIVERY_TIMEOUT):
            async with local.lock:
                self._require_ready()
                active = await self.client.hget(self._key(org_id), "connection")
                if active != connection:
                    raise TunnelRoutingError("Agent connection was replaced")
                if caller is not None and self.incoming.get((org_id, request_id)) != (caller, connection):
                    raise TunnelRoutingError("Agent request was cancelled")
                if permit is not None:
                    # Redis TTL supplies a shared clock, and consuming the permit
                    # prevents delayed/duplicate Pub/Sub frames from executing again.
                    if not await self.client.eval(_CONSUME_PERMIT, 1, self._permit_key(*permit), self.worker):
                        raise TunnelRoutingError("Agent delivery expired or was already consumed")
                await local.socket.send_text(raw)

    async def _exchange(self, peer: str, message: dict) -> None:
        """Fragment large uploads/responses; ACK each part for bounded Pub/Sub buffers.

        The final ACK means the handler accepted/sent the message, not that a
        printer executed it. No retransmission: loss of an ACK is an uncertain result.
        """
        self._require_ready()
        raw = json.dumps(message, separators=(",", ":"))
        if len(raw) > MAX_MESSAGE_CHARS:
            raise TunnelRoutingError("Agent relay message exceeds the upload limit")
        delivery = uuid.uuid4().hex
        for index, offset in enumerate(range(0, len(raw), FRAME_CHARS)):
            key = (delivery, index)
            future = asyncio.get_running_loop().create_future()
            self._acks[key] = (peer, future)
            permit_key = None
            try:
                if message["kind"] == "command" and offset + FRAME_CHARS >= len(raw):
                    permit_key = self._permit_key(self.worker, delivery)
                    await self.client.set(permit_key, peer, ex=max(1, math.ceil(DELIVERY_TIMEOUT)), nx=True)
                count = await self.client.publish(self._channel(peer), json.dumps({
                    "kind": "frame", "sender": self.worker, "delivery": delivery, "index": index,
                    "last": offset + FRAME_CHARS >= len(raw), "data": raw[offset:offset + FRAME_CHARS],
                }))
                if count != 1:
                    raise TunnelRoutingError("Agent routing peer is unavailable")
                await asyncio.wait_for(future, timeout=DELIVERY_TIMEOUT)
            except (redis.RedisError, asyncio.TimeoutError) as exc:
                raise TunnelRoutingError("Agent delivery failed; execution status is unknown") from exc
            finally:
                self._acks.pop(key, None)
                if permit_key:
                    try:
                        await self.client.delete(permit_key)
                    except redis.RedisError:
                        pass  # Redis TTL bounds a permit even if the caller dies

    async def _handle_frame(self, frame: dict) -> None:
        sender, delivery, index = frame["sender"], frame["delivery"], frame["index"]
        key = (sender, delivery)
        ok = False
        try:
            assembly = self._assemblies.get(key)
            if assembly is None:
                if index != 0 or len(self._assemblies) >= MAX_ASSEMBLIES:
                    raise TunnelRoutingError("Invalid or overloaded agent relay")
                assembly = self._assemblies[key] = Assembly()
            part = frame["data"]
            if assembly.index != index or len(part) > FRAME_CHARS or assembly.size + len(part) > MAX_MESSAGE_CHARS:
                raise TunnelRoutingError("Invalid agent relay fragment")
            assembly.buffer.write(part)
            assembly.size += len(part)
            assembly.index += 1
            assembly.touched = time.monotonic()
            if frame["last"]:
                self._assemblies.pop(key, None)
                with assembly.buffer as buffer:
                    buffer.seek(0)
                    message = json.load(buffer)
                await self._handle_message(sender, message, delivery=delivery)
            ok = True
        except Exception:
            assembly = self._assemblies.pop(key, None)
            if assembly:
                assembly.buffer.close()
            # Do not log payloads or exception text: commands contain LAN credentials.
            log.debug("Agent relay message rejected")
        finally:
            await self.client.publish(self._channel(sender), json.dumps({"kind": "ack", "sender": self.worker,
                                      "delivery": delivery, "index": index, "ok": ok}))

    async def _handle_message(self, sender: str, message: dict, *, delivery: str | None = None) -> None:
        kind, org_id, connection = message["kind"], message["org"], message["connection"]
        self._key(org_id)  # strict tenant identifier validation
        if kind == "command":
            if delivery is None:
                raise TunnelRoutingError("Agent command has no delivery permit")
            local = self.locals.get(org_id)
            if not local or local.owner.connection != connection:
                raise TunnelRoutingError("Agent connection was replaced")
            request_id = json.loads(message["raw"]).get("id")
            key = (org_id, request_id)
            created_route = message["tracked"] and key not in self.incoming
            if message["tracked"]:
                if self._released.get((org_id, request_id, connection), (None,))[0] == sender:
                    raise TunnelRoutingError("Agent request was cancelled")
                route = self.incoming.setdefault(key, (sender, connection))
                if route != (sender, connection):
                    raise TunnelRoutingError("Agent response route mismatch")
            try:
                await self._send_local(org_id, connection, message["raw"],
                                       caller=sender if message["tracked"] else None, request_id=request_id, permit=(sender, delivery))
            except BaseException:
                if created_route:
                    self.incoming.pop(key, None)
                raise
        elif kind == "response":
            data = message["data"]
            binding = self.outgoing.get(data.get("id"))
            if not binding or binding[0] != org_id or (binding[1].worker, binding[1].connection) != (sender, connection):
                raise TunnelRoutingError("Unknown agent response")
            if not await self.on_response(data, org_id):
                raise TunnelRoutingError("Agent request already finished")
        elif kind == "release":
            key = (org_id, message["request"])
            # A cancellation can overtake the final upload fragment on Redis's
            # separate connections. Remember it until all pending frames expire.
            self._released[(org_id, message["request"], connection)] = (sender, time.monotonic())
            if self.incoming.get(key) == (sender, connection):
                self.incoming.pop(key, None)
        elif kind == "disconnect":
            for request_id, (request_org, owner) in list(self.outgoing.items()):
                if request_org == org_id and (owner.worker, owner.connection) == (sender, connection):
                    self.on_failure(request_id, org_id, "Agent disconnected")
        elif kind == "replace":
            local = self.locals.get(org_id)
            active = await self.client.hgetall(self._key(org_id))
            if local and local.owner.connection == connection and active.get("worker") == sender and active.get("connection") != connection:
                self.locals.pop(org_id, None)
                await self._retire(org_id, local)
        else:
            raise TunnelRoutingError("Unknown agent relay message")

    async def _retire(self, org_id: int, local: LocalConnection) -> None:
        connection = local.owner.connection
        self._retiring[(org_id, connection)] = local
        peers = {caller for (oid, _), (caller, conn) in self.incoming.items() if oid == org_id and conn == connection}
        for key, (_, conn) in list(self.incoming.items()):
            if key[0] == org_id and conn == connection:
                self.incoming.pop(key, None)
        for request_id, (oid, owner) in list(self.outgoing.items()):
            if oid == org_id and owner.worker == self.worker and owner.connection == connection:
                self.on_failure(request_id, org_id, "Agent disconnected")
        try:
            await asyncio.wait_for(local.socket.close(code=1012), timeout=1)
        except Exception:
            pass
        self._retiring.pop((org_id, connection), None)

        async def notify(peer):
            try:
                await asyncio.wait_for(self._exchange(peer, {"kind": "disconnect", "org": org_id,
                                       "connection": connection}), timeout=1)
            except (TunnelRoutingError, asyncio.TimeoutError):
                pass
        await asyncio.gather(*(notify(peer) for peer in peers))

    async def _heartbeat(self) -> None:
        while True:
            await asyncio.sleep(HEARTBEAT_SECONDS)
            for org_id, local in list(self.locals.items()):
                if not await self.client.eval(_RENEW, 1, self._key(org_id), local.owner.connection, LEASE_SECONDS):
                    if self.locals.get(org_id) is local:
                        self.locals.pop(org_id, None)
                    task = asyncio.create_task(self._retire(org_id, local))
                    self._handlers.add(task)
                    task.add_done_callback(self._handler_done)
            requests = list(self.outgoing.items())
            owners = {}
            for _, (org_id, _) in requests:
                if org_id not in owners:
                    owners[org_id] = await self.client.hgetall(self._key(org_id))
            for request_id, (org_id, owner) in requests:
                if owners[org_id].get("connection") != owner.connection:
                    self.on_failure(request_id, org_id, "Agent ownership lease expired or changed")
            for key, (_, released_at) in list(self._released.items()):
                if time.monotonic() - released_at > ASSEMBLY_TIMEOUT:
                    self._released.pop(key, None)
            for key, assembly in list(self._assemblies.items()):
                if time.monotonic() - assembly.touched > ASSEMBLY_TIMEOUT:
                    self._assemblies.pop(key).buffer.close()

    async def _listen(self, pubsub) -> None:
        while True:
            item = await pubsub.get_message(timeout=1)
            if not item or item["type"] != "message":
                continue
            try:
                message = json.loads(item["data"])
                if message.get("kind") == "ack":
                    entry = self._acks.get((message["delivery"], message["index"]))
                    if entry and entry[0] == message["sender"] and not entry[1].done():
                        if message["ok"]:
                            entry[1].set_result(None)
                        else:
                            entry[1].set_exception(TunnelRoutingError("Agent relay rejected delivery"))
                elif message.get("kind") == "frame":
                    self._channel(message["sender"])
                    if len(self._handlers) >= MAX_HANDLERS:
                        # Reject this delivery rather than disconnecting every
                        # organization's agent when a single caller overloads us.
                        await self.client.publish(self._channel(message["sender"]), json.dumps({
                            "kind": "ack", "sender": self.worker, "delivery": message["delivery"],
                            "index": message["index"], "ok": False,
                        }))
                        continue
                    task = asyncio.create_task(self._handle_frame(message))
                    self._handlers.add(task)
                    task.add_done_callback(self._handler_done)
            except (ValueError, KeyError, TypeError):
                log.warning("Invalid agent relay envelope")

    def _handler_done(self, task: asyncio.Task) -> None:
        self._handlers.discard(task)
        if not task.cancelled():
            task.exception()  # retrieved; payload-bearing exceptions must not reach logs

    async def _fail_transport(self) -> None:
        self._ready.clear()
        for _, future in list(self._acks.values()):
            if not future.done():
                future.set_exception(TunnelRoutingError("Agent routing connection lost"))
        for request_id, (org_id, _) in list(self.outgoing.items()):
            self.on_failure(request_id, org_id, "Agent routing connection lost")
        for task in list(self._handlers):
            task.cancel()
        await asyncio.gather(*self._handlers, return_exceptions=True)
        for assembly in self._assemblies.values():
            assembly.buffer.close()
        self._assemblies.clear()
        self.incoming.clear()
        self._released.clear()
        connections = {(org_id, local.owner.connection): local for org_id, local in self.locals.items()}
        connections.update(self._retiring)
        local_connections = [(org_id, local) for (org_id, _), local in connections.items()]
        self.locals.clear()
        self._retiring.clear()
        for org_id, local in local_connections:
            try:
                await self.client.eval(_DELETE, 1, self._key(org_id), local.owner.connection)
            except redis.RedisError:
                pass
            await self._retire(org_id, local)

    async def _run(self) -> None:
        while not self._stopping:
            heartbeat = listener = None
            try:
                async with self.client.pubsub() as pubsub:
                    await pubsub.subscribe(self._channel(self.worker))
                    # Consume the subscription ACK before publishing ownership.
                    while True:
                        ack = await pubsub.get_message(timeout=2)
                        if ack and ack["type"] == "subscribe":
                            break
                    self._ready.set()
                    heartbeat = asyncio.create_task(self._heartbeat())
                    listener = asyncio.create_task(self._listen(pubsub))
                    done, _ = await asyncio.wait({heartbeat, listener}, return_when=asyncio.FIRST_COMPLETED)
                    for task in done:
                        task.result()
                    raise TunnelRoutingError("Agent relay subscription ended")
            except asyncio.CancelledError:
                return
            except Exception:
                log.warning("Agent Redis routing unavailable; disconnecting tunnels before reconnect")
            finally:
                for task in (heartbeat, listener):
                    if task:
                        task.cancel()
                await asyncio.gather(*(task for task in (heartbeat, listener) if task), return_exceptions=True)
                await self._fail_transport()
            await asyncio.sleep(1)
