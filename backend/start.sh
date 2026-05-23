#!/bin/sh
set -e
echo "=== PORT=${PORT} ENV=${ENV} APP_MODE=${APP_MODE} ==="
if [ "$APP_MODE" = "worker" ]; then
    echo "=== starting worker ==="
    exec python -m app.workers.main
else
    alembic upgrade head
    echo "=== starting uvicorn on ${PORT:-8000} ==="
    exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}"
fi
