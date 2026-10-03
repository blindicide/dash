"""Optional general-file uploads (OFF unless ``DASH_UPLOADS_ENABLED=1``).

Hermes' native media path is the image content part of a run (handled without any disk
write). Hermes v0.21.5 exposes no API to attach an arbitrary document to a run, so when an
operator opts in, dash stores the file in a dedicated per-profile directory and the run text
names the server-side path, letting the agent read it with its own file tools.

Defences: authenticated route only; server-generated names (the client filename is display
metadata only); extension + content allow-list with magic-byte/UTF-8 checks; streaming size
cap; no client-chosen path; 0600 files in a 0700 directory; TTL cleanup.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import time
import unicodedata
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from . import compat
from .errors import DashError

UPLOAD_ID_RE = re.compile(r"^upl_[0-9a-f]{32}$")
TEXT_TYPES = {
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".json": "application/json",
    ".log": "text/plain",
}
BINARY_TYPES = {
    ".pdf": ("application/pdf", (b"%PDF-",)),
    ".png": ("image/png", (b"\x89PNG\r\n\x1a\n",)),
    ".jpg": ("image/jpeg", (b"\xff\xd8\xff",)),
    ".jpeg": ("image/jpeg", (b"\xff\xd8\xff",)),
    ".gif": ("image/gif", (b"GIF87a", b"GIF89a")),
    ".webp": ("image/webp", (b"RIFF",)),
}
MAX_NAME_CHARS = 120


@dataclass(frozen=True)
class StoredUpload:
    upload_id: str
    name: str
    mime: str
    size: int
    path: Path
    created_at: float

    def public(self) -> dict[str, object]:
        return {"upload_id": self.upload_id, "name": self.name, "mime": self.mime, "size": self.size}


def upload_dir() -> Path:
    root = compat.plugin_data_dir("dash") / "uploads"
    root.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(root, 0o700)
    except OSError:
        pass
    return root


def display_name(raw: str) -> str:
    """Sanitise a client filename for *display* only (never used as a path)."""
    name = unicodedata.normalize("NFC", raw or "").replace("\\", "/").split("/")[-1]
    name = "".join(ch for ch in name if ch.isprintable() and ch not in '<>:"|?*').strip(" .")
    return (name or "upload")[:MAX_NAME_CHARS]


def classify(name: str) -> tuple[str, str]:
    ext = os.path.splitext(name)[1].lower()
    if ext in TEXT_TYPES:
        return ext, TEXT_TYPES[ext]
    if ext in BINARY_TYPES:
        return ext, BINARY_TYPES[ext][0]
    raise DashError(
        415,
        "unsupported_upload_type",
        "File type not allowed. Allowed: " + ", ".join(sorted({*TEXT_TYPES, *BINARY_TYPES})),
    )


def _content_ok(ext: str, head: bytes, path: Path) -> bool:
    if ext in BINARY_TYPES:
        if ext == ".webp":
            return head[:4] == b"RIFF" and head[8:12] == b"WEBP"
        return any(head.startswith(sig) for sig in BINARY_TYPES[ext][1])
    try:
        with path.open("rb") as fh:
            data = fh.read()
        text = data.decode("utf-8")
    except (OSError, UnicodeDecodeError):
        return False
    return "\x00" not in text


async def save(chunks: AsyncIterator[bytes], *, filename: str, max_bytes: int) -> StoredUpload:
    name = display_name(filename)
    ext, mime = classify(name)
    directory = upload_dir()
    cleanup(directory)
    upload_id = f"upl_{secrets.token_hex(16)}"
    path = directory / f"{upload_id}{ext}"
    size = 0
    head = b""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as fh:
            async for chunk in chunks:
                size += len(chunk)
                if size > max_bytes:
                    raise DashError(413, "upload_too_large", f"File exceeds {max_bytes} bytes.")
                if len(head) < 16:
                    head += chunk[: 16 - len(head)]
                fh.write(chunk)
        if size == 0:
            raise DashError(400, "empty_upload", "File is empty.")
        if not _content_ok(ext, head, path):
            raise DashError(415, "upload_content_mismatch", "File content does not match its type.")
    except BaseException:
        try:
            path.unlink()
        except OSError:
            pass
        raise
    created = time.time()
    meta = {"name": name, "mime": mime, "size": size, "created_at": created, "ext": ext}
    meta_path = directory / f"{upload_id}.json"
    meta_fd = os.open(meta_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(meta_fd, "w", encoding="utf-8") as fh:
        json.dump(meta, fh)
    return StoredUpload(upload_id, name, mime, size, path, created)


def load(upload_id: str) -> StoredUpload:
    if not UPLOAD_ID_RE.fullmatch(upload_id or ""):
        raise DashError(400, "invalid_upload_id", "Invalid upload id.")
    directory = upload_dir()
    try:
        meta = json.loads((directory / f"{upload_id}.json").read_text(encoding="utf-8"))
        ext = str(meta["ext"])
        if ext not in TEXT_TYPES and ext not in BINARY_TYPES:
            raise ValueError
        path = directory / f"{upload_id}{ext}"
        if not path.is_file():
            raise ValueError
        return StoredUpload(
            upload_id, str(meta["name"]), str(meta["mime"]), int(meta["size"]), path, float(meta["created_at"])
        )
    except (OSError, ValueError, KeyError, TypeError):
        raise DashError(404, "upload_not_found", "Upload not found or expired.") from None


def delete(upload_id: str) -> None:
    stored = load(upload_id)
    for p in (stored.path, stored.path.with_suffix(".json")):
        try:
            p.unlink()
        except OSError:
            pass


def cleanup(directory: Optional[Path] = None, *, ttl_hours: Optional[int] = None) -> int:
    from .config import load_settings

    directory = directory or upload_dir()
    ttl = (ttl_hours or load_settings().upload_ttl_hours) * 3600
    now = time.time()
    removed = 0
    for entry in directory.iterdir():
        if not entry.name.startswith("upl_"):
            continue
        try:
            if now - entry.stat().st_mtime > ttl:
                entry.unlink()
                removed += 1
        except OSError:
            continue
    return removed


def attachment_note(stored: list[StoredUpload]) -> str:
    lines = [f"- {u.name} ({u.mime}, {u.size} bytes) saved by dash at: {u.path}" for u in stored]
    return "\n\n[Files attached via dash — read them from the server paths below]\n" + "\n".join(lines)
