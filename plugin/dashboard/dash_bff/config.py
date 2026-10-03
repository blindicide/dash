"""Server-side configuration and Hermes connection resolution.

Nothing here is ever derived from browser input: the Hermes API base URL and credential come
from the Dashboard process environment / the scoped Hermes profile config only. The browser
can choose *which validated profile name* to address, never a URL, host, path or file.
"""

from __future__ import annotations

import ipaddress
import os
import threading
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlsplit

from . import compat

_TRUE = {"1", "true", "yes", "on"}


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in _TRUE


def _env_int(name: str, default: int, *, minimum: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, "").strip() or default)
    except ValueError:
        return default
    return max(minimum, min(maximum, value))


@dataclass(frozen=True)
class Settings:
    api_url_override: Optional[str]
    allow_remote_http: bool
    http_timeout: float
    uploads_enabled: bool
    upload_max_bytes: int
    upload_ttl_hours: int
    image_max_bytes: int
    image_max_count: int


def load_settings() -> Settings:
    return Settings(
        api_url_override=(os.environ.get("DASH_HERMES_API_URL") or "").strip() or None,
        allow_remote_http=_env_bool("DASH_ALLOW_REMOTE_HTTP"),
        http_timeout=float(_env_int("DASH_HTTP_TIMEOUT", 30, minimum=5, maximum=300)),
        uploads_enabled=_env_bool("DASH_UPLOADS_ENABLED"),
        upload_max_bytes=_env_int("DASH_UPLOAD_MAX_BYTES", 10 * 1024 * 1024, minimum=1024, maximum=50 * 1024 * 1024),
        upload_ttl_hours=_env_int("DASH_UPLOAD_TTL_HOURS", 24, minimum=1, maximum=24 * 30),
        image_max_bytes=_env_int("DASH_IMAGE_MAX_BYTES", 5 * 1024 * 1024, minimum=1024, maximum=7_000_000),
        image_max_count=_env_int("DASH_IMAGE_MAX_COUNT", 4, minimum=1, maximum=8),
    )


class ConfigError(Exception):
    """The Hermes connection is misconfigured (message is safe to show)."""


def _is_loopback(host: str) -> bool:
    if host in {"localhost", "localhost.localdomain"}:
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


def validate_base_url(url: str, *, allow_remote_http: bool) -> str:
    """Normalise an operator-supplied API base URL; reject anything ambiguous."""
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"}:
        raise ConfigError("DASH_HERMES_API_URL must use http or https")
    if not parts.hostname:
        raise ConfigError("DASH_HERMES_API_URL must include a host")
    if parts.username or parts.password:
        raise ConfigError("DASH_HERMES_API_URL must not embed credentials")
    if parts.query or parts.fragment:
        raise ConfigError("DASH_HERMES_API_URL must not contain a query or fragment")
    if parts.scheme == "http" and not _is_loopback(parts.hostname) and not allow_remote_http:
        raise ConfigError(
            "Refusing plain-http Hermes API on a non-loopback host; use https or set DASH_ALLOW_REMOTE_HTTP=1"
        )
    path = parts.path.rstrip("/")
    netloc = parts.netloc
    return f"{parts.scheme}://{netloc}{path}"


def _host_for_connect(host: str) -> str:
    # A wildcard bind is reachable on loopback from the same machine.
    if host in {"0.0.0.0", "::", ""}:  # noqa: S104 - recognising a wildcard bind, not binding
        return "127.0.0.1"
    if ":" in host and not host.startswith("["):
        return f"[{host}]"
    return host


@dataclass(frozen=True)
class HermesTarget:
    """Where and how to reach the Hermes API server for one profile (never sent to browsers)."""

    profile: str
    base_url: str  # includes the /p/<profile> prefix when routed through a multiplexed listener
    api_key: str
    routing: str  # "direct" | "multiplex"

    def describe(self) -> dict:
        return {"profile": self.profile, "routing": self.routing, "auth_configured": bool(self.api_key)}


_launch_address_lock = threading.Lock()
_launch_address: Optional[str] = None


def _own_address() -> str:
    host, port, _multiplex = compat.api_server_settings()
    return f"http://{_host_for_connect(host)}:{port}"


def resolve_target(profile: str, *, is_launch_profile: bool, settings: Optional[Settings] = None) -> HermesTarget:
    """Resolve the API server target for ``profile`` inside the Dashboard's profile scope.

    The Dashboard enters the requested profile's home + secret scope before the route runs, so
    ``compat`` reads that profile's ``API_SERVER_KEY`` and listen address. A named profile whose
    address equals the launch profile's (or that has no API server of its own) is addressed via
    the documented multiplex prefix ``/p/<profile>/`` with its own key.
    """
    global _launch_address
    settings = settings or load_settings()
    api_key = compat.get_secret("API_SERVER_KEY")
    if settings.api_url_override:
        base = validate_base_url(settings.api_url_override, allow_remote_http=settings.allow_remote_http)
        if is_launch_profile:
            return HermesTarget(profile, base, api_key, "direct")
        return HermesTarget(profile, f"{base}/p/{profile}", api_key, "multiplex")
    own = _own_address()
    if is_launch_profile:
        with _launch_address_lock:
            _launch_address = own
        return HermesTarget(profile, own, api_key, "direct")
    with _launch_address_lock:
        launch = _launch_address
    default_address = f"http://127.0.0.1:{compat.DEFAULT_API_PORT}"
    if own == launch or (launch is None and own == default_address):
        return HermesTarget(profile, f"{own}/p/{profile}", api_key, "multiplex")
    return HermesTarget(profile, own, api_key, "direct")
