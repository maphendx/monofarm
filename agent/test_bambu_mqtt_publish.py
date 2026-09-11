from unittest.mock import patch

from printers import bambu


class _PublishInfo:
    rc = 0

    def wait_for_publish(self, timeout=None):
        raise AssertionError("persistent MQTT publish must not block for QoS ACK")


class _LiveClient:
    def is_connected(self):
        return True

    def publish(self, *_args, **_kwargs):
        return _PublishInfo()


def test_live_bambu_publish_acknowledges_after_command_is_queued():
    with patch.dict(bambu._bambu_lan_live_clients, {"A9": _LiveClient()}):
        assert bambu._bambu_publish_via_live_client("A9", {"print": {"command": "skip_objects"}}) is True
