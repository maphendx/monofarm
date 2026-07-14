import asyncio

from app.services import moonraker, tunnel


def test_status_push_cache_is_scoped_by_organization() -> None:
    url = "http://192.168.1.100"
    moonraker._status_cache.clear()

    asyncio.run(
        tunnel.handle_agent_message(
            {
                "type": "STATUS_PUSH",
                "url": url,
                "status": {"print_stats": {"state": "printing", "filename": "one.gcode"}},
            },
            org_id=1,
        )
    )
    asyncio.run(
        tunnel.handle_agent_message(
            {
                "type": "STATUS_PUSH",
                "url": url,
                "status": {"print_stats": {"state": "standby", "filename": "two.gcode"}},
            },
            org_id=2,
        )
    )

    org_one = moonraker._status_cache[tunnel._moonraker_cache_key(1, url)][1]
    org_two = moonraker._status_cache[tunnel._moonraker_cache_key(2, url)][1]
    assert org_one["state"] == "printing"
    assert org_two["state"] != "printing"


def test_same_lan_url_has_distinct_redis_keys_per_organization() -> None:
    url = "http://192.168.1.100"
    assert tunnel._moonraker_redis_key(1, "status", url) != tunnel._moonraker_redis_key(
        2, "status", url
    )
