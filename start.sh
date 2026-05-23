#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

# ── DB ──────────────────────────────────────────────────────────────────────
echo "▶ Starting DB..."
docker compose up -d db
# Wait until postgres is ready
until docker exec printfarm-db pg_isready -U printfarm -q; do sleep 1; done

# ── Migrations ───────────────────────────────────────────────────────────────
echo "▶ Running migrations..."
cd "$ROOT/backend"
.venv/bin/alembic upgrade head

# ── Kill old processes ───────────────────────────────────────────────────────
echo "▶ Clearing ports 8000 and 3000..."
lsof -ti :8000 | xargs kill -9 2>/dev/null || true
lsof -ti :3000 | xargs kill -9 2>/dev/null || true
sleep 1

# ── Backend ──────────────────────────────────────────────────────────────────
echo "▶ Starting backend on 0.0.0.0:8000..."
cd "$ROOT/backend"
nohup .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload \
  > /tmp/monofarm-backend.log 2>&1 &
echo "  PID $! — logs: /tmp/monofarm-backend.log"

# ── Frontend ─────────────────────────────────────────────────────────────────
echo "▶ Starting frontend on 0.0.0.0:3000..."
cd "$ROOT/frontend"
nohup bun run dev -- --hostname 0.0.0.0 \
  > /tmp/monofarm-frontend.log 2>&1 &
echo "  PID $! — logs: /tmp/monofarm-frontend.log"

# ── Wait for readiness ───────────────────────────────────────────────────────
echo -n "  Waiting for backend..."
until curl -sf http://localhost:8000/docs > /dev/null 2>&1; do sleep 1; echo -n "."; done
echo " ready"

echo ""
TAILSCALE_IP=$(tailscale ip -4 2>/dev/null || echo "0.0.0.0")

echo "✓ All services up"
echo "  Frontend : http://${TAILSCALE_IP}:3000"
echo "  Backend  : http://${TAILSCALE_IP}:8000"
echo "  Logs     : /tmp/monofarm-backend.log  /tmp/monofarm-frontend.log"
