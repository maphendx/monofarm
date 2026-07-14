"""Fail-closed network target validation for the local farm agent.

The cloud control plane must not turn the agent into a generic LAN proxy.
Printer HTTP requests are limited to hosts registered by typed printer setup
messages. Raw TCP features require an explicit local allowlist.
"""

from __future__ import annotations

import ipaddress
import os
from collections.abc import Collection
from urllib.parse import urlsplit


class NetworkPolicyError(ValueError):
    """Raised when a requested network target is outside the agent policy."""


def _normalize_host(host: str) -> str:
    return host.strip().strip("[]").rstrip(".").lower()


def _require_local_printer_host(host: str) -> str:
    normalized = _normalize_host(host)
    if not normalized or normalized == "localhost" or normalized.endswith(".localhost"):
        raise NetworkPolicyError("loopback host is forbidden")

    try:
        address = ipaddress.ip_address(normalized)
    except ValueError:
        # Local printer discovery uses mDNS or a single-label LAN hostname.
        # Public FQDNs are intentionally excluded even when supplied by cloud.
        if "." in normalized and not normalized.endswith(".local"):
            raise NetworkPolicyError("public hostname is forbidden")
        return normalized

    if (
        not address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_reserved
        or address.is_unspecified
    ):
        raise NetworkPolicyError("target must be a private printer address")
    return normalized


def _is_loopback_web_host(host: str | None) -> bool:
    if not host:
        return False
    normalized = _normalize_host(host)
    if normalized == "localhost":
        return True
    try:
        return ipaddress.ip_address(normalized).is_loopback
    except ValueError:
        return False


def require_loopback_web_request(
    *,
    client_host: str,
    host_header: str,
    origin_header: str | None,
    require_origin: bool = False,
) -> None:
    """Reject remote, DNS-rebound, and cross-site requests to the local UI."""

    if not _is_loopback_web_host(client_host):
        raise NetworkPolicyError("local UI client must be loopback")
    try:
        request_host = urlsplit(f"//{host_header}").hostname
    except ValueError as exc:
        raise NetworkPolicyError("invalid local UI Host header") from exc
    if not _is_loopback_web_host(request_host):
        raise NetworkPolicyError("local UI Host header must be loopback")
    if not origin_header:
        if require_origin:
            raise NetworkPolicyError("local UI POST requires an Origin header")
        return
    try:
        origin = urlsplit(origin_header)
        origin_port = origin.port
    except ValueError as exc:
        raise NetworkPolicyError("invalid local UI Origin header") from exc
    if (
        origin.scheme not in {"http", "https"}
        or not _is_loopback_web_host(origin.hostname)
        or origin.username is not None
        or origin.password is not None
        or origin_port is not None and not 1 <= origin_port <= 65535
    ):
        raise NetworkPolicyError("local UI Origin must be loopback")


def require_registered_http_url(url: str, registered_hosts: Collection[str]) -> str:
    """Validate an HTTP URL against the agent's registered printer hosts."""

    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise NetworkPolicyError("only HTTP printer URLs are allowed")
    if parsed.username is not None or parsed.password is not None:
        raise NetworkPolicyError("credentials in printer URL are forbidden")
    if parsed.fragment:
        raise NetworkPolicyError("URL fragments are forbidden")

    host = _require_local_printer_host(parsed.hostname)
    allowed = {_normalize_host(item) for item in registered_hosts if item}
    if host not in allowed:
        raise NetworkPolicyError(f"printer host {host} is not registered")
    try:
        parsed.port
    except ValueError as exc:
        raise NetworkPolicyError("invalid printer URL port") from exc
    return url


def require_public_https_url(url: str) -> str:
    """Allow cloud artifact downloads without exposing private network targets."""

    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise NetworkPolicyError("artifact URL must use HTTPS")
    if parsed.username is not None or parsed.password is not None or parsed.fragment:
        raise NetworkPolicyError("artifact URL credentials and fragments are forbidden")
    host = _normalize_host(parsed.hostname)
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        if "." not in host or host.endswith((".local", ".localhost")):
            raise NetworkPolicyError("artifact host must be public")
    else:
        if not address.is_global:
            raise NetworkPolicyError("artifact address must be public")
    try:
        parsed.port
    except ValueError as exc:
        raise NetworkPolicyError("invalid artifact URL port") from exc
    return url


def require_cloud_server_url(url: str) -> str:
    """Protect agent credentials from clear-text or ambiguous control servers."""

    parsed = urlsplit(url.strip())
    if not parsed.hostname or parsed.scheme not in {"http", "https"}:
        raise NetworkPolicyError("agent server must be an absolute HTTP(S) URL")
    if (
        parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        raise NetworkPolicyError("agent server URL must contain only scheme, host, and port")
    try:
        parsed.port
    except ValueError as exc:
        raise NetworkPolicyError("agent server URL has an invalid port") from exc
    if parsed.scheme == "http" and not _is_loopback_web_host(parsed.hostname):
        raise NetworkPolicyError("agent server requires HTTPS outside loopback development")
    return url.strip().rstrip("/")


def tls_verification_for_local_url(url: str, insecure_targets_env: str) -> bool:
    """Disable local HTTPS verification only for an exact operator allowlist."""

    parsed = urlsplit(url)
    if parsed.scheme != "https":
        return True
    if not parsed.hostname:
        raise NetworkPolicyError("HTTPS URL is missing a host")
    host = _normalize_host(parsed.hostname)
    explicit_targets = {
        _normalize_host(item)
        for item in os.environ.get(insecure_targets_env, "").split(",")
        if item.strip()
    }
    return host not in explicit_targets


def configured_tcp_targets(env_name: str, *, default_port: int) -> set[tuple[str, int]]:
    """Read an explicit comma-separated ``host[:port]`` target allowlist."""

    targets: set[tuple[str, int]] = set()
    for item in os.environ.get(env_name, "").split(","):
        item = item.strip()
        if not item:
            continue
        host_text, separator, port_text = item.rpartition(":")
        if separator and host_text and port_text.isdigit():
            host = host_text
            port = int(port_text)
        else:
            host = item
            port = default_port
        targets.add((_require_local_printer_host(host), port))
    return targets


def require_registered_tcp_target(
    host: str,
    port: int,
    registered_targets: Collection[tuple[str, int]],
    *,
    allowed_ports: Collection[int] = (9100,),
) -> tuple[str, int]:
    """Validate a raw TCP printer endpoint against an explicit allowlist."""

    normalized_host = _require_local_printer_host(host)
    if port not in allowed_ports or not 1 <= port <= 65535:
        raise NetworkPolicyError("TCP port is not allowed")
    allowed = {
        (_normalize_host(target_host), int(target_port))
        for target_host, target_port in registered_targets
    }
    target = (normalized_host, port)
    if target not in allowed:
        raise NetworkPolicyError(f"TCP target {normalized_host}:{port} is not registered")
    return target
