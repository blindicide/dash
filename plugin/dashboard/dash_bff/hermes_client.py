"""The only module that talks to the Hermes API server.

One shared ``httpx.AsyncClient`` (connection pooling, HTTP keep-alive) serves every request;
per-call target/credential come from :class:`~.config.HermesTarget`, which is resolved
server-side. Every Hermes endpoint used here is listed in docs/compatibility.md with the
source location that defines it.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from typing import Any, Optional

import httpx

from .config import HermesTarget
from .errors import DashError, from_hermes_response, hermes_unavailable
from .events import SSEParser, parse_frame
from .version import __version__

_log = logging.getLogger("dash.hermes")

_client: Optional[httpx.AsyncClient] = None
_client_loop: Optional[asyncio.AbstractEventLoop] = None

USER_AGENT = f"hermes-dash/{__version__}"
# Hermes writes ``: keepalive`` every 10 s on run streams; 45 s of silence means a dead peer.
STREAM_READ_TIMEOUT = 45.0


def _shared_client(timeout: float) -> httpx.AsyncClient:
    """Lazily create the pooled client, re-creating it if the event loop changed (tests)."""
    global _client, _client_loop
    loop = asyncio.get_running_loop()
    if _client is None or _client.is_closed or _client_loop is not loop:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout, connect=5.0),
            limits=httpx.Limits(max_connections=64, max_keepalive_connections=16),
            follow_redirects=False,
            headers={"User-Agent": USER_AGENT},
            trust_env=False,  # never route agent traffic through ambient proxy env vars
        )
        _client_loop = loop
    return _client


async def close_shared_client() -> None:
    global _client
    if _client is not None and not _client.is_closed:
        await _client.aclose()
    _client = None


class HermesClient:
    def __init__(self, target: HermesTarget, *, timeout: float = 30.0, http: Optional[httpx.AsyncClient] = None):
        self.target = target
        self._timeout = timeout
        self._http = http

    @property
    def http(self) -> httpx.AsyncClient:
        return self._http or _shared_client(self._timeout)

    def _headers(self, extra: Optional[dict[str, str]] = None) -> dict[str, str]:
        headers = {"Accept": "application/json"}
        if self.target.api_key:
            headers["Authorization"] = f"Bearer {self.target.api_key}"
        if extra:
            headers.update(extra)
        return headers

    def _url(self, path: str) -> str:
        return f"{self.target.base_url}{path}"

    async def request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: Optional[dict[str, Any]] = None,
        headers: Optional[dict[str, str]] = None,
        return_headers: bool = False,
    ) -> Any:
        try:
            response = await self.http.request(
                method, self._url(path), json=json, params=params, headers=self._headers(headers)
            )
        except httpx.TimeoutException:
            raise hermes_unavailable("timed out") from None
        except httpx.HTTPError as exc:
            raise hermes_unavailable(type(exc).__name__) from None
        try:
            body = response.json() if response.content else {}
        except ValueError:
            body = response.text[:400]
        if response.status_code >= 400:
            raise from_hermes_response(response.status_code, body)
        if response.status_code in (301, 302, 303, 307, 308):
            raise DashError(502, "hermes_redirect", "Hermes API answered with a redirect; refusing to follow.")
        if return_headers:
            return body, response.headers
        return body

    # -- discovery -------------------------------------------------------------------------

    async def capabilities(self) -> dict[str, Any]:
        return await self.request("GET", "/v1/capabilities")

    async def health(self) -> dict[str, Any]:
        return await self.request("GET", "/health")

    async def model_options(self) -> dict[str, Any]:
        return await self.request("GET", "/api/model/options")

    async def models(self) -> dict[str, Any]:
        return await self.request("GET", "/v1/models")

    async def skills(self) -> dict[str, Any]:
        return await self.request("GET", "/v1/skills")

    async def toolsets(self) -> dict[str, Any]:
        return await self.request("GET", "/v1/toolsets")

    # -- sessions --------------------------------------------------------------------------

    async def list_sessions(
        self, *, limit: int, offset: int, title: Optional[str] = None, include_hidden: bool = False
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"limit": limit, "offset": offset}
        if title:
            params["title"] = title
            if include_hidden:
                params["include_hidden"] = "1"
        return await self.request("GET", "/api/sessions", params=params)

    async def get_session(self, session_id: str) -> dict[str, Any]:
        return await self.request("GET", f"/api/sessions/{session_id}")

    async def create_session(self, *, title: Optional[str] = None) -> dict[str, Any]:
        body: dict[str, Any] = {}
        if title:
            body["title"] = title
        return await self.request("POST", "/api/sessions", json=body)

    async def patch_session(self, session_id: str, fields: dict[str, Any]) -> dict[str, Any]:
        return await self.request("PATCH", f"/api/sessions/{session_id}", json=fields)

    async def delete_session(self, session_id: str) -> dict[str, Any]:
        return await self.request("DELETE", f"/api/sessions/{session_id}")

    async def messages(self, session_id: str, *, limit: int, offset: int, order: str) -> dict[str, Any]:
        return await self.request(
            "GET", f"/api/sessions/{session_id}/messages", params={"limit": limit, "offset": offset, "order": order}
        )

    async def fork_session(self, session_id: str, *, title: Optional[str] = None) -> dict[str, Any]:
        body: dict[str, Any] = {}
        if title:
            body["title"] = title
        return await self.request("POST", f"/api/sessions/{session_id}/fork", json=body)

    # -- runs ------------------------------------------------------------------------------

    async def create_run(self, *, session_id: str, content: Any, idempotency_key: str) -> tuple[dict[str, Any], bool]:
        """``POST /v1/runs``; returns ``(body, replayed)``."""
        if isinstance(content, str):
            run_input: Any = content
        else:
            run_input = [{"role": "user", "content": content}]
        body, headers = await self.request(
            "POST",
            "/v1/runs",
            json={"input": run_input, "session_id": session_id},
            headers={"Idempotency-Key": idempotency_key, "Content-Type": "application/json"},
            return_headers=True,
        )
        replayed = str(headers.get("Idempotency-Replayed", "")).lower() == "true" or bool(body.get("replayed"))
        return body, replayed

    async def get_run(self, run_id: str) -> dict[str, Any]:
        return await self.request("GET", f"/v1/runs/{run_id}")

    async def stop_run(self, run_id: str) -> dict[str, Any]:
        return await self.request("POST", f"/v1/runs/{run_id}/stop", json={})

    async def resolve_approval(self, run_id: str, *, choice: str, request_id: Optional[str]) -> dict[str, Any]:
        body: dict[str, Any] = {"choice": choice}
        if request_id:
            body["request_id"] = request_id
        return await self.request("POST", f"/v1/runs/{run_id}/approval", json=body)

    async def stream_run_events(self, run_id: str, *, last_event_id: Optional[int]) -> AsyncIterator[dict[str, Any]]:
        """Yield normalised events; yields ``{"type": "stream_closed"}`` on Hermes' terminal
        comment. Network/timeout failures surface as DashError so the caller can tell the
        browser to reconnect (the run itself keeps going inside Hermes)."""
        headers = self._headers({"Accept": "text/event-stream"})
        if last_event_id is not None:
            headers["Last-Event-ID"] = str(last_event_id)
        timeout = httpx.Timeout(self._timeout, connect=5.0, read=STREAM_READ_TIMEOUT)
        try:
            async with self.http.stream(
                "GET", self._url(f"/v1/runs/{run_id}/events"), headers=headers, timeout=timeout
            ) as response:
                if response.status_code >= 400:
                    raw = await response.aread()
                    try:
                        import json as _json

                        body: Any = _json.loads(raw) if raw else {}
                    except ValueError:
                        body = raw[:400].decode("utf-8", "replace")
                    raise from_hermes_response(response.status_code, body)
                parser = SSEParser()
                async for chunk in response.aiter_text():
                    for frame in parser.feed(chunk):
                        if frame.comment is not None:
                            if frame.comment.startswith("stream closed"):
                                yield {"type": "stream_closed", "run_id": run_id}
                                return
                            yield {"type": "keepalive"}
                            continue
                        event = parse_frame(frame)
                        if event is not None:
                            yield event
        except httpx.TimeoutException:
            raise hermes_unavailable("event stream timed out") from None
        except httpx.HTTPError as exc:
            raise hermes_unavailable(type(exc).__name__) from None


def session_rows(listing: dict[str, Any]) -> list[dict[str, Any]]:
    data = listing.get("data") if isinstance(listing, dict) else None
    return [row for row in data if isinstance(row, dict)] if isinstance(data, list) else []
