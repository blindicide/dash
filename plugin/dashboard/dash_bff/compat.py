"""Version-isolation layer for the few Hermes in-process surfaces dash touches.

Every import of Hermes code lives here, behind a narrow function with a safe fallback, so a
Hermes version that renames or lacks a helper degrades one capability instead of breaking the
plugin import (which would 404 every dash route). What each helper resolved to is reported by
``describe()`` and surfaced read-only in ``GET /capabilities``.

Surfaces used (all verified against Hermes v0.21.5 source; see docs/compatibility.md):

* ``agent.secret_scope.get_secret`` — profile-scoped credential read. The Dashboard wraps each
  ``/api/plugins/<name>/`` request in ``_plugin_route_secret_scope(profile)``, so this returns
  the *requested* profile's ``API_SERVER_KEY`` without dash ever touching ``.env`` files.
* ``plugins.plugin_storage.plugin_data_dir`` — the sanctioned per-plugin data directory.
* ``hermes_cli.profiles.list_profiles`` — profile names (read only).
* ``gateway.config.load_gateway_config`` — the API server listen address of the scoped profile.
* ``hermes_cli.__version__`` — informational version string.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

_log = logging.getLogger("dash.compat")

DEFAULT_API_HOST = "127.0.0.1"
DEFAULT_API_PORT = 8642

# Resolution notes, keyed by surface, for diagnostics (never contains secret values).
_resolved: dict[str, str] = {}


def _note(surface: str, how: str) -> None:
    _resolved[surface] = how


def describe() -> dict[str, str]:
    return dict(_resolved)


def hermes_version() -> Optional[str]:
    try:
        import hermes_cli  # type: ignore[import-not-found]

        version = getattr(hermes_cli, "__version__", None)
        _note("hermes_version", "hermes_cli.__version__")
        return str(version) if version else None
    except Exception:
        _note("hermes_version", "unavailable")
        return None


def get_secret(name: str) -> str:
    """Read a credential for the request's profile scope; empty string when unset.

    Fail-closed: if the scoped reader raises (multiplex hosting with no scope), return "".
    """
    try:
        from agent.secret_scope import get_secret as _get_secret  # type: ignore[import-not-found]

        _note("secrets", "agent.secret_scope.get_secret")
        value = _get_secret(name, "")
        return str(value or "")
    except ImportError:
        _note("secrets", "os.environ (secret_scope unavailable)")
        return os.environ.get(name, "")
    except Exception as exc:  # UnscopedSecretError and friends
        _log.warning("dash: scoped secret read failed (%s)", type(exc).__name__)
        _note("secrets", "scoped read failed")
        return ""


def plugin_data_dir(name: str = "dash") -> Path:
    """Per-profile plugin data directory (``<hermes home>/plugin-data/<name>``)."""
    override = os.environ.get("DASH_DATA_DIR")
    if override:
        path = Path(override)
        path.mkdir(parents=True, exist_ok=True)
        _note("plugin_data", "DASH_DATA_DIR")
        return path
    try:
        from plugins.plugin_storage import plugin_data_dir as _pdd  # type: ignore[import-not-found]

        _note("plugin_data", "plugins.plugin_storage.plugin_data_dir")
        return Path(_pdd(name))
    except ImportError:
        pass
    try:
        from hermes_constants import get_hermes_home  # type: ignore[import-not-found]

        root = Path(get_hermes_home()) / "plugin-data" / name
        _note("plugin_data", "hermes_constants.get_hermes_home")
    except Exception:
        root = Path.home() / ".hermes" / "plugin-data" / name
        _note("plugin_data", "~/.hermes fallback")
    root.mkdir(parents=True, exist_ok=True)
    return root


@dataclass(frozen=True)
class ProfileSummary:
    name: str
    is_default: bool
    model: Optional[str] = None
    provider: Optional[str] = None
    gateway_running: Optional[bool] = None


def list_profiles() -> list[ProfileSummary]:
    try:
        from hermes_cli.profiles import list_profiles as _list  # type: ignore[import-not-found]

        try:
            infos = _list(lazy_skill_count=True)
        except TypeError:  # older signature
            infos = _list()
        _note("profiles", "hermes_cli.profiles.list_profiles")
        out = []
        for info in infos:
            name = str(getattr(info, "name", "") or "")
            if not name:
                continue
            out.append(
                ProfileSummary(
                    name=name,
                    is_default=bool(getattr(info, "is_default", name == "default")),
                    model=_opt_str(getattr(info, "model", None)),
                    provider=_opt_str(getattr(info, "provider", None)),
                    gateway_running=_opt_bool(getattr(info, "gateway_running", None)),
                )
            )
        return out or [ProfileSummary(name="default", is_default=True)]
    except Exception as exc:
        _log.debug("dash: profile listing unavailable: %s", type(exc).__name__)
        _note("profiles", "unavailable (default only)")
        return [ProfileSummary(name="default", is_default=True)]


def api_server_settings() -> tuple[str, int, Optional[bool]]:
    """``(host, port, multiplex_profiles)`` for the API server of the scoped profile.

    Mirrors ``gateway.platforms.api_server.listen_address``: config.yaml
    ``platforms.api_server`` wins, then ``API_SERVER_HOST``/``API_SERVER_PORT``, then defaults.
    """
    host: Optional[str] = None
    port: Optional[int] = None
    multiplex: Optional[bool] = None
    try:
        from gateway.config import Platform, load_gateway_config  # type: ignore[import-not-found]

        cfg = load_gateway_config()
        multiplex = _opt_bool(getattr(cfg, "multiplex_profiles", None))
        platform_cfg = cfg.platforms.get(Platform.API_SERVER) if hasattr(cfg, "platforms") else None
        extra: dict[str, Any] = dict(getattr(platform_cfg, "extra", None) or {})
        if extra.get("host"):
            host = str(extra["host"])
        if extra.get("port") is not None:
            port = _coerce_port(extra.get("port"))
        _note("api_server_address", "gateway.config.load_gateway_config")
    except Exception as exc:
        _log.debug("dash: gateway config unavailable: %s", type(exc).__name__)
        _note("api_server_address", "environment/defaults")
    if host is None:
        host = get_secret("API_SERVER_HOST") or DEFAULT_API_HOST
    if port is None:
        port = _coerce_port(get_secret("API_SERVER_PORT")) or DEFAULT_API_PORT
    return host, port, multiplex


def _coerce_port(value: Any) -> Optional[int]:
    try:
        port = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return port if 0 < port < 65536 else None


def _opt_str(value: Any) -> Optional[str]:
    return str(value) if isinstance(value, str) and value else None


def _opt_bool(value: Any) -> Optional[bool]:
    return bool(value) if value is not None else None


def serving_profile_name() -> str:
    """The Dashboard process's own profile (the one unprefixed API server routes belong to)."""
    try:
        from hermes_cli.web_server_profiles import serving_profile_name as _serving  # type: ignore[import-not-found]

        name = _serving() or ""
        _note("serving_profile", "hermes_cli.web_server_profiles.serving_profile_name")
        return str(name) or "default"
    except Exception:
        _note("serving_profile", "assumed default")
        return "default"
