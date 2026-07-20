import asyncio

from app.api import ws


def test_broadcast_printer_snapshot_invalidates_cache_and_pushes(monkeypatch):
    sent: list[tuple[int, dict]] = []

    async def fake_snapshot(org_id: int):
        assert org_id == 17
        return [{"id": 8, "loaded_filaments": []}], "fresh-hash"

    async def fake_broadcast(org_id: int, message: dict):
        sent.append((org_id, message))

    ws._snapshot_cache[17] = (0.0, "stale-hash", [{"id": 8}])
    monkeypatch.setattr(ws, "_build_and_cache_snapshot", fake_snapshot)
    monkeypatch.setattr(ws.manager, "broadcast", fake_broadcast)

    asyncio.run(ws.broadcast_printer_snapshot(17))

    assert 17 not in ws._snapshot_cache
    assert sent == [(17, {"type": "printers", "data": [{"id": 8, "loaded_filaments": []}]})]
