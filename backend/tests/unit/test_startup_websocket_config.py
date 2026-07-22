from pathlib import Path


def test_production_websocket_ping_timeout_matches_agent_tolerance():
    start_script = Path(__file__).resolve().parents[2] / "start.sh"

    contents = start_script.read_text()

    assert '--ws-ping-timeout "${WS_PING_TIMEOUT:-120}"' in contents
