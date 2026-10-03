"""Structured run-event adapter: Hermes ``/v1/runs/{id}/events`` SSE → dash wire events.

Hermes frames are ``id: <seq>\\ndata: <json>\\n\\n`` with comment keepalives (``: keepalive``)
and a terminal ``: stream closed`` comment. Event names and fields below are taken from
``gateway/platforms/api_server_runs.py`` (v0.21.5); ``tool.failed`` is accepted because the
upstream docs list it. Each normalised event keeps the Hermes ``seq`` so the browser can
resume with ``Last-Event-ID`` after a disconnect. Only allow-listed fields cross to the
browser; unknown event names are passed through as ``{"type": "unknown"}`` markers so a newer
Hermes never breaks an older dash.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any, Optional

from .errors import redact

TERMINAL_RUN_STATUSES = frozenset({"completed", "failed", "cancelled", "interrupted"})
_MAX_TEXT = 200_000
_MAX_PREVIEW = 4_000


@dataclass
class SSEFrame:
    id: Optional[str] = None
    event: Optional[str] = None
    data_lines: list[str] = field(default_factory=list)
    comment: Optional[str] = None

    @property
    def data(self) -> str:
        return "\n".join(self.data_lines)


class SSEParser:
    """Incremental, spec-conformant SSE parser (handles CRLF/LF and split chunks)."""

    def __init__(self) -> None:
        self._buf = ""
        self._frame = SSEFrame()

    def feed(self, chunk: str) -> Iterator[SSEFrame]:
        self._buf += chunk
        while True:
            idx = _line_end(self._buf)
            if idx is None:
                return
            line, consumed = idx
            self._buf = self._buf[consumed:]
            if line == "":
                frame, self._frame = self._frame, SSEFrame()
                if frame.data_lines or frame.comment is not None or frame.event or frame.id is not None:
                    yield frame
                continue
            if line.startswith(":"):
                comment = line[1:].strip()
                # Comments are standalone signals (keepalive / stream closed).
                yield SSEFrame(comment=comment)
                continue
            name, _, value = line.partition(":")
            if value.startswith(" "):
                value = value[1:]
            if name == "data":
                self._frame.data_lines.append(value)
            elif name == "id":
                self._frame.id = value
            elif name == "event":
                self._frame.event = value


def _line_end(buf: str) -> Optional[tuple[str, int]]:
    for i, ch in enumerate(buf):
        if ch == "\n":
            return buf[:i].rstrip("\r"), i + 1
        if ch == "\r":
            if i + 1 < len(buf):
                return buf[:i], i + (2 if buf[i + 1] == "\n" else 1)
            return None  # wait to see whether \n follows
    return None


def _text(value: Any, limit: int = _MAX_TEXT) -> str:
    text = value if isinstance(value, str) else ("" if value is None else str(value))
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _num(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _usage(value: Any) -> Optional[dict[str, int]]:
    if not isinstance(value, dict):
        return None
    out = {}
    for key in ("input_tokens", "output_tokens", "total_tokens", "cache_read_tokens", "cache_write_tokens"):
        v = value.get(key)
        if isinstance(v, int) and not isinstance(v, bool):
            out[key] = v
    return out


def _runtime(value: Any) -> Optional[dict[str, str]]:
    if not isinstance(value, dict):
        return None
    return {k: _text(value.get(k), 200) for k in ("provider", "model") if isinstance(value.get(k), str)}


_SUBAGENT_KEYS = (
    "goal",
    "summary",
    "status",
    "subagent_id",
    "child_session_id",
    "task_index",
    "task_count",
    "duration_seconds",
    "model",
    "tool_count",
)
_APPROVAL_KEYS = ("command", "description", "pattern_key", "request_id", "tool", "risk")


def normalize(payload: dict[str, Any], seq: Optional[int]) -> dict[str, Any]:
    """Map one Hermes run event to the dash wire shape."""
    name = str(payload.get("event") or "")
    base: dict[str, Any] = {
        "seq": seq,
        "run_id": payload.get("run_id") if isinstance(payload.get("run_id"), str) else None,
        "ts": _num(payload.get("timestamp")),
    }
    if name == "message.delta":
        return {**base, "type": "delta", "text": _text(payload.get("delta"))}
    if name == "message.interim":
        return {
            **base,
            "type": "commentary",
            "text": _text(payload.get("text")),
            "already_streamed": bool(payload.get("already_streamed")),
        }
    if name == "reasoning.available":
        return {**base, "type": "reasoning", "text": _text(payload.get("text"))}
    if name in {"tool.started", "tool.completed", "tool.failed"}:
        failed = name == "tool.failed" or bool(payload.get("error"))
        phase = "running" if name == "tool.started" else ("failed" if failed else "completed")
        event = {
            **base,
            "type": "tool",
            "phase": phase,
            "tool": _text(payload.get("tool"), 200),
            "preview": redact(_text(payload.get("preview"), _MAX_PREVIEW), limit=_MAX_PREVIEW),
        }
        duration = _num(payload.get("duration"))
        if duration is not None:
            event["duration"] = duration
        return event
    if name in {"subagent.start", "subagent.complete"}:
        event = {**base, "type": "subagent", "phase": "started" if name.endswith("start") else "completed"}
        for key in _SUBAGENT_KEYS:
            value = payload.get(key)
            if isinstance(value, (str, int, float)) and not isinstance(value, bool):
                event[key] = _text(value, _MAX_PREVIEW) if isinstance(value, str) else value
        if isinstance(payload.get("preview"), str):
            event["preview"] = _text(payload["preview"], _MAX_PREVIEW)
        return event
    if name == "approval.request":
        event = {**base, "type": "approval"}
        for key in _APPROVAL_KEYS:
            value = payload.get(key)
            if isinstance(value, str):
                event[key] = _text(value, _MAX_PREVIEW)
        keys = payload.get("pattern_keys")
        if isinstance(keys, list):
            event["pattern_keys"] = [_text(k, 200) for k in keys if isinstance(k, str)][:20]
        choices = payload.get("choices")
        event["choices"] = (
            [c for c in choices if c in {"once", "session", "always", "deny"}]
            if isinstance(choices, list)
            else ["once", "deny"]
        )
        if payload.get("smart_denied"):
            event["smart_denied"] = True
        return event
    if name == "approval.responded":
        return {
            **base,
            "type": "approval_resolved",
            "choice": _text(payload.get("choice"), 20),
            "request_id": payload.get("request_id") if isinstance(payload.get("request_id"), str) else None,
        }
    if name == "run.steered":
        return {**base, "type": "steered"}
    if name.startswith("run."):
        status = name[4:]
        event = {**base, "type": "run", "status": status}
        for key in ("completed", "partial", "interrupted"):
            if key in payload:
                event[key] = bool(payload.get(key))
        if isinstance(payload.get("output"), str):
            event["output"] = _text(payload["output"])
        if payload.get("error"):
            event["error"] = redact(payload.get("error"))
        if isinstance(payload.get("turn_exit_reason"), str):
            event["turn_exit_reason"] = _text(payload["turn_exit_reason"], 200)
        usage = _usage(payload.get("usage"))
        if usage:
            event["usage"] = usage
        runtime = _runtime(payload.get("runtime"))
        if runtime:
            event["runtime"] = runtime
        return event
    if name == "replay.truncated":
        oldest = payload.get("oldest_retained_seq")
        return {**base, "type": "replay_truncated", "oldest_retained_seq": oldest if isinstance(oldest, int) else None}
    return {**base, "type": "unknown", "name": _text(name, 100)}


def parse_frame(frame: SSEFrame) -> Optional[dict[str, Any]]:
    """Decode a data frame into a normalised event; ``None`` for non-JSON / non-object data."""
    if not frame.data_lines:
        return None
    try:
        payload = json.loads(frame.data)
    except (ValueError, TypeError):
        return None
    if not isinstance(payload, dict):
        return None
    seq: Optional[int] = None
    raw_seq = frame.id if frame.id is not None else payload.get("seq")
    try:
        seq = int(str(raw_seq)) if raw_seq is not None and str(raw_seq).strip() != "" else None
    except ValueError:
        seq = None
    return normalize(payload, seq)


def encode(event: dict[str, Any]) -> bytes:
    """Encode a dash event as an SSE frame; ``seq`` becomes the SSE id for resume."""
    seq = event.get("seq")
    prefix = f"id: {seq}\n" if isinstance(seq, int) else ""
    return f"{prefix}data: {json.dumps(event, ensure_ascii=False, separators=(',', ':'))}\n\n".encode()


def normalize_run_status(status: dict[str, Any]) -> dict[str, Any]:
    """Allow-list the pollable ``GET /v1/runs/{id}`` record for the browser."""
    out: dict[str, Any] = {
        "run_id": status.get("run_id") if isinstance(status.get("run_id"), str) else None,
        "status": _text(status.get("status"), 40),
        "session_id": status.get("session_id") if isinstance(status.get("session_id"), str) else None,
        "created_at": _num(status.get("created_at")),
        "updated_at": _num(status.get("updated_at")),
        "last_event": _text(status.get("last_event"), 60) if status.get("last_event") else None,
    }
    out["terminal"] = out["status"] in TERMINAL_RUN_STATUSES
    if isinstance(status.get("output"), str):
        out["output"] = _text(status["output"])
    if status.get("error"):
        out["error"] = redact(status.get("error"))
    usage = _usage(status.get("usage"))
    if usage:
        out["usage"] = usage
    approval = status.get("approval")
    if isinstance(approval, dict) and out["status"] == "waiting_for_approval":
        out["approval"] = normalize(approval, None)
    return out
