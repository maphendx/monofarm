from slowapi import Limiter
from starlette.requests import Request

from app.core.config import settings


def _real_ip(request: Request) -> str:
    """First hop of X-Forwarded-For (Railway/Cloudflare proxy), fallback to client host."""
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


limiter = Limiter(
    key_func=_real_ip,
    storage_uri=settings.REDIS_URL or None,
)
