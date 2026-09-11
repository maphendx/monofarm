# Agent tunnel routing across processes

The agent WebSocket still belongs to one web process. `services/tunnel_router.py`
uses Redis to find that process and relay commands and replies to the process
handling an HTTP request or background job. `services/tunnel.py` keeps the public
service functions and the existing agent wire protocol.

```mermaid
flowchart LR
    HTTP[HTTP request] --> Caller[Web process B]
    Background[Background worker] --> Redis[(Private Redis)]
    Caller <--> Redis
    Redis <--> Owner[Web process A: socket owner]
    Owner <-->|Existing WebSocket protocol| Agent[Farm agent]
    Agent <--> Printer[Local printer]
```

## Configuration and lifecycle

- Set the **same `REDIS_URL`** for every web and background-worker process in one
  deployment. Use a separate Redis service/database for separate environments.
  Tenants must not have access to Redis: messages can contain printer credentials,
  private file content, Telegram configuration and camera frames.
- Web and background-worker lifespans start the router before their work begins.
  Startup requires a working subscription when Redis is configured. Runtime loss
  fails in-flight requests and disconnects owned agents before reconnecting;
  discovery errors do not silently choose a local/direct-printer fallback.
- With `REDIS_URL` empty, the previous local tunnel remains available for
  **single-web-process development only**. A separate worker cannot access that
  local-only connection.
- `docker-compose.yml` provides internal Redis, waits for its health check, and
  supplies its URL to both web and worker. It does not publish a Redis port.
- No new agent method, message shape, binary release or SQL migration is required
  for this routing change. The preceding session-security patch has its own
  migration/relogin requirements: see `SECURITY_REVIEW_2026-09-10.md`.

## Ownership and tenant boundaries

Redis hash `monofarm:tunnel:v1:org:<org_id>` holds the owner process ID, a fresh
connection ID, and the capabilities reported by the agent. Its lease is 15
seconds and renews every 4 seconds. `has_tunnel()` and capability checks see this
registry from any process, including synchronous service code.

A reconnect replaces ownership atomically. The old socket is closed when notified
or when its next renewal fails. Cleanup uses compare-and-delete so an old socket
cannot delete a new owner's lease. Requests retain their original connection ID;
upload chunks cannot migrate to a replacement connection.

Responses require the original request ID, authenticated organization, owner
process and connection ID. Agent telemetry is ingested by the socket owner; the
existing organization-scoped Redis caches remain the shared source of state.

## Delivery, uploads and cameras

- Each process subscribes to its own Pub/Sub channel. Commands are delivered to
  the owner, which serializes writes to its WebSocket. Replies, progress events
  and camera chunks return to the requesting process.
- Redis messages are fragmented into 256 Ki-character parts and acknowledged one
  part at a time. Large partial messages spool to temporary files, with cleanup
  on completion, timeout or transport shutdown. This avoids a single huge
  Pub/Sub message and limits extra memory during assembly. Existing agent
  upload-URL and upload-chunk capabilities remain available across processes.
- A short-lived, single-use Redis delivery permit is consumed before forwarding
  a remote command. Expired, cancelled or duplicated deliveries cannot reuse it.
  Redis client retries for `PUBLISH` are explicitly disabled.
- The final transport acknowledgment means the message was forwarded/accepted by
  the receiving handler. **It does not prove physical execution by the printer.**
  A disconnect or lost acknowledgment produces an error/uncertain outcome; the
  router never automatically retries that command. Existing persisted print-job
  reconciliation remains responsible for deciding what actually happened.
- Delivery has a 15-second bound, including waiting for the WebSocket send lock.
  Existing printer-response, upload-progress/stall and camera-idle timeouts remain
  in `tunnel.py`. A dead owner's lease also fails waiting requests after expiry
  and the next requester heartbeat.
- Camera queues contain at most 16 chunks. A slow consumer fails its stream
  instead of accumulating unbounded data. Closing/cancelling a request releases
  its remote route. The unchanged agent protocol has no per-stream cancellation
  command; this patch does not change the agent's underlying stream lifecycle.
- A lost owner/Redis connection interrupts streams and uploads; this is not
  resumable transfer or a durable command queue. Reconnect establishes a new
  connection identity.

## Related multi-process guards

AutoPrint's in-process locks alone are insufficient when multiple web processes
receive the same Pub/Sub event. Planning now locks the printer row with
`FOR UPDATE SKIP LOCKED` until a queued job is visible. Completed-run accounting
locks and refreshes persisted printer/plan counters so concurrent consumers count
one run once. These are short database transactions, not locks held during upload.

The scheduler's Redis lease renewal/release now use atomic comparisons and work
with the shared cache client's decoded string responses. This fixes the previous
`.decode()` failure when Redis was enabled.

## Verification (local, 2026-09-10)

- Full backend suite after the routing implementation: **442 passed**.
- Final focused Redis/AutoPrint suite: **24 passed**, including later transport
  cases and two-transaction Postgres concurrency tests.
- Redis tests launch a socket owner in a **separate OS process** and exercise
  `tunnel.proxy_request` from the caller process. Other cases cover same-org
  reconnect, abrupt owner death, cross-org/stale reply rejection, upload chunk
  order/progress, camera bytes/cancellation/backpressure, Telegram messages,
  lost acknowledgments, duplicate deliveries, Redis failure, idle lease renewal
  and requests starting during heartbeat processing.
- Backend Ruff and `git diff --check`: passed. Docker Compose configuration
  validation with `--no-env-resolution --quiet`: passed.
- Tests require an isolated `TEST_REDIS_URL`; CI supplies a private Redis service.
  Every Redis test uses its own random key prefix, without flushing the database.
- No production rollout, physical-printer commands or throughput/load benchmark
  was performed. Video and large uploads add Redis bandwidth; production capacity
  needs measurement for the intended number of simultaneous streams/transfers.
- Graphify refresh was unavailable: this checkout has neither the project
  `.venv-graphify/bin/graphify` nor a `graphify` executable on PATH.

Example test command from `backend/` (use local test-only service URLs):

```bash
TEST_DATABASE_URL=postgresql+psycopg://printfarm:printfarm@127.0.0.1:55432/printfarm_test \
TEST_REDIS_URL=redis://127.0.0.1:56379/0 \
.venv/bin/pytest tests/integration/test_tunnel_router.py tests/integration/test_autoprint_concurrency.py -q
```

Deploy all web and worker instances with this router together, then let agents
reconnect. A mix of old local-only processes and new routed processes is not a
supported configuration.
