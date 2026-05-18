"""File storage: local disk or S3-compatible (Cloudflare R2 / AWS S3).

When S3_BUCKET is set → S3 backend, key pattern: orgs/{org_id}/gcodes/{stored_name}.
Otherwise → local disk at data/gcodes/{stored_name} (same as legacy behaviour).

All functions are sync; call from async via asyncio.to_thread where needed.
"""
from __future__ import annotations

import logging
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Generator

log = logging.getLogger(__name__)

LOCAL_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "gcodes"
LOCAL_DIR.mkdir(parents=True, exist_ok=True)


def is_s3() -> bool:
    from app.core.config import settings
    return bool(settings.S3_BUCKET)


def _s3_key(stored_name: str, org_id: int) -> str:
    return f"orgs/{org_id}/gcodes/{stored_name}"


def _client():
    from app.core.config import settings
    import boto3
    from botocore.config import Config
    return boto3.client(
        "s3",
        endpoint_url=settings.S3_ENDPOINT_URL or None,
        aws_access_key_id=settings.S3_ACCESS_KEY,
        aws_secret_access_key=settings.S3_SECRET_KEY,
        config=Config(signature_version="s3v4"),
    )


def put(stored_name: str, data: bytes, org_id: int) -> None:
    if is_s3():
        from app.core.config import settings
        _client().put_object(
            Bucket=settings.S3_BUCKET,
            Key=_s3_key(stored_name, org_id),
            Body=data,
        )
    else:
        (LOCAL_DIR / stored_name).write_bytes(data)


def exists(stored_name: str, org_id: int) -> bool:
    if is_s3():
        from app.core.config import settings
        try:
            _client().head_object(Bucket=settings.S3_BUCKET, Key=_s3_key(stored_name, org_id))
            return True
        except Exception:
            return False
    return (LOCAL_DIR / stored_name).exists()


def get_bytes(stored_name: str, org_id: int) -> bytes:
    if is_s3():
        from app.core.config import settings
        obj = _client().get_object(
            Bucket=settings.S3_BUCKET,
            Key=_s3_key(stored_name, org_id),
        )
        return obj["Body"].read()
    path = LOCAL_DIR / stored_name
    if not path.exists():
        raise FileNotFoundError(stored_name)
    return path.read_bytes()


def delete(stored_name: str, org_id: int) -> None:
    if is_s3():
        from app.core.config import settings
        _client().delete_object(
            Bucket=settings.S3_BUCKET,
            Key=_s3_key(stored_name, org_id),
        )
    else:
        (LOCAL_DIR / stored_name).unlink(missing_ok=True)


def presigned_url(stored_name: str, org_id: int, expires: int = 3600) -> str | None:
    """Return a presigned download URL (S3 only). Returns None for local backend."""
    if not is_s3():
        return None
    from app.core.config import settings
    return _client().generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.S3_BUCKET, "Key": _s3_key(stored_name, org_id)},
        ExpiresIn=expires,
    )


@contextmanager
def local_path_for(stored_name: str, org_id: int) -> Generator[Path, None, None]:
    """Yield a local Path to the file.

    Local backend: yields the stored path directly (no copy, no cleanup).
    S3 backend: downloads to a temp file, yields that path, then cleans up.
    """
    if not is_s3():
        path = LOCAL_DIR / stored_name
        if not path.exists():
            raise FileNotFoundError(stored_name)
        yield path
        return

    suffix = "".join(Path(stored_name).suffixes) or Path(stored_name).suffix
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(get_bytes(stored_name, org_id))
        tmp_path = Path(tmp.name)
    try:
        yield tmp_path
    finally:
        tmp_path.unlink(missing_ok=True)
