"""Disposable per-profile UI cache in the sanctioned plugin-data directory.

Holds only pointers and preferences — never conversation content:

* ``last_session_id`` — which Hermes session dash reopens for this profile;
* ``active_runs`` — ``session_id → run_id`` pointers so a reloaded browser can find and
  resubscribe to a still-running Hermes run (Hermes has no "list active runs" endpoint);
* ``preferences`` — harmless UI settings.

Deleting the file loses nothing authoritative: Hermes still owns every session and run.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, Optional

from . import compat

STATE_FILE = "state.json"
SCHEMA_VERSION = 1
ACTIVE_RUN_TTL_SECONDS = 24 * 3600  # Hermes retains idempotent run status for 24 h
MAX_ACTIVE_RUNS = 200

PREFERENCE_SCHEMA: dict[str, tuple] = {
    "density": ("comfortable", "compact"),
    "show_reasoning": (True, False),
    "show_tool_details": (True, False),
    "enter_to_send": (True, False),
}
DEFAULT_PREFERENCES: dict[str, Any] = {
    "density": "comfortable",
    "show_reasoning": False,
    "show_tool_details": False,
    "enter_to_send": True,
}

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock_for(path: Path) -> threading.Lock:
    key = str(path)
    with _locks_guard:
        lock = _locks.get(key)
        if lock is None:
            lock = _locks[key] = threading.Lock()
        return lock


def _empty() -> dict[str, Any]:
    return {"version": SCHEMA_VERSION, "last_session_id": None, "active_runs": {}, "preferences": {}}


class StateStore:
    def __init__(self, directory: Optional[Path] = None):
        self.directory = directory or compat.plugin_data_dir("dash")
        self.path = self.directory / STATE_FILE

    def _read(self) -> dict[str, Any]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return _empty()
        if not isinstance(raw, dict) or raw.get("version") != SCHEMA_VERSION:
            return _empty()
        state = _empty()
        if isinstance(raw.get("last_session_id"), str):
            state["last_session_id"] = raw["last_session_id"]
        if isinstance(raw.get("active_runs"), dict):
            state["active_runs"] = {
                k: v for k, v in raw["active_runs"].items() if isinstance(k, str) and isinstance(v, dict)
            }
        if isinstance(raw.get("preferences"), dict):
            state["preferences"] = sanitize_preferences(raw["preferences"])
        return state

    def _write(self, state: dict[str, Any]) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".state-", suffix=".json", dir=str(self.directory))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(state, fh, separators=(",", ":"))
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    def _mutate(self, fn: Callable[[dict[str, Any]], Any]) -> Any:
        with _lock_for(self.path):
            state = self._read()
            result = fn(state)
            _prune(state)
            self._write(state)
            return result

    def snapshot(self) -> dict[str, Any]:
        with _lock_for(self.path):
            state = self._read()
        _prune(state)
        return state

    # -- last session ------------------------------------------------------------------

    def last_session(self) -> Optional[str]:
        return self.snapshot()["last_session_id"]

    def set_last_session(self, session_id: Optional[str]) -> None:
        def apply(state: dict[str, Any]) -> None:
            state["last_session_id"] = session_id

        self._mutate(apply)

    def forget_session(self, session_id: str) -> None:
        def apply(state: dict[str, Any]) -> None:
            if state.get("last_session_id") == session_id:
                state["last_session_id"] = None
            state["active_runs"].pop(session_id, None)

        self._mutate(apply)

    # -- active runs -------------------------------------------------------------------

    def active_run(self, session_id: str) -> Optional[dict[str, Any]]:
        entry = self.snapshot()["active_runs"].get(session_id)
        return dict(entry) if entry else None

    def set_active_run(self, session_id: str, run_id: str, client_request_id: str) -> None:
        def apply(state: dict[str, Any]) -> None:
            state["active_runs"][session_id] = {
                "run_id": run_id,
                "client_request_id": client_request_id,
                "created_at": time.time(),
            }

        self._mutate(apply)

    def clear_active_run(self, session_id: str, run_id: Optional[str] = None) -> None:
        def apply(state: dict[str, Any]) -> None:
            entry = state["active_runs"].get(session_id)
            if entry and (run_id is None or entry.get("run_id") == run_id):
                state["active_runs"].pop(session_id, None)

        self._mutate(apply)

    # -- preferences -------------------------------------------------------------------

    def preferences(self) -> dict[str, Any]:
        return {**DEFAULT_PREFERENCES, **self.snapshot()["preferences"]}

    def update_preferences(self, patch: dict[str, Any]) -> dict[str, Any]:
        clean = sanitize_preferences(patch, strict=True)

        def apply(state: dict[str, Any]) -> dict[str, Any]:
            state["preferences"] = {**state["preferences"], **clean}
            return {**DEFAULT_PREFERENCES, **state["preferences"]}

        return self._mutate(apply)


class PreferenceError(ValueError):
    pass


def sanitize_preferences(raw: dict[str, Any], *, strict: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in raw.items():
        allowed = PREFERENCE_SCHEMA.get(key)
        if allowed is None or value not in allowed or (isinstance(value, bool) != isinstance(allowed[0], bool)):
            if strict:
                raise PreferenceError(f"Invalid preference: {key}")
            continue
        out[key] = value
    return out


def _prune(state: dict[str, Any]) -> None:
    now = time.time()
    runs = state["active_runs"]
    for sid in [s for s, e in runs.items() if now - float(e.get("created_at") or 0) > ACTIVE_RUN_TTL_SECONDS]:
        runs.pop(sid, None)
    if len(runs) > MAX_ACTIVE_RUNS:
        for sid, _ in sorted(runs.items(), key=lambda kv: float(kv[1].get("created_at") or 0))[
            : len(runs) - MAX_ACTIVE_RUNS
        ]:
            runs.pop(sid, None)
