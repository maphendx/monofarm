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
