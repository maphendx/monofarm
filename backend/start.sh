#!/bin/sh
set -e
echo "=== PORT=${PORT} ENV=${ENV} APP_MODE=${APP_MODE} ==="
if [ "$APP_MODE" = "worker" ]; then
    echo "=== starting worker ==="
    python -c "
import http.server, os
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type','application/json')
        self.end_headers()
        self.wfile.write(b'{\"ok\":true}')
    def log_message(self, *a): pass
http.server.HTTPServer(('', int(os.environ.get('PORT', 8000))), H).serve_forever()
" &
    exec python -m app.workers.main
else
    echo "=== checking python import ==="
    python -c "from app.main import app; print('import OK')" || { echo "IMPORT FAILED"; exit 1; }
    echo "=== running migrations ==="
    alembic upgrade head
    echo "=== migrations done, starting uvicorn on ${PORT:-8000} ==="
    exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}"
fi
