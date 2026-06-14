from __future__ import annotations

from app.models.organization import Organization
from app.services import telegram_notify


class _OrgQuery:
    def __init__(self, chat_ids: list[int]) -> None:
        self._chat_ids = chat_ids

    def filter(self, *args, **kwargs):
        return self

    def all(self):
        return [(chat_id,) for chat_id in self._chat_ids]


class _FakeDb:
    def __init__(self, org: Organization, chat_ids: list[int]) -> None:
        self._org = org
        self._chat_ids = chat_ids

    def get(self, model, pk):
        return self._org if model is Organization and pk == self._org.id else None

    def query(self, *args, **kwargs):
        return _OrgQuery(self._chat_ids)


def test_send_org_notification_targets_only_linked_active_users(monkeypatch):
    org = Organization(id=1, name="Org", slug="org", tg_bot_token="encrypted")
    db = _FakeDb(org, [111])

    monkeypatch.setattr(telegram_notify, "decrypt", lambda _token: "bot-token")
    calls: list[dict] = []

    class _Resp:
        def raise_for_status(self) -> None:
            return None

    def _post(url, json=None, timeout=None):
        calls.append({"url": url, "json": json, "timeout": timeout})
        return _Resp()

    monkeypatch.setattr(telegram_notify.requests, "post", _post)

    sent = telegram_notify.send_org_notification(db, org.id, "Hello")

    assert sent == 1
    assert calls == [
        {
            "url": "https://api.telegram.org/botbot-token/sendMessage",
            "json": {"chat_id": 111, "text": "Hello", "disable_web_page_preview": True},
            "timeout": 10,
        }
    ]


def test_send_print_event_notification_dedupes_and_formats_message(monkeypatch):
    org = Organization(id=1, name="Org", slug="org", tg_bot_token="encrypted")
    db = _FakeDb(org, [111])

    monkeypatch.setattr(telegram_notify, "decrypt", lambda _token: "bot-token")
    captured: list[tuple] = []

    def _send_org_notification(*args, **kwargs):
        captured.append((args, kwargs))
        return 1

    monkeypatch.setattr(telegram_notify, "send_org_notification", _send_org_notification)
    import app.services.cache as cache_mod
    seen: dict[str, object] = {}
    monkeypatch.setattr(cache_mod, "cache_get", lambda key: seen.get(key))
    monkeypatch.setattr(cache_mod, "cache_set", lambda key, value, ttl: seen.__setitem__(key, value))

    sent1 = telegram_notify.send_print_event_notification(
        db,
        org.id,
        event="failed",
        printer_name="A3",
        file_name="benchy.3mf",
        reason="SD card error",
        dedupe_key="job-1:failed",
    )
    sent2 = telegram_notify.send_print_event_notification(
        db,
        org.id,
        event="failed",
        printer_name="A3",
        file_name="benchy.3mf",
        reason="SD card error",
        dedupe_key="job-1:failed",
    )

    assert sent1 == 1
    assert sent2 == 0
    assert len(seen) == 1
    assert len(captured) == 1
