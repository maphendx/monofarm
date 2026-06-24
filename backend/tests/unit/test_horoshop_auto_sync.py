from __future__ import annotations

from types import SimpleNamespace

from app.workers import horoshop_sync


class FakeQuery:
    def __init__(self, rows):
        self.rows = rows

    def filter(self, *_args):
        return self

    def all(self):
        return self.rows


class FakeSession:
    def __init__(self, orgs):
        self.orgs = orgs
        self.added = []
        self.commits = 0
        self.rollbacks = 0

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def query(self, _model):
        return FakeQuery([(org.id,) for org in self.orgs])

    def get(self, _model, org_id):
        return next((org for org in self.orgs if org.id == org_id), None)

    def add(self, row):
        self.added.append(row)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


def test_process_auto_horoshop_sync_polls_configured_orgs(monkeypatch):
    org = SimpleNamespace(id=10, horoshop_domain="shop.example", horoshop_login="api", horoshop_password="secret")
    sessions: list[FakeSession] = []

    def session_factory():
        session = FakeSession([org])
        sessions.append(session)
        return session

    monkeypatch.setattr(horoshop_sync.horoshop, "configured", lambda _org: True)
    monkeypatch.setattr(
        horoshop_sync.horoshop,
        "sync_recent",
        lambda _org, _db: {"seen": 2, "created": 1, "updated": 1, "unmatched": 0},
    )

    result = horoshop_sync.process_auto_horoshop_sync(session_factory=session_factory)

    assert result == {
        "checked": 1,
        "synced": 1,
        "errors": 0,
        "seen": 2,
        "created": 1,
        "updated": 1,
        "unmatched": 0,
    }


def test_process_auto_horoshop_sync_records_errors(monkeypatch):
    org = SimpleNamespace(id=20, horoshop_domain="shop.example", horoshop_login="api", horoshop_password="secret")
    sessions: list[FakeSession] = []

    def session_factory():
        session = FakeSession([org])
        sessions.append(session)
        return session

    def fail(_org, _db):
        raise RuntimeError("api down")

    monkeypatch.setattr(horoshop_sync.horoshop, "configured", lambda _org: True)
    monkeypatch.setattr(horoshop_sync.horoshop, "sync_recent", fail)

    result = horoshop_sync.process_auto_horoshop_sync(session_factory=session_factory)

    assert result["checked"] == 1
    assert result["synced"] == 0
    assert result["errors"] == 1
    assert sessions[-1].rollbacks == 1
    assert sessions[-1].commits == 1
    assert sessions[-1].added[0].event_type == "auto_sync"
    assert sessions[-1].added[0].status == "error"
