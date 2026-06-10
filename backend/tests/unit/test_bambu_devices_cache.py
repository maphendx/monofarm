"""list_devices caching — every printer listing used to hit Bambu Cloud directly."""
from __future__ import annotations

from app.services import bambu, bambu_provider, cache


def test_list_devices_caches_per_org_and_force_bypasses(monkeypatch):
    store: dict = {}
    monkeypatch.setattr(cache, "cache_get", lambda key: store.get(key))
    monkeypatch.setattr(cache, "cache_set", lambda key, value, ttl=None: store.__setitem__(key, value))

    calls = {"n": 0}

    def fake_bind(base, headers):
        calls["n"] += 1
        return {"devices": [{"dev_id": "D1", "name": "P1S", "online": True}]}

    monkeypatch.setattr(bambu_provider, "get_user_bind", fake_bind)
    monkeypatch.setitem(bambu._access_tokens, 990, "tok")

    first = bambu.list_devices(990)
    second = bambu.list_devices(990)

    assert calls["n"] == 1
    assert first == second
    assert first[0]["dev_id"] == "D1"

    bambu.list_devices(990, force=True)
    assert calls["n"] == 2


def test_list_devices_does_not_cache_cloud_failures(monkeypatch):
    import requests

    store: dict = {}
    monkeypatch.setattr(cache, "cache_get", lambda key: store.get(key))
    monkeypatch.setattr(cache, "cache_set", lambda key, value, ttl=None: store.__setitem__(key, value))

    def failing_bind(base, headers):
        raise requests.ConnectionError("cloud down")

    monkeypatch.setattr(bambu_provider, "get_user_bind", failing_bind)
    monkeypatch.setitem(bambu._access_tokens, 991, "tok")

    assert bambu.list_devices(991) == []
    assert store == {}
