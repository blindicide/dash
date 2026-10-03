"""Validation of hostile browser input. Everything here fails closed with a safe message."""

from __future__ import annotations

import base64
import binascii
import re
import uuid
from dataclasses import dataclass
from typing import Any, Optional

# Hermes: PROFILE_ID_RE in hermes_constants (v0.21.5).
PROFILE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
# Hermes session ids are filenames (gateway.session._is_path_unsafe forbids separators/".."); the
# observed shapes are ``20261003_103437_160bfe`` and ``api_<ts>_<hex>``. Allow a conservative
# superset of URL-path-safe characters, never separators or traversal.
SESSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:@+=-]{0,255}$")
# /v1/runs mints ``run_<uuid4 hex>`` (gateway/platforms/api_server_runs.py).
RUN_RE = re.compile(r"^run_[0-9a-f]{32}$")
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,256}$")

MAX_MESSAGE_CHARS = 65_536  # api_server.MAX_NORMALIZED_TEXT_LENGTH
MAX_TITLE_CHARS = 200
APPROVAL_CHOICES = ("once", "session", "always", "deny")
IMAGE_MIME_TYPES = ("image/png", "image/jpeg", "image/gif", "image/webp")


class ValidationError(ValueError):
    """Client input rejected; ``code`` is stable, ``message`` is safe to display."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def profile_name(value: Optional[str]) -> Optional[str]:
    if value is None or value == "":
        return None
    if not isinstance(value, str) or not PROFILE_RE.fullmatch(value):
        raise ValidationError("invalid_profile", "Invalid profile name.")
    return value


def session_id(value: Any) -> str:
    if not isinstance(value, str) or not SESSION_RE.fullmatch(value) or ".." in value:
        raise ValidationError("invalid_session_id", "Invalid session id.")
    return value


def run_id(value: Any) -> str:
    if not isinstance(value, str) or not RUN_RE.fullmatch(value):
        raise ValidationError("invalid_run_id", "Invalid run id.")
    return value


def client_request_id(value: Any) -> str:
    """A browser-generated UUID used to derive the Hermes Idempotency-Key."""
    try:
        parsed = uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        raise ValidationError("invalid_request_id", "client_request_id must be a UUID.") from None
    return str(parsed)


def message_text(value: Any, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise ValidationError("invalid_message", "Message text must be a string.")
    if "\x00" in value:
        raise ValidationError("invalid_message", "Message text contains a NUL byte.")
    if len(value) > MAX_MESSAGE_CHARS:
        raise ValidationError("message_too_long", f"Message exceeds {MAX_MESSAGE_CHARS} characters.")
    if not allow_empty and not value.strip():
        raise ValidationError("empty_message", "Message is empty.")
    return value


def title(value: Any) -> str:
    if not isinstance(value, str):
        raise ValidationError("invalid_title", "Title must be a string.")
    cleaned = " ".join(value.split())
    if len(cleaned) > MAX_TITLE_CHARS:
        raise ValidationError("invalid_title", f"Title exceeds {MAX_TITLE_CHARS} characters.")
    if any(ord(ch) < 32 for ch in cleaned):
        raise ValidationError("invalid_title", "Title contains control characters.")
    return cleaned


def approval_choice(value: Any) -> str:
    choice = str(value or "").strip().lower()
    if choice not in APPROVAL_CHOICES:
        raise ValidationError("invalid_choice", "Approval choice must be one of: " + ", ".join(APPROVAL_CHOICES))
    return choice


def approval_request_id(value: Any) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str) or not REQUEST_ID_RE.fullmatch(value):
        raise ValidationError("invalid_request_id", "Invalid approval request id.")
    return value


@dataclass(frozen=True)
class ImageInput:
    mime: str
    data_url: str
    size: int


_SIGNATURES = {
    "image/png": (b"\x89PNG\r\n\x1a\n",),
    "image/jpeg": (b"\xff\xd8\xff",),
    "image/gif": (b"GIF87a", b"GIF89a"),
    "image/webp": (b"RIFF",),
}


def _sniff_ok(mime: str, raw: bytes) -> bool:
    if mime == "image/webp":
        return raw[:4] == b"RIFF" and raw[8:12] == b"WEBP"
    return any(raw.startswith(sig) for sig in _SIGNATURES.get(mime, ()))


def images(value: Any, *, max_count: int, max_bytes: int) -> list[ImageInput]:
    """Validate ``[{mime, data}]`` (data = base64 without the ``data:`` prefix).

    The declared MIME must be allow-listed and match the decoded magic bytes; SVG and any
    other scriptable type is rejected. Returns canonical ``data:`` URLs for the Hermes
    ``image_url`` content part.
    """
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValidationError("invalid_images", "images must be a list.")
    if len(value) > max_count:
        raise ValidationError("too_many_images", f"At most {max_count} images per message.")
    out: list[ImageInput] = []
    for item in value:
        if not isinstance(item, dict):
            raise ValidationError("invalid_images", "Each image must be an object.")
        mime = str(item.get("mime") or "").lower()
        if mime not in IMAGE_MIME_TYPES:
            raise ValidationError("unsupported_image_type", "Only PNG, JPEG, GIF and WebP images are accepted.")
        data = item.get("data")
        if not isinstance(data, str) or not data:
            raise ValidationError("invalid_images", "Image data missing.")
        if len(data) > (max_bytes * 4) // 3 + 8:
            raise ValidationError("image_too_large", f"Image exceeds {max_bytes} bytes.")
        try:
            raw = base64.b64decode(data, validate=True)
        except (binascii.Error, ValueError):
            raise ValidationError("invalid_images", "Image data is not valid base64.") from None
        if len(raw) > max_bytes:
            raise ValidationError("image_too_large", f"Image exceeds {max_bytes} bytes.")
        if not _sniff_ok(mime, raw):
            raise ValidationError("image_type_mismatch", "Image content does not match its declared type.")
        out.append(
            ImageInput(mime=mime, data_url=f"data:{mime};base64,{base64.b64encode(raw).decode()}", size=len(raw))
        )
    return out
