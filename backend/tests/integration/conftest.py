"""Fixtures for integration tests that hit the test Postgres database.

The database schema is created from SQLAlchemy models (Base.metadata.create_all)
once per test session, then each test runs inside a transaction that is rolled
back on teardown — so tests don't pollute each other.

External integrations (SimplyPrint / Bambu Cloud / Moonraker / Telegram) are
patched out at the fixture level so tests never touch the network.
"""
from __future__ import annotations

from typing import Iterator
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core import db as core_db
from app.core.db import Base
from app.core.security import create_access_token, hash_password
from app.main import app
from app.models import User, UserRole  # noqa: F401 — ensures all model modules register on Base
from app.models.organization import Organization


@pytest.fixture(scope="session")
def db_engine():
    engine = create_engine(core_db.settings.DATABASE_URL, pool_pre_ping=True)
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    yield engine
    Base.metadata.drop_all(engine)
    engine.dispose()


@pytest.fixture
def db_session(db_engine) -> Iterator[Session]:
    """Transactional session — every test rolls back so state stays clean."""
    connection = db_engine.connect()
    transaction = connection.begin()
    SessionTest = sessionmaker(bind=connection, autoflush=False, autocommit=False)
    session = SessionTest()
    try:
        yield session
    finally:
        session.close()
        transaction.rollback()
        connection.close()


@pytest.fixture
def test_org(db_session: Session) -> Organization:
    org = Organization(name="Test Farm", slug="test-farm")
    db_session.add(org)
    db_session.commit()
    db_session.refresh(org)
    return org


@pytest.fixture
def admin_user(db_session: Session, test_org: Organization) -> User:
    user = User(
        organization_id=test_org.id,
        email="admin@example.com",
        password_hash=hash_password("test-admin-pw"),
        name="Test Admin",
        role=UserRole.admin,
        is_active=True,
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


@pytest.fixture
def operator_user(db_session: Session, test_org: Organization) -> User:
    user = User(
        organization_id=test_org.id,
        email="op@example.com",
        password_hash=hash_password("test-op-pw"),
        name="Test Operator",
        role=UserRole.operator,
        is_active=True,
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


@pytest.fixture
def admin_token(admin_user: User, test_org: Organization) -> str:
    return create_access_token(subject=str(admin_user.id), role=admin_user.role.value, org_id=test_org.id)


@pytest.fixture
def auth_headers(admin_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture
def mock_external_services(monkeypatch) -> dict[str, MagicMock]:
    """Patch every outbound integration so tests stay offline."""
    from app.services import bambu, moonraker

    bambu_list = MagicMock(return_value=[])
    monkeypatch.setattr(bambu, "list_devices", bambu_list, raising=False)

    bambu_status = MagicMock(return_value={"state": "unknown"})
    monkeypatch.setattr(bambu, "get_live_status", bambu_status, raising=False)

    mr_status = MagicMock(return_value={"state": "offline"})
    monkeypatch.setattr(moonraker, "get_live_status", mr_status)

    mr_upload = MagicMock(return_value={"item": {"path": "test.gcode"}, "print_started": False})
    monkeypatch.setattr(moonraker, "upload_gcode", mr_upload)

    return {
        "bambu_list": bambu_list,
        "bambu_status": bambu_status,
        "moonraker_status": mr_status,
        "moonraker_upload": mr_upload,
    }


@pytest.fixture
def client(db_session: Session, mock_external_services) -> Iterator[TestClient]:
    """FastAPI TestClient with the get_db dependency wired to a per-test session.

    NOTE: do not use `with TestClient(...)` — that triggers the lifespan event,
    which starts the Telegram bot / APScheduler / Bambu MQTT. We want those
    skipped in tests.
    """
    def _get_db_override():
        yield db_session

    app.dependency_overrides[core_db.get_db] = _get_db_override
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
