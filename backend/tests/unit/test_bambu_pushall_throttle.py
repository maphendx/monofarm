from __future__ import annotations

from app.services import bambu


class _FakeClient:
    def __init__(self):
        self.published: list[tuple[str, str, int]] = []

    def publish(self, topic, payload, qos=0):
        self.published.append((topic, payload, qos))

    def subscribe(self, topic):
        pass


def _reset_throttle_state():
    bambu._last_pushall.clear()
    bambu._subscriptions.clear()


def test_maybe_pushall_throttles_repeated_calls(monkeypatch):
    _reset_throttle_state()
    published: list[str] = []
    monkeypatch.setattr(bambu, "_publish", lambda dev_id, payload, qos=0, *, org_id: published.append(dev_id))

    fake_time = [1000.0]
    monkeypatch.setattr(bambu.time, "monotonic", lambda: fake_time[0])

    bambu._maybe_pushall("DEV-1", org_id=42)
    fake_time[0] += 10  # well within BAMBU_FULL_REFRESH_INTERVAL_SECONDS
    bambu._maybe_pushall("DEV-1", org_id=42)

    assert published == ["DEV-1"]


def test_maybe_pushall_force_bypasses_throttle(monkeypatch):
    _reset_throttle_state()
    published: list[str] = []
    monkeypatch.setattr(bambu, "_publish", lambda dev_id, payload, qos=0, *, org_id: published.append(dev_id))

    fake_time = [2000.0]
    monkeypatch.setattr(bambu.time, "monotonic", lambda: fake_time[0])

    bambu._maybe_pushall("DEV-1", org_id=42)
    fake_time[0] += 5
    bambu._maybe_pushall("DEV-1", force=True, org_id=42)

    assert published == ["DEV-1", "DEV-1"]


def test_maybe_pushall_fires_again_after_interval_elapses(monkeypatch):
    _reset_throttle_state()
    published: list[str] = []
    monkeypatch.setattr(bambu, "_publish", lambda dev_id, payload, qos=0, *, org_id: published.append(dev_id))

    fake_time = [3000.0]
    monkeypatch.setattr(bambu.time, "monotonic", lambda: fake_time[0])

    bambu._maybe_pushall("DEV-1", org_id=42)
    fake_time[0] += bambu.BAMBU_FULL_REFRESH_INTERVAL_SECONDS + 1
    bambu._maybe_pushall("DEV-1", org_id=42)

    assert published == ["DEV-1", "DEV-1"]


def test_reconnect_storm_only_pushalls_once_per_device(monkeypatch):
    """A flapping MQTT connection re-fires on_connect repeatedly; each firing
    used to pushall every device unconditionally. Two on_connect calls close
    together for the same org must now only pushall once per device."""
    _reset_throttle_state()
    bambu._subscriptions.add((42, "DEV-1"))

    fake_time = [4000.0]
    monkeypatch.setattr(bambu.time, "monotonic", lambda: fake_time[0])

    client = _FakeClient()
    on_connect = bambu._make_on_connect(42)

    on_connect(client, None, None, 0)
    fake_time[0] += 2  # reconnect 2s later — well under the throttle window
    on_connect(client, None, None, 0)

    pushall_publishes = [p for p in client.published if "pushall" in p[1]]
    assert len(pushall_publishes) == 1
