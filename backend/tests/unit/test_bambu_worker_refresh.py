import asyncio
from types import SimpleNamespace

from app.services import bambu
from app.workers import main as worker


class _Query:
    def all(self):
        return [SimpleNamespace(id=7)]


class _Db:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def query(self, _model):
        return _Query()


def test_subscription_refresh_requests_full_status_for_existing_devices(monkeypatch):
    bambu._dev_to_org.clear()
    bambu._dev_to_org["EXISTING"] = 7
    subscribed: list[tuple[str, int]] = []
    refreshed: list[str] = []

    monkeypatch.setattr("app.core.db.SessionLocal", lambda: _Db())
    monkeypatch.setattr(
        bambu,
        "list_devices",
        lambda _org_id: [{"dev_id": "EXISTING"}, {"dev_id": "NEW"}],
    )
    monkeypatch.setattr(
        bambu,
        "subscribe_device",
        lambda dev_id, org_id: subscribed.append((dev_id, org_id)),
    )
    monkeypatch.setattr(
        bambu,
        "request_full_status",
        lambda dev_id: refreshed.append(dev_id),
        raising=False,
    )

    asyncio.run(worker._refresh_bambu_subscriptions())

    assert subscribed == [("NEW", 7)]
    assert refreshed == ["EXISTING"]
