"""Dedicated Monofarm Agent device identity and short-lived access tokens."""

from __future__ import annotations

import base64
import asyncio
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


@dataclass(frozen=True, slots=True)
class DeviceCredentials:
    device_id: str
    device_secret: str

    @classmethod
    def from_mapping(cls, values: Mapping[str, str]) -> DeviceCredentials | None:
        device_id = (values.get("MONOFARM_DEVICE_ID") or "").strip()
        device_secret = (values.get("MONOFARM_DEVICE_SECRET") or "").strip()
        if not device_id or not device_secret:
            return None
        return cls(device_id=device_id, device_secret=device_secret)


@dataclass(frozen=True, slots=True)
class DevicePairingResult:
    credentials: DeviceCredentials
    private_key: str
    access_token: str
    expires_in: int


async def pair_device(
    client,
    *,
    server: str,
    pairing_code: str,
    name: str,
    capabilities: Sequence[str],
) -> DevicePairingResult:
    """Exchange a single-use code while keeping the Ed25519 private key local."""

    del name  # The admin names the device when creating the pairing code.
    private = Ed25519PrivateKey.generate()
    private_raw = private.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_raw = private.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    response = await client.post(
        f"{server.rstrip('/')}/api/agent/v2/pair",
        json={
            "pairing_code": pairing_code.strip(),
            "public_key": base64.b64encode(public_raw).decode("ascii"),
            "capabilities": list(dict.fromkeys(str(item) for item in capabilities)),
        },
    )
    response.raise_for_status()
    payload = response.json()
    device_id = payload.get("device_id")
    device_secret = payload.get("device_secret")
    access_token = payload.get("access_token")
    expires_in = payload.get("expires_in")
    if (
        not isinstance(device_id, str)
        or not device_id
        or not isinstance(device_secret, str)
        or not device_secret
        or not isinstance(access_token, str)
        or not access_token
        or not isinstance(expires_in, int)
        or expires_in <= 0
    ):
        raise ValueError("agent pairing response is invalid")
    return DevicePairingResult(
        credentials=DeviceCredentials(device_id, device_secret),
        private_key=base64.b64encode(private_raw).decode("ascii"),
        access_token=access_token,
        expires_in=expires_in,
    )


class DeviceTokenProvider:
    """Mint and cache a scoped device token, refreshing before its deadline."""

    _REFRESH_SKEW_SECONDS = 30

    def __init__(self, server: str, credentials: DeviceCredentials, *, clock=time.monotonic) -> None:
        self.server = server.rstrip("/")
        self.credentials = credentials
        self._clock = clock
        self._access_token = ""
        self._refresh_at = 0.0
        self._lock = asyncio.Lock()

    async def get(self, client, *, force_refresh: bool = False) -> str:
        now = self._clock()
        if not force_refresh and self._access_token and now < self._refresh_at:
            return self._access_token
        async with self._lock:
            now = self._clock()
            if not force_refresh and self._access_token and now < self._refresh_at:
                return self._access_token
            response = await client.post(
                f"{self.server}/api/agent/v2/token",
                json={
                    "device_id": self.credentials.device_id,
                    "device_secret": self.credentials.device_secret,
                },
            )
            response.raise_for_status()
            payload = response.json()
            token = payload.get("access_token")
            expires_in = payload.get("expires_in")
            if (
                not isinstance(token, str)
                or not token
                or not isinstance(expires_in, int)
                or expires_in <= self._REFRESH_SKEW_SECONDS
            ):
                raise ValueError("agent token response is invalid")
            self._access_token = token
            self._refresh_at = now + expires_in - self._REFRESH_SKEW_SECONDS
            return token
