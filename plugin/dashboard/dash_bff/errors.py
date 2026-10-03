"""Error model and secret redaction shared by every BFF route."""

from __future__ import annotations

import re
from typing import Any, Optional

# Credential-shaped substrings that must never reach a browser or a log line.
_REDACTIONS = (
    (re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}"), "Bearer [redacted]"),
    (re.compile(r"(?i)\b(api[_-]?key|token|secret|password|authorization)(\s*[=:]\s*)[^\s,;\"']+"), r"\1\2[redacted]"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{12,}"), "[redacted-key]"),
    (re.compile(r"\b[A-Fa-f0-9]{40,}\b"), "[redacted-hex]"),
    (re.compile(r"\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}"), "[redacted-token]"),
)
MAX_ERROR_CHARS = 400


def redact(text: Any, *, limit: int = MAX_ERROR_CHARS) -> str:
    out = str(text if text is not None else "")
    for pattern, replacement in _REDACTIONS:
        out = pattern.sub(replacement, out)
    out = out.replace("\x00", "")
    return out if len(out) <= limit else out[: limit - 1] + "…"


class DashError(Exception):
    """An error with a stable ``code`` and a browser-safe ``message``."""

    def __init__(self, status: int, code: str, message: str, *, retryable: bool = False):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = redact(message)
        self.retryable = retryable

    def payload(self) -> dict:
        return {"error": {"code": self.code, "message": self.message, "retryable": self.retryable}}


def hermes_unavailable(detail: Optional[str] = None) -> DashError:
    msg = "Hermes API server is unreachable."
    if detail:
        msg = f"{msg} ({detail})"
    return DashError(503, "hermes_unavailable", msg, retryable=True)


def from_hermes_response(status: int, body: Any) -> DashError:
    """Translate a Hermes API error response into a DashError.

    Hermes 401s are *not* forwarded as 401: the Dashboard SPA treats a 401 as an expired
    Dashboard session and redirects to login, which would be wrong — the failing credential is
    dash's server-side ``API_SERVER_KEY``.
    """
    code, message = _extract(body)
    if status == 401:
        return DashError(
            502,
            "hermes_auth_failed",
            "Hermes rejected dash's server-side API credential (check API_SERVER_KEY for this profile).",
        )
    if status == 403:
        return DashError(403, code or "hermes_forbidden", message or "Hermes refused this action.")
    if status == 404:
        return DashError(404, code or "not_found", message or "Not found in Hermes.")
    if status == 409:
        return DashError(409, code or "conflict", message or "Conflicting Hermes state.")
    if status == 413:
        return DashError(413, code or "too_large", message or "Request too large for Hermes.")
    if status == 429:
        return DashError(429, code or "hermes_busy", message or "Hermes is busy; try again shortly.", retryable=True)
    if 400 <= status < 500:
        return DashError(400, code or "invalid_request", message or "Hermes rejected the request.")
    if status == 503:
        return DashError(503, code or "hermes_unavailable", message or "Hermes is unavailable.", retryable=True)
    return DashError(502, code or "hermes_error", message or f"Hermes returned HTTP {status}.", retryable=True)


def _extract(body: Any) -> tuple[str, str]:
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict):
            return str(err.get("code") or err.get("type") or ""), redact(err.get("message") or "")
        if isinstance(err, str):
            return "", redact(err)
        if body.get("detail"):
            return "", redact(body.get("detail"))
    if isinstance(body, str):
        return "", redact(body)
    return "", ""
