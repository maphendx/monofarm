"""Pytest config. Sets env vars BEFORE app modules are imported so settings pick up
the test database URL instead of the developer's real .env.
"""
import os

os.environ["DATABASE_URL"] = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql+psycopg://printfarm:printfarm@localhost:5432/printfarm_test",
)
os.environ["SECRET_KEY"] = "test-secret-key-do-not-use-in-production"
os.environ["ADMIN_EMAIL"] = "admin@example.com"
os.environ["ADMIN_PASSWORD"] = "test-admin-pw"
os.environ.setdefault("SIMPLYPRINT_API_KEY", "")
os.environ.setdefault("SIMPLYPRINT_ORG_ID", "")
os.environ.setdefault("BAMBU_EMAIL", "")
os.environ.setdefault("BAMBU_PASSWORD", "")
os.environ.setdefault("BAMBU_REFRESH_TOKEN", "")
os.environ.setdefault("TG_BOT_TOKEN", "")


# Last-resort isolation: accidental unmocked printer/Telegram I/O must never
# leave the machine. Local PostgreSQL/Redis and test WebSocket servers remain
# available; individual tests mock the external service boundary as usual.
import ipaddress  # noqa: E402
import socket  # noqa: E402

import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def block_external_sockets(monkeypatch):
    original_connect = socket.socket.connect
    original_connect_ex = socket.socket.connect_ex

    def check(sock, address):
        if sock.family not in (socket.AF_INET, socket.AF_INET6):
            return
        host = address[0]
        if host == "localhost":
            return
        try:
            allowed = ipaddress.ip_address(host).is_loopback
        except ValueError:
            allowed = False
        if not allowed:
            raise AssertionError(f"Unmocked external connection blocked in test: {host}")

    def connect(sock, address):
        check(sock, address)
        return original_connect(sock, address)

    def connect_ex(sock, address):
        check(sock, address)
        return original_connect_ex(sock, address)

    monkeypatch.setattr(socket.socket, "connect", connect)
    monkeypatch.setattr(socket.socket, "connect_ex", connect_ex)
