"""Hermes Dashboard backend entry point for the ``dash`` plugin.

The Dashboard imports this single file via ``importlib.util.spec_from_file_location`` (no
package context), so the real implementation is loaded here as a private package from the
sibling ``dash_bff/`` directory. Only the module-level ``router`` is consumed by the host.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_PACKAGE = "hermes_dashboard_plugin_dash_bff"
_PACKAGE_DIR = Path(__file__).resolve().parent / "dash_bff"


def _load_package():
    existing = sys.modules.get(_PACKAGE)
    if existing is not None:
        return existing
    spec = importlib.util.spec_from_file_location(
        _PACKAGE, _PACKAGE_DIR / "__init__.py", submodule_search_locations=[str(_PACKAGE_DIR)]
    )
    if spec is None or spec.loader is None:  # pragma: no cover - defensive
        raise ImportError("dash: cannot load BFF package")
    module = importlib.util.module_from_spec(spec)
    sys.modules[_PACKAGE] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(_PACKAGE, None)
        raise
    return module


_load_package()
router = importlib.import_module(f"{_PACKAGE}.routes").router

__all__ = ["router"]
