"""BFF routes mounted by the Hermes Dashboard at ``/api/plugins/dash/``.

Request path: browser → Dashboard auth gate (session token / OAuth cookie) → Dashboard's
``_plugin_route_secret_scope(profile)`` (enters the requested profile's home + secret scope)
→ these handlers → :class:`HermesClient` → Hermes API server. Browsers never see the Hermes
URL or API key; they only pick a validated profile name.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Optional
from urllib.parse import unquote, urlsplit

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse

from . import compat, events, uploads, validation
from .config import ConfigError, HermesTarget, Settings, load_settings, resolve_target
from .errors import DashError, redact
from .hermes_client import HermesClient, session_rows
from .store import PreferenceError, StateStore
from .version import PRODUCT, SYMBOL, __version__

_log = logging.getLogger("dash.routes")

BOT_CHAT_TITLE = "Bot Chat"  # tools.bot_mode_probe.BOT_CHAT_TITLE / hermes_cli/subcommands/peer.py
SEARCH_PAGE = 200
SEARCH_MAX_SESSIONS = 1000
CAPABILITY_TTL = 30.0
MAX_JSON_BODY = 48 * 1024 * 1024  # images are base64 in the body; bounded again per image

router = APIRouter()


# --------------------------------------------------------------------------------------------
# Request context
# --------------------------------------------------------------------------------------------


@dataclass
class Ctx:
    profile: str
    is_launch: bool
    settings: Settings
    target: HermesTarget
    client: HermesClient
    store: StateStore


def _resolve_ctx(profile: Optional[str]) -> Ctx:
    requested = validation.profile_name(profile)
    launch = compat.serving_profile_name()
    name = requested or launch
    is_launch = requested is None or requested == launch
    settings = load_settings()
    try:
        target = resolve_target(name, is_launch_profile=is_launch, settings=settings)
    except ConfigError as exc:
        raise DashError(500, "dash_misconfigured", str(exc)) from None
    return Ctx(
        profile=name,
        is_launch=is_launch,
        settings=settings,
        target=target,
        client=HermesClient(target, timeout=settings.http_timeout),
        store=StateStore(),
    )


def _http(exc: Exception) -> HTTPException:
    """Dependencies run outside ``_guarded``; surface their errors via FastAPI's handler with
    the same ``{"error": {...}}`` envelope nested under ``detail``."""
    if isinstance(exc, validation.ValidationError):
        return HTTPException(400, detail={"error": {"code": exc.code, "message": exc.message, "retryable": False}})
    if isinstance(exc, DashError):
        return HTTPException(exc.status, detail=exc.payload())
    return HTTPException(
        500, detail={"error": {"code": "internal_error", "message": "Unexpected dash error.", "retryable": True}}
    )


def ctx_dep(profile: Optional[str] = Query(None, max_length=64)) -> Ctx:
    try:
        return _resolve_ctx(profile)
    except (DashError, validation.ValidationError) as exc:
        raise _http(exc) from None


def _same_origin(request: Request) -> bool:
    origin = request.headers.get("origin")
    if not origin:
        return True  # non-browser or same-origin GET-style navigation; header check still applies
    parts = urlsplit(origin)
    if not parts.netloc:
        return False
    host = (request.headers.get("host") or "").strip().lower()
    scheme = request.url.scheme.lower()
    trusted = {
        o.strip().rstrip("/").lower() for o in os.environ.get("DASH_TRUSTED_ORIGINS", "").split(",") if o.strip()
    }
    expected = f"{scheme}://{host}" if host else ""
    return origin.rstrip("/").lower() == expected or origin.rstrip("/").lower() in trusted


def mutation_guard(request: Request) -> None:
    """Defence in depth on top of the Dashboard's auth + SameSite=Lax cookies: state-changing
    calls must carry a custom header (forces a CORS preflight cross-site) and, when the browser
    sends an Origin, it must match the Host the Dashboard was reached on."""
    if request.headers.get("x-dash-request") != "1":
        raise _http(DashError(403, "missing_dash_header", "Missing X-Dash-Request header."))
    if not _same_origin(request):
        raise _http(DashError(403, "cross_origin", "Cross-origin request refused."))


async def _json_body(request: Request, *, limit: int = 256 * 1024) -> dict[str, Any]:
    ctype = request.headers.get("content-type", "")
    if "application/json" not in ctype:
        raise DashError(415, "json_required", "Content-Type must be application/json.")
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise DashError(413, "body_too_large", "Request body too large.")
    raw = b""
    async for chunk in request.stream():
        raw += chunk
        if len(raw) > limit:
            raise DashError(413, "body_too_large", "Request body too large.")
    try:
        import json

        body = json.loads(raw or b"{}")
    except ValueError:
        raise DashError(400, "invalid_json", "Request body is not valid JSON.") from None
    if not isinstance(body, dict):
        raise DashError(400, "invalid_json", "Request body must be a JSON object.")
    return body


def _err(exc: Exception) -> JSONResponse:
    if isinstance(exc, validation.ValidationError):
        return JSONResponse({"error": {"code": exc.code, "message": exc.message, "retryable": False}}, status_code=400)
    if isinstance(exc, DashError):
        return JSONResponse(exc.payload(), status_code=exc.status)
    _log.warning("dash: unexpected error %s", type(exc).__name__)
    return JSONResponse(
        {"error": {"code": "internal_error", "message": "Unexpected dash error.", "retryable": True}}, status_code=500
    )


def _guarded(fn):
    """Uniform error envelope for every JSON route (never leaks tracebacks or secrets)."""
    import functools

    @functools.wraps(fn)
    async def wrapper(*args, **kwargs):
        try:
            return await fn(*args, **kwargs)
        except (DashError, validation.ValidationError) as exc:
            return _err(exc)
        except Exception as exc:  # pragma: no cover - last resort
            return _err(exc)

    return wrapper


# --------------------------------------------------------------------------------------------
# Normalisation (allow-lists only)
# --------------------------------------------------------------------------------------------

_SESSION_KEYS = (
    "id",
    "title",
    "source",
    "model",
    "started_at",
    "ended_at",
    "end_reason",
    "message_count",
    "tool_call_count",
    "last_active",
    "preview",
    "parent_session_id",
    "pinned",
    "archived",
    "hidden",
    "is_internal_child",
    "input_tokens",
    "output_tokens",
)


def _session(row: dict[str, Any]) -> dict[str, Any]:
    out = {k: row.get(k) for k in _SESSION_KEYS if k in row}
    if isinstance(out.get("preview"), str):
        out["preview"] = out["preview"][:300]
    out["is_bot_chat"] = (row.get("title") or "").strip() == BOT_CHAT_TITLE
    return out


def _session_from(body: dict[str, Any]) -> dict[str, Any]:
    row = body.get("session") if isinstance(body.get("session"), dict) else body
    return _session(row)


_MAX_INLINE_IMAGE_CHARS = 3 * 1024 * 1024


def _content_parts(content: Any) -> Any:
    if isinstance(content, str) or content is None:
        return content or ""
    if not isinstance(content, list):
        return str(content)
    parts: list[dict[str, Any]] = []
    for part in content:
        if not isinstance(part, dict):
            continue
        ptype = part.get("type")
        if ptype in ("text", "input_text") and isinstance(part.get("text"), str):
            parts.append({"type": "text", "text": part["text"]})
        elif ptype in ("image_url", "input_image"):
            ref = part.get("image_url")
            url = ref.get("url") if isinstance(ref, dict) else ref
            if isinstance(url, str) and url.startswith("data:image/") and len(url) <= _MAX_INLINE_IMAGE_CHARS:
                parts.append({"type": "image", "url": url})
            else:
                parts.append({"type": "image", "url": None})
    return parts


def _message(row: dict[str, Any]) -> Optional[dict[str, Any]]:
    if row.get("display_kind") == "hidden":
        return None
    role = row.get("role")
    if role not in ("user", "assistant", "tool", "system"):
        return None
    out: dict[str, Any] = {
        "id": row.get("id"),
        "role": role,
        "content": _content_parts(row.get("content")),
        "timestamp": row.get("timestamp"),
    }
    for key in ("tool_name", "tool_call_id", "finish_reason"):
        if isinstance(row.get(key), str):
            out[key] = row[key]
    reasoning = row.get("reasoning") or row.get("reasoning_content")
    if isinstance(reasoning, str) and reasoning.strip():
        out["reasoning"] = reasoning
    calls = row.get("tool_calls")
    if isinstance(calls, list):
        norm = []
        for call in calls[:64]:
            if not isinstance(call, dict):
                continue
            fn = call.get("function") if isinstance(call.get("function"), dict) else {}
            args = fn.get("arguments", call.get("arguments"))
            norm.append(
                {
                    "id": call.get("id") if isinstance(call.get("id"), str) else None,
                    "name": str(fn.get("name") or call.get("name") or "tool")[:200],
                    "arguments": redact(
                        args if isinstance(args, str) else ("" if args is None else str(args)), limit=4000
                    ),
                }
            )
        if norm:
            out["tool_calls"] = norm
    if role == "tool" and isinstance(out["content"], str):
        out["content"] = redact(out["content"], limit=8000)
    return out


# --------------------------------------------------------------------------------------------
# Status, capabilities, profiles
# --------------------------------------------------------------------------------------------

_cap_cache: dict[str, tuple] = {}


async def _probe_capabilities(ctx: Ctx, *, force: bool = False) -> dict[str, Any]:
    key = f"{ctx.profile}|{ctx.target.base_url}"
    cached = _cap_cache.get(key)
    if cached and not force and time.monotonic() - cached[0] < CAPABILITY_TTL:
        return cached[1]
    raw = await ctx.client.capabilities()
    _cap_cache[key] = (time.monotonic(), raw)
    return raw


def _derive_capabilities(raw: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    features = raw.get("features") if isinstance(raw.get("features"), dict) else {}
    endpoints = raw.get("endpoints") if isinstance(raw.get("endpoints"), dict) else {}

    def feat(name: str) -> bool:
        return bool(features.get(name))

    def ep(name: str) -> bool:
        return name in endpoints

    idem = features.get("runs_idempotency") if isinstance(features.get("runs_idempotency"), dict) else {}
    runs = feat("run_submission") and ep("runs")
    return {
        "sessions": {
            "list": ep("sessions") and feat("session_resources"),
            "create": ep("session_create"),
            "get": ep("session"),
            "rename": ep("session_update"),
            "delete": ep("session_delete"),
            "messages": ep("session_messages"),
            "fork": feat("session_fork") and ep("session_fork"),
            "pin_archive": ep("session_update"),
            "search": "titles_and_previews",
        },
        "runs": {
            "submit": runs,
            "status": feat("run_status") and ep("run_status"),
            "events": feat("run_events_sse") and ep("run_events"),
            "stop": feat("run_stop") and ep("run_stop"),
            "approval": feat("run_approval_response") and feat("approval_events") and ep("run_approval"),
            "tool_events": feat("tool_progress_events"),
            "reasoning_events": feat("reasoning_streaming"),
            "idempotency": bool(idem.get("supported")),
            "idempotency_durable": bool(idem.get("durable")),
            "resume_from_seq": feat("run_events_sse"),
        },
        "media": {
            # /v1/runs forwards the last input message's content (text + image_url parts) to the
            # agent unchanged; Hermes documents image parts for chat/session-chat. Verified by
            # source + dash integration test, so exposed as "source_verified".
            "images": "source_verified" if runs else False,
            "image_max_bytes": ctx.settings.image_max_bytes,
            "image_max_count": ctx.settings.image_max_count,
            "uploads": ctx.settings.uploads_enabled,
            "upload_max_bytes": ctx.settings.upload_max_bytes if ctx.settings.uploads_enabled else 0,
        },
        "hermes": {
            "model_options": feat("model_options") and ep("model_options"),
            "skills": feat("skills_api") and ep("skills"),
            "toolsets": ep("toolsets"),
            "memory_read": False,  # no read API on the API server (memory_write_api=false, no GET)
            "soul_read": False,  # SOUL is not exposed by the API server
            "mcp_status": False,  # no MCP status endpoint on the API server
        },
        "bot_chat": ep("sessions") and ep("session_create"),
        "steer": feat("run_steer"),
    }


@router.get("/status")
@_guarded
async def status(ctx: Ctx = Depends(ctx_dep)):
    hermes: dict[str, Any] = {"version": compat.hermes_version(), "reachable": False}
    try:
        raw = await _probe_capabilities(ctx, force=True)
        hermes.update(
            reachable=True,
            api_platform=str(raw.get("platform") or ""),
            model=str(raw.get("model") or "") or None,
            auth_required=bool((raw.get("auth") or {}).get("required")) if isinstance(raw.get("auth"), dict) else None,
        )
    except DashError as exc:
        hermes["error"] = exc.payload()["error"]
    return {
        "product": PRODUCT,
        "symbol": SYMBOL,
        "version": __version__,
        "profile": ctx.profile,
        "launch_profile": compat.serving_profile_name(),
        "target": ctx.target.describe(),
        "hermes": hermes,
        "compat": compat.describe(),
        "server_time": time.time(),
    }


@router.get("/capabilities")
@_guarded
async def capabilities(ctx: Ctx = Depends(ctx_dep)):
    raw = await _probe_capabilities(ctx)
    return {"profile": ctx.profile, "version": __version__, "capabilities": _derive_capabilities(raw, ctx)}


@router.get("/profiles")
@_guarded
async def profiles():
    launch = compat.serving_profile_name()
    items = [
        {
            "name": p.name,
            "is_default": p.is_default,
            "is_launch": p.name == launch,
            "model": p.model,
            "provider": p.provider,
        }
        for p in compat.list_profiles()
        if validation.PROFILE_RE.fullmatch(p.name)
    ]
    return {"launch_profile": launch, "profiles": items}


# --------------------------------------------------------------------------------------------
# Sessions
# --------------------------------------------------------------------------------------------


@router.get("/sessions")
@_guarded
async def list_sessions(
    ctx: Ctx = Depends(ctx_dep),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0, le=1_000_000),
):
    body = await ctx.client.list_sessions(limit=limit, offset=offset)
    rows = [_session(r) for r in session_rows(body)]
    return {"sessions": rows, "limit": limit, "offset": offset, "has_more": bool(body.get("has_more"))}


@router.get("/sessions/search")
@_guarded
async def search_sessions(ctx: Ctx = Depends(ctx_dep), q: str = Query(..., min_length=1, max_length=200)):
    """Title/preview search over Hermes' session listing (the API server has no full-text
    message search endpoint; see docs/compatibility.md)."""
    needle = " ".join(q.lower().split())
    matches: list[dict[str, Any]] = []
    scanned = 0
    offset = 0
    while scanned < SEARCH_MAX_SESSIONS:
        body = await ctx.client.list_sessions(limit=SEARCH_PAGE, offset=offset)
        rows = session_rows(body)
        scanned += len(rows)
        for row in rows:
            hay = f"{row.get('title') or ''}\n{row.get('preview') or ''}\n{row.get('id') or ''}".lower()
            if needle in hay:
                matches.append(_session(row))
        if not body.get("has_more") or not rows:
            break
        offset += SEARCH_PAGE
    return {"query": q, "sessions": matches[:100], "scanned": scanned, "truncated": scanned >= SEARCH_MAX_SESSIONS}


@router.post("/sessions", dependencies=[Depends(mutation_guard)])
@_guarded
async def create_session(request: Request, ctx: Ctx = Depends(ctx_dep)):
    body = await _json_body(request)
    title = validation.title(body["title"]) if body.get("title") else None
    if title == BOT_CHAT_TITLE:
        raise DashError(400, "reserved_title", "Use the Bot Chat action to open the canonical Bot Chat.")
    created = await ctx.client.create_session(title=title)
    session = _session_from(created)
    if session.get("id"):
        ctx.store.set_last_session(str(session["id"]))
    return {"session": session}


@router.get("/sessions/{session_id}")
@_guarded
async def get_session(session_id: str, ctx: Ctx = Depends(ctx_dep)):
    sid = validation.session_id(session_id)
    return {"session": _session_from(await ctx.client.get_session(sid))}


@router.patch("/sessions/{session_id}", dependencies=[Depends(mutation_guard)])
@_guarded
async def patch_session(session_id: str, request: Request, ctx: Ctx = Depends(ctx_dep)):
    sid = validation.session_id(session_id)
    body = await _json_body(request)
    fields: dict[str, Any] = {}
    unknown = set(body) - {"title", "pinned", "archived"}
    if unknown:
        raise DashError(400, "unsupported_field", "Only title, pinned and archived can be changed.")
    if "title" in body:
        new_title = validation.title(body["title"])
        if new_title == BOT_CHAT_TITLE:
            raise DashError(400, "reserved_title", "'Bot Chat' is reserved for the canonical Bot Chat.")
        fields["title"] = new_title
    for flag in ("pinned", "archived"):
        if flag in body:
            if not isinstance(body[flag], bool):
                raise DashError(400, "invalid_field", f"{flag} must be a boolean.")
            fields[flag] = body[flag]
    if not fields:
        raise DashError(400, "empty_patch", "Nothing to update.")
    return {"session": _session_from(await ctx.client.patch_session(sid, fields))}


@router.delete("/sessions/{session_id}", dependencies=[Depends(mutation_guard)])
@_guarded
async def delete_session(session_id: str, ctx: Ctx = Depends(ctx_dep)):
    sid = validation.session_id(session_id)
    session = _session_from(await ctx.client.get_session(sid))
    if session.get("is_bot_chat"):
        raise DashError(409, "bot_chat_protected", "dash will not delete the canonical Bot Chat.")
    result = await ctx.client.delete_session(sid)
    ctx.store.forget_session(sid)
    return {"deleted": bool(result.get("deleted")), "id": sid}


@router.get("/sessions/{session_id}/messages")
@_guarded
async def session_messages(
    session_id: str,
    ctx: Ctx = Depends(ctx_dep),
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0, le=1_000_000),
    order: str = Query("latest", pattern="^(latest|oldest)$"),
):
    sid = validation.session_id(session_id)
    body = await ctx.client.messages(sid, limit=limit, offset=offset, order=order)
    rows = body.get("data") if isinstance(body.get("data"), list) else []
    msgs = [m for m in (_message(r) for r in rows if isinstance(r, dict)) if m is not None]
    pagination = body.get("pagination") if isinstance(body.get("pagination"), dict) else {}
    return {
        "session_id": body.get("session_id") if isinstance(body.get("session_id"), str) else sid,
        "messages": msgs,
        "returned": int(pagination.get("returned") or len(rows)),
        "limit": limit,
        "offset": offset,
        "order": order,
    }


@router.post("/sessions/{session_id}/fork", dependencies=[Depends(mutation_guard)])
@_guarded
async def fork_session(session_id: str, request: Request, ctx: Ctx = Depends(ctx_dep)):
    sid = validation.session_id(session_id)
    body = await _json_body(request)
    title = validation.title(body["title"]) if body.get("title") else None
    if title == BOT_CHAT_TITLE:
        raise DashError(400, "reserved_title", "'Bot Chat' is reserved for the canonical Bot Chat.")
    caps = _derive_capabilities(await _probe_capabilities(ctx), ctx)
    if not caps["sessions"]["fork"]:
        raise DashError(501, "unsupported_capability", "This Hermes does not support session fork.")
    forked = _session_from(await ctx.client.fork_session(sid, title=title))
    if forked.get("id"):
        ctx.store.set_last_session(str(forked["id"]))
    return {"session": forked}


@router.get("/sessions/{session_id}/active-run")
@_guarded
async def session_active_run(session_id: str, ctx: Ctx = Depends(ctx_dep)):
    """Recover the run a previous page load started (no blind resend: only re-attach)."""
    sid = validation.session_id(session_id)
    pointer = ctx.store.active_run(sid)
    if not pointer:
        return {"run": None}
    try:
        status_body = await ctx.client.get_run(str(pointer["run_id"]))
    except DashError as exc:
        if exc.status == 404:
            ctx.store.clear_active_run(sid, str(pointer["run_id"]))
            return {"run": None}
        raise
    run = events.normalize_run_status(status_body)
    if run["terminal"]:
        ctx.store.clear_active_run(sid, run["run_id"])
    return {"run": run, "client_request_id": pointer.get("client_request_id")}


# --------------------------------------------------------------------------------------------
# UI continuity state (disposable)
# --------------------------------------------------------------------------------------------


@router.get("/state")
@_guarded
async def get_state(ctx: Ctx = Depends(ctx_dep)):
    return {"profile": ctx.profile, "last_session_id": ctx.store.last_session(), "preferences": ctx.store.preferences()}


@router.put("/state/last-session", dependencies=[Depends(mutation_guard)])
@_guarded
async def put_last_session(request: Request, ctx: Ctx = Depends(ctx_dep)):
    body = await _json_body(request)
    sid = body.get("session_id")
    ctx.store.set_last_session(validation.session_id(sid) if sid is not None else None)
    return {"last_session_id": sid}


@router.put("/preferences", dependencies=[Depends(mutation_guard)])
@_guarded
async def put_preferences(request: Request, ctx: Ctx = Depends(ctx_dep)):
    body = await _json_body(request)
    try:
        return {"preferences": ctx.store.update_preferences(body)}
    except PreferenceError as exc:
        raise DashError(400, "invalid_preference", str(exc)) from None


# --------------------------------------------------------------------------------------------
# Canonical Bot Chat
# --------------------------------------------------------------------------------------------


async def _find_bot_chat(ctx: Ctx) -> Optional[dict[str, Any]]:
    # Same lookup as `hermes peer dm` (hermes_cli/subcommands/peer.py::_find_bot_chat): exact
    # title + include_hidden, filtered client-side so an older Hermes that ignores the params
    # still cannot match a non-canonical row.
    body = await ctx.client.list_sessions(limit=200, offset=0, title=BOT_CHAT_TITLE, include_hidden=True)
    for row in session_rows(body):
        if (row.get("title") or "").strip() == BOT_CHAT_TITLE and row.get("id"):
            return _session(row)
    return None


@router.get("/bot-chat")
@_guarded
async def get_bot_chat(ctx: Ctx = Depends(ctx_dep)):
    return {"session": await _find_bot_chat(ctx)}


@router.post("/bot-chat", dependencies=[Depends(mutation_guard)])
@_guarded
async def ensure_bot_chat(ctx: Ctx = Depends(ctx_dep)):
    existing = await _find_bot_chat(ctx)
    if existing:
        return {"session": existing, "created": False}
    try:
        created = _session_from(await ctx.client.create_session(title=BOT_CHAT_TITLE))
    except DashError as exc:
        # Hermes enforces UNIQUE(title): a concurrent creator won. Re-discover, never duplicate.
        if exc.status in (400, 409):
            again = await _find_bot_chat(ctx)
            if again:
                return {"session": again, "created": False}
        raise
    return {"session": created, "created": True}


# --------------------------------------------------------------------------------------------
# Runs
# --------------------------------------------------------------------------------------------


def _idempotency_key(profile: str, session_id: str, client_request_id: str) -> str:
    digest = hashlib.sha256(f"{profile}\0{session_id}\0{client_request_id}".encode()).hexdigest()
    return f"dash-{digest[:48]}"


@router.post("/runs", dependencies=[Depends(mutation_guard)])
@_guarded
async def create_run(request: Request, ctx: Ctx = Depends(ctx_dep)):
    body = await _json_body(request, limit=MAX_JSON_BODY)
    sid = validation.session_id(body.get("session_id"))
    crid = validation.client_request_id(body.get("client_request_id"))
    images = validation.images(
        body.get("images"), max_count=ctx.settings.image_max_count, max_bytes=ctx.settings.image_max_bytes
    )
    upload_ids = body.get("uploads") or []
    if upload_ids:
        if not ctx.settings.uploads_enabled:
            raise DashError(403, "uploads_disabled", "File uploads are disabled on this server.")
        if not isinstance(upload_ids, list) or len(upload_ids) > 8:
            raise DashError(400, "invalid_uploads", "uploads must be a list of at most 8 ids.")
    text = validation.message_text(body.get("text", ""), allow_empty=bool(images or upload_ids))
    if upload_ids:
        stored = [uploads.load(str(u)) for u in upload_ids]
        text = validation.message_text(text + uploads.attachment_note(stored))
    caps = _derive_capabilities(await _probe_capabilities(ctx), ctx)
    if not caps["runs"]["submit"]:
        raise DashError(501, "unsupported_capability", "This Hermes API server does not support /v1/runs.")
    provider = model = None
    choice = body.get("model")
    if choice is not None:
        if (
            not isinstance(choice, dict)
            or not isinstance(choice.get("provider"), str)
            or not isinstance(choice.get("model"), str)
        ):
            raise DashError(400, "invalid_model", "model must be {provider, model}.")
        if not caps["hermes"]["model_options"]:
            raise DashError(501, "unsupported_capability", "This Hermes does not expose model options.")
        options = await _model_choices(ctx)
        allowed = any(
            p["provider"] == choice["provider"] and choice["model"] in p["models"] for p in options["providers"]
        )
        if not allowed:
            raise DashError(400, "unknown_model", "That provider/model is not offered by this Hermes profile.")
        provider, model = choice["provider"], choice["model"]
    # Busy guard: one dash-submitted run per session at a time (Hermes' own lock is per agent).
    pointer = ctx.store.active_run(sid)
    if pointer and pointer.get("client_request_id") != crid:
        try:
            current = events.normalize_run_status(await ctx.client.get_run(str(pointer["run_id"])))
        except DashError as exc:
            if exc.status != 404:
                raise
            current = {"terminal": True}
        if not current.get("terminal"):
            raise DashError(409, "run_in_progress", "A run is already active in this session.")
        ctx.store.clear_active_run(sid)
    if images:
        content: Any = ([{"type": "text", "text": text}] if text.strip() else []) + [
            {"type": "image_url", "image_url": {"url": img.data_url}} for img in images
        ]
    else:
        content = text
    result, replayed = await ctx.client.create_run(
        session_id=sid,
        content=content,
        idempotency_key=_idempotency_key(ctx.profile, sid, crid),
        provider=provider,
        model=model,
    )
    run_id = validation.run_id(result.get("run_id"))
    ctx.store.set_active_run(sid, run_id, crid)
    ctx.store.set_last_session(sid)
    return JSONResponse(
        {"run_id": run_id, "status": str(result.get("status") or "started"), "replayed": replayed, "session_id": sid},
        status_code=202,
    )


@router.get("/runs/{run_id}")
@_guarded
async def get_run(run_id: str, ctx: Ctx = Depends(ctx_dep)):
    rid = validation.run_id(run_id)
    run = events.normalize_run_status(await ctx.client.get_run(rid))
    if run["terminal"] and run.get("session_id"):
        ctx.store.clear_active_run(run["session_id"], rid)
    return {"run": run}


@router.post("/runs/{run_id}/stop", dependencies=[Depends(mutation_guard)])
@_guarded
async def stop_run(run_id: str, ctx: Ctx = Depends(ctx_dep)):
    rid = validation.run_id(run_id)
    body = await ctx.client.stop_run(rid)
    return {"run_id": rid, "status": str(body.get("status") or "stopping")}


@router.post("/runs/{run_id}/approval", dependencies=[Depends(mutation_guard)])
@_guarded
async def run_approval(run_id: str, request: Request, ctx: Ctx = Depends(ctx_dep)):
    """Forward an explicit human decision. dash never answers an approval on its own."""
    rid = validation.run_id(run_id)
    body = await _json_body(request)
    choice = validation.approval_choice(body.get("choice"))
    request_id = validation.approval_request_id(body.get("request_id"))
    result = await ctx.client.resolve_approval(rid, choice=choice, request_id=request_id)
    return {"run_id": rid, "choice": result.get("choice", choice), "resolved": result.get("resolved")}


def _last_event_id(request: Request, query_value: Optional[int]) -> Optional[int]:
    header = request.headers.get("last-event-id")
    raw = header if header not in (None, "") else query_value
    if raw is None:
        return None
    try:
        value = int(str(raw).strip())
    except ValueError:
        return None
    return value if value >= -1 else None


@router.get("/runs/{run_id}/events")
async def run_events(
    run_id: str,
    request: Request,
    last_seq: Optional[int] = Query(None, ge=-1),
    profile: Optional[str] = Query(None, max_length=64),
):
    """Proxy Hermes' run SSE stream, normalised, without buffering.

    Everything that depends on the Dashboard's per-request profile scope (target, credential,
    store directory) is resolved *before* the streaming body starts. A browser disconnect
    only closes this subscription; the Hermes run keeps going and can be re-attached with
    ``Last-Event-ID`` / ``last_seq``.
    """
    try:
        rid = validation.run_id(run_id)
        ctx = _resolve_ctx(profile)
    except (DashError, validation.ValidationError) as exc:
        return _err(exc)
    resume = _last_event_id(request, last_seq)
    client, store = ctx.client, ctx.store

    async def body() -> AsyncIterator[bytes]:
        # Flush headers through proxies immediately and set the browser retry hint.
        yield b": dash stream open\nretry: 2000\n\n"
        try:
            async for event in client.stream_run_events(rid, last_event_id=resume):
                if await request.is_disconnected():
                    return
                etype = event.get("type")
                if etype == "keepalive":
                    yield b": keepalive\n\n"
                    continue
                if etype == "stream_closed":
                    yield events.encode({"type": "stream_end", "run_id": rid, "seq": None})
                    return
                if etype == "run" and event.get("status") in events.TERMINAL_RUN_STATUSES:
                    await asyncio.to_thread(_clear_run_pointer, store, rid)
                yield events.encode(event)
        except DashError as exc:
            err = exc.payload()["error"]
            yield events.encode({"type": "stream_error", "run_id": rid, "seq": None, **err, "status": exc.status})
        except asyncio.CancelledError:  # client went away; Hermes run continues
            raise

    return StreamingResponse(
        body(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",  # nginx: do not buffer SSE
            "Content-Encoding": "identity",
        },
    )


def _clear_run_pointer(store: StateStore, run_id: str) -> None:
    for sid, entry in store.snapshot()["active_runs"].items():
        if entry.get("run_id") == run_id:
            store.clear_active_run(sid, run_id)


# --------------------------------------------------------------------------------------------
# Read-only Hermes context (only what the API server exposes)
# --------------------------------------------------------------------------------------------


@router.get("/hermes/models")
@_guarded
async def hermes_models(ctx: Ctx = Depends(ctx_dep)):
    raw = await ctx.client.model_options()
    return {"profile": ctx.profile, "model_options": _bounded(raw)}


_model_cache: dict[str, tuple] = {}
MODEL_CHOICES_TTL = 60.0


async def _model_choices(ctx: Ctx) -> dict[str, Any]:
    """Selectable models = providers Hermes reports as authenticated or current, with the
    model ids Hermes lists for them. Built server-side; the browser can only pick from it."""
    key = f"{ctx.profile}|{ctx.target.base_url}"
    cached = _model_cache.get(key)
    if cached and time.monotonic() - cached[0] < MODEL_CHOICES_TTL:
        return cached[1]
    raw = await ctx.client.model_options()
    providers = raw.get("providers") if isinstance(raw.get("providers"), list) else []
    out = []
    for prov in providers:
        if not isinstance(prov, dict) or not (prov.get("authenticated") or prov.get("is_current")):
            continue
        slug = prov.get("slug")
        models = [m for m in (prov.get("models") or []) if isinstance(m, str) and 0 < len(m) <= 200][:300]
        if not isinstance(slug, str) or not slug or not models:
            continue
        out.append(
            {
                "provider": slug[:100],
                "name": str(prov.get("name") or slug)[:100],
                "current": bool(prov.get("is_current")),
                "models": models,
            }
        )
    result = {
        "current": {
            "provider": raw.get("provider") if isinstance(raw.get("provider"), str) else None,
            "model": raw.get("model") if isinstance(raw.get("model"), str) else None,
        },
        "providers": out,
    }
    _model_cache[key] = (time.monotonic(), result)
    return result


@router.get("/models/choices")
@_guarded
async def model_choices(ctx: Ctx = Depends(ctx_dep)):
    caps = _derive_capabilities(await _probe_capabilities(ctx), ctx)
    if not caps["hermes"]["model_options"]:
        return {"available": False, "current": None, "providers": []}
    return {"available": True, **(await _model_choices(ctx))}


@router.get("/hermes/skills")
@_guarded
async def hermes_skills(ctx: Ctx = Depends(ctx_dep)):
    raw = await ctx.client.skills()
    data = raw.get("data") if isinstance(raw.get("data"), list) else []
    skills = [
        {k: s.get(k) for k in ("name", "description", "category", "enabled") if k in s}
        for s in data
        if isinstance(s, dict)
    ][:500]
    return {"profile": ctx.profile, "skills": skills}


@router.get("/hermes/toolsets")
@_guarded
async def hermes_toolsets(ctx: Ctx = Depends(ctx_dep)):
    raw = await ctx.client.toolsets()
    data = raw.get("data") if isinstance(raw.get("data"), list) else []
    toolsets = [
        {
            "name": t.get("name"),
            "label": t.get("label"),
            "description": t.get("description"),
            "enabled": bool(t.get("enabled")),
            "configured": bool(t.get("configured")),
            "tools": [x for x in (t.get("tools") or []) if isinstance(x, str)][:200],
        }
        for t in data
        if isinstance(t, dict)
    ][:200]
    return {"profile": ctx.profile, "toolsets": toolsets}


def _bounded(value: Any, depth: int = 0) -> Any:
    """Defensive copy of a JSON value with depth/size bounds (no secrets are expected here,
    but strings are still redacted)."""
    if depth > 6:
        return None
    if isinstance(value, dict):
        return {str(k)[:100]: _bounded(v, depth + 1) for k, v in list(value.items())[:200]}
    if isinstance(value, list):
        return [_bounded(v, depth + 1) for v in value[:500]]
    if isinstance(value, str):
        return redact(value, limit=2000)
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return str(value)[:200]


# --------------------------------------------------------------------------------------------
# Optional uploads (disabled by default)
# --------------------------------------------------------------------------------------------


@router.post("/uploads", dependencies=[Depends(mutation_guard)])
@_guarded
async def create_upload(request: Request, ctx: Ctx = Depends(ctx_dep)):
    if not ctx.settings.uploads_enabled:
        raise DashError(403, "uploads_disabled", "File uploads are disabled on this server.")
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > ctx.settings.upload_max_bytes:
        raise DashError(413, "upload_too_large", f"File exceeds {ctx.settings.upload_max_bytes} bytes.")
    filename = unquote(request.headers.get("x-dash-filename", ""))[:512]
    if not filename:
        raise DashError(400, "missing_filename", "X-Dash-Filename header required.")
    stored = await uploads.save(request.stream(), filename=filename, max_bytes=ctx.settings.upload_max_bytes)
    return JSONResponse({"upload": stored.public()}, status_code=201)


@router.delete("/uploads/{upload_id}", dependencies=[Depends(mutation_guard)])
@_guarded
async def delete_upload(upload_id: str, ctx: Ctx = Depends(ctx_dep)):
    if not ctx.settings.uploads_enabled:
        raise DashError(403, "uploads_disabled", "File uploads are disabled on this server.")
    uploads.delete(upload_id)
    return {"deleted": True}
