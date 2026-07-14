import pytest

from app.core.agent_release_trust import (
    AGENT_RELEASE_PUBLIC_KEY,
    resolve_agent_release_public_key,
)


def test_committed_release_key_is_the_default_trust_root() -> None:
    assert resolve_agent_release_public_key("") == AGENT_RELEASE_PUBLIC_KEY


def test_mismatched_environment_key_fails_closed() -> None:
    with pytest.raises(ValueError, match="does not match committed"):
        resolve_agent_release_public_key("A" * 43 + "=")
