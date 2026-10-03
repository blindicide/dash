"""Unit-test fixtures. The fake below mirrors the Hermes v0.21.5 API-server wire shapes
(gateway/platforms/api_server.py, api_server_runs.py) closely enough to test dash's own
logic. It is NOT integration evidence — see scripts/integration/ for real-Hermes runs."""

from __future__ import annotations

import json
import uuid
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from dash_bff import compat, hermes_client
from dash_bff import routes as routes_mod

API_KEY = "test-api-key-0123456789abcdef"
BASE = "http://127.0.0.1:8642"


class FakeHermes:
    def __init__(self) -> None:
        self.sessions: dict[str, dict[str, Any]] = {}
        self.messages: dict[str, list[dict[str, Any]]] = {}
        self.runs: dict[str, dict[str, Any]] = {}
        self.idem: dict[str, str] = {}
        self.run_events: dict[str, list[dict[str, Any]]] = {}
        self.requests: list[httpx.Request] = []
        self.approvals: list[dict[str, Any]] = []
        self.stops: list[str] = []
        self.fail_auth = False
        self.unreachable = False
        self.features_override: dict[str, Any] = {}

    # -- helpers ---------------------------------------------------------------------------
    def add_session(self, sid: str, title: str | None = None, hidden: bool = False) -> None:
        self.sessions[sid] = {"id": sid, "title": title, "source": "cli", "hidden": hidden, "message_count": 0}
        self.messages.setdefault(sid, [])

    def capabilities(self) -> dict[str, Any]:
        features = {
            "run_submission": True,
            "run_status": True,
            "run_events_sse": True,
            "run_stop": True,
            "run_approval_response": True,
            "approval_events": True,
            "tool_progress_events": True,
            "session_resources": True,
            "session_fork": True,
            "model_options": True,
            "skills_api": True,
            "reasoning_streaming": True,
            "run_steer": True,
            "runs_idempotency": {"supported": True, "durable": True, "retention_seconds": 86400},
        }
        features.update(self.features_override)
        names = [
            "sessions",
            "session_create",
            "session",
            "session_update",
            "session_delete",
            "session_messages",
            "session_fork",
            "runs",
            "run_status",
            "run_events",
            "run_stop",
            "run_approval",
            "model_options",
            "skills",
            "toolsets",
        ]
        return {
            "object": "hermes.api_server.capabilities",
            "platform": "hermes-agent",
            "model": "hermes-agent",
            "auth": {"type": "bearer", "required": True},
            "features": features,
            "endpoints": {n: {"method": "GET", "path": "/x"} for n in names},
        }

    # -- transport -------------------------------------------------------------------------
    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.unreachable:
            raise httpx.ConnectError("refused", request=request)
        if self.fail_auth or request.headers.get("authorization") != f"Bearer {API_KEY}":
            return httpx.Response(
                401,
                json={"error": {"message": "Invalid gateway API key (API_SERVER_KEY)", "code": "gateway_auth_failed"}},
            )
        path = request.url.path
        method = request.method
        if path.startswith("/p/"):
            path = "/" + path.split("/", 3)[3]
        if path == "/v1/capabilities":
            return httpx.Response(200, json=self.capabilities())
        if path == "/api/sessions" and method == "GET":
            title = request.url.params.get("title")
            include_hidden = request.url.params.get("include_hidden") == "1"
            rows = [s for s in self.sessions.values() if (include_hidden and title) or not s.get("hidden")]
            if title:
                rows = [s for s in rows if (s.get("title") or "") == title]
            limit = int(request.url.params.get("limit", 50))
            offset = int(request.url.params.get("offset", 0))
            page = rows[offset : offset + limit]
            return httpx.Response(
                200,
                json={
                    "object": "list",
                    "data": page,
                    "limit": limit,
                    "offset": offset,
                    "has_more": len(rows) > offset + limit,
                },
            )
        if path == "/api/sessions" and method == "POST":
            body = json.loads(request.content or b"{}")
            title = body.get("title")
            if title and any(s.get("title") == title for s in self.sessions.values()):
                return httpx.Response(400, json={"error": {"message": "Title already in use", "code": "invalid_title"}})
            sid = f"api_{uuid.uuid4().hex[:8]}"
            self.add_session(sid, title)
            return httpx.Response(201, json={"object": "hermes.session", "session": self.sessions[sid]})
        if path.startswith("/api/sessions/"):
            parts = path.split("/")
            sid = parts[3]
            if sid not in self.sessions:
                return httpx.Response(
                    404, json={"error": {"message": f"Session not found: {sid}", "code": "session_not_found"}}
                )
            tail = parts[4] if len(parts) > 4 else ""
            if tail == "" and method == "GET":
                return httpx.Response(200, json={"object": "hermes.session", "session": self.sessions[sid]})
            if tail == "" and method == "PATCH":
                body = json.loads(request.content)
                self.sessions[sid].update(body)
                return httpx.Response(200, json={"object": "hermes.session", "session": self.sessions[sid]})
            if tail == "" and method == "DELETE":
                del self.sessions[sid]
                return httpx.Response(200, json={"object": "hermes.session.deleted", "id": sid, "deleted": True})
            if tail == "messages":
                return httpx.Response(
                    200,
                    json={
                        "object": "list",
                        "session_id": sid,
                        "data": self.messages[sid],
                        "pagination": {"returned": len(self.messages[sid])},
                    },
                )
            if tail == "fork":
                fid = f"api_{uuid.uuid4().hex[:8]}"
                self.add_session(fid, f"{self.sessions[sid].get('title') or 'fork'} fork")
                self.sessions[fid]["parent_session_id"] = sid
                return httpx.Response(201, json={"object": "hermes.session", "session": self.sessions[fid]})
        if path == "/v1/runs" and method == "POST":
            key = request.headers.get("idempotency-key", "")
            body = json.loads(request.content)
            if key and key in self.idem:
                rid = self.idem[key]
                return httpx.Response(
                    202,
                    json={"run_id": rid, "status": self.runs[rid]["status"], "replayed": True},
                    headers={"Idempotency-Replayed": "true"},
                )
            rid = f"run_{uuid.uuid4().hex}"
            self.runs[rid] = {
                "object": "hermes.run",
                "run_id": rid,
                "status": "running",
                "session_id": body.get("session_id"),
                "input": body.get("input"),
            }
            if key:
                self.idem[key] = rid
            self.run_events[rid] = [
                {"event": "message.delta", "run_id": rid, "timestamp": 1.0, "delta": "Hel"},
                {"event": "tool.started", "run_id": rid, "timestamp": 2.0, "tool": "terminal", "preview": "ls"},
                {
                    "event": "tool.completed",
                    "run_id": rid,
                    "timestamp": 3.0,
                    "tool": "terminal",
                    "duration": 0.5,
                    "error": True,
                    "preview": "token=supersecretvalue123",
                },
                {"event": "message.delta", "run_id": rid, "timestamp": 4.0, "delta": "lo"},
                {
                    "event": "run.completed",
                    "run_id": rid,
                    "timestamp": 5.0,
                    "output": "Hello",
                    "completed": True,
                    "usage": {"input_tokens": 3, "output_tokens": 2, "total_tokens": 5},
                },
            ]
            return httpx.Response(202, json={"run_id": rid, "status": "started", "replayed": False})
        if path.startswith("/v1/runs/"):
            parts = path.split("/")
            rid = parts[3]
            if rid not in self.runs:
                return httpx.Response(
                    404, json={"error": {"message": f"Run not found: {rid}", "code": "run_not_found"}}
                )
            tail = parts[4] if len(parts) > 4 else ""
            if tail == "" and method == "GET":
                return httpx.Response(200, json=self.runs[rid])
            if tail == "stop":
                self.stops.append(rid)
                self.runs[rid]["status"] = "stopping"
                return httpx.Response(200, json={"run_id": rid, "status": "stopping"})
            if tail == "approval":
                body = json.loads(request.content)
                self.approvals.append(body)
                return httpx.Response(
                    200,
                    json={
                        "object": "hermes.run.approval_response",
                        "run_id": rid,
                        "choice": body["choice"],
                        "resolved": 1,
                    },
                )
            if tail == "events":
                last = request.headers.get("last-event-id")
                start = int(last) + 1 if last is not None else 0
                frames = [": open\n\n"]
                for seq, ev in enumerate(self.run_events[rid]):
                    if seq >= start:
                        frames.append(f"id: {seq}\ndata: {json.dumps({**ev, 'seq': seq})}\n\n")
                frames.append(": stream closed\n\n")
                self.runs[rid]["status"] = "completed"
                return httpx.Response(
                    200, content="".join(frames).encode(), headers={"Content-Type": "text/event-stream"}
                )
        if path == "/v1/skills":
            return httpx.Response(
                200,
                json={
                    "object": "list",
                    "data": [{"name": "plan", "description": "Plan", "category": "x", "secret_field": "nope"}],
                },
            )
        if path == "/v1/toolsets":
            return httpx.Response(
                200,
                json={
                    "object": "list",
                    "data": [
                        {
                            "name": "terminal",
                            "label": "Terminal",
                            "enabled": True,
                            "configured": True,
                            "tools": ["terminal"],
                        }
                    ],
                },
            )
        if path == "/api/model/options":
            return httpx.Response(200, json={"current": {"model": "m"}, "options": []})
        return httpx.Response(404, json={"error": {"message": "nope"}})


@pytest.fixture
def fake() -> FakeHermes:
    return FakeHermes()


@pytest.fixture
def app(fake: FakeHermes, monkeypatch: pytest.MonkeyPatch, tmp_path) -> FastAPI:
    monkeypatch.setenv("DASH_DATA_DIR", str(tmp_path / "plugin-data"))
    for var in ("DASH_HERMES_API_URL", "DASH_UPLOADS_ENABLED", "DASH_TRUSTED_ORIGINS"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(compat, "get_secret", lambda name: API_KEY if name == "API_SERVER_KEY" else "")
    monkeypatch.setattr(compat, "serving_profile_name", lambda: "default")
    monkeypatch.setattr(compat, "api_server_settings", lambda: ("127.0.0.1", 8642, None))
    monkeypatch.setattr(
        compat,
        "list_profiles",
        lambda: [
            compat.ProfileSummary("default", True, "m"),
            compat.ProfileSummary("work", False, "m2"),
            compat.ProfileSummary("../evil", False),
        ],
    )
    transport = httpx.MockTransport(fake.handler)

    def shared(timeout: float) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=transport, timeout=timeout)

    monkeypatch.setattr(hermes_client, "_shared_client", shared)
    routes_mod._cap_cache.clear()
    application = FastAPI()
    application.include_router(routes_mod.router, prefix="/api/plugins/dash")
    return application


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    return TestClient(app, base_url="http://127.0.0.1:9119")


MUT = {"X-Dash-Request": "1", "Content-Type": "application/json"}
