"""Symmetric encryption for sensitive DB fields (Bambu credentials, etc.).

Uses Fernet (AES-128-CBC + HMAC-SHA256). Key must be 32 url-safe base64 bytes —
generate once with: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

Graceful degradation:
- ENCRYPTION_KEY not set → encrypt() is a no-op, decrypt() returns value as-is.
- Encrypted value fed to decrypt() when key is set → decrypts normally.
- Plain-text value fed to decrypt() when key is set → returns as-is (backward compat
  for rows written before encryption was enabled).
- Empty string → always returned unchanged (preserves falsy checks for "not configured").
"""
from __future__ import annotations

import logging

log = logging.getLogger(__name__)


def _fernet():
    from app.core.config import settings
    if not settings.ENCRYPTION_KEY:
        return None
    from cryptography.fernet import Fernet
    return Fernet(settings.ENCRYPTION_KEY.encode())


def encrypt(plaintext: str) -> str:
    if not plaintext:
        return plaintext
    f = _fernet()
    if f is None:
        return plaintext
    return f.encrypt(plaintext.encode()).decode()


def decrypt(value: str) -> str:
    if not value:
        return value
    f = _fernet()
    if f is None:
        return value
    try:
        return f.decrypt(value.encode()).decode()
    except Exception:
        return value  # plain text (written before encryption was enabled)
