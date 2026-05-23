#!/bin/sh
set -e
echo "=== PORT=${PORT} ENV=${ENV} ==="
alembic upgrade head
echo "=== starting uvicorn on ${PORT:-8000} ==="
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --log-level debug
