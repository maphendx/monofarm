"""Pinned public trust root for immutable Monofarm Agent releases."""

AGENT_RELEASE_PUBLIC_KEY = "2Doaw17ATYHVEEIT9VAVb2Y3HInyNM8sesvLU9Uz33M="


def resolve_agent_release_public_key(configured: str) -> str:
    """Return the pinned key and reject configuration drift."""

    candidate = configured.strip()
    if candidate and candidate != AGENT_RELEASE_PUBLIC_KEY:
        raise ValueError("configured agent release key does not match committed trust root")
    return AGENT_RELEASE_PUBLIC_KEY
