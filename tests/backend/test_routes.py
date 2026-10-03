"""Route-level tests: security boundaries, run state transitions, Bot Chat, continuity."""

from __future__ import annotations

import base64
import json
import uuid

from conftest import API_KEY, MUT

P = "/api/plugins/dash"
PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32).decode()


def _new_session(client, fake, title=None):
    fake.add_session("20261003_101010_abc123", title)
    return "20261003_101010_abc123"


# -- security boundaries --------------------------------------------------------------------


def test_mutation_requires_dash_header(client):
    r = client.post(f"{P}/sessions", json={})
    assert r.status_code == 403
    assert r.json()["detail"]["error"]["code"] == "missing_dash_header"


def test_cross_origin_mutation_refused(client):
    r = client.post(f"{P}/sessions", json={}, headers={**MUT, "Origin": "https://evil.example"})
    assert r.status_code == 403
    assert r.json()["detail"]["error"]["code"] == "cross_origin"


def test_same_origin_mutation_allowed(client):
    r = client.post(f"{P}/sessions", json={"title": "hello"}, headers={**MUT, "Origin": "http://127.0.0.1:9119"})
    assert r.status_code == 200, r.text


def test_invalid_profile_rejected(client):
    r = client.get(f"{P}/sessions", params={"profile": "../etc"})
    assert r.status_code == 400
    assert r.json()["detail"]["error"]["code"] == "invalid_profile"


def test_profiles_filter_invalid_names(client):
    names = [p["name"] for p in client.get(f"{P}/profiles").json()["profiles"]]
    assert names == ["default", "work"]


def test_named_profile_uses_multiplex_prefix(client, fake):
    client.get(f"{P}/status")  # caches the launch address
    client.get(f"{P}/sessions", params={"profile": "work"})
    assert any(req.url.path == "/p/work/api/sessions" for req in fake.requests)


def test_api_key_never_reaches_browser(client, fake):
    sid = _new_session(client, fake)
    bodies = [
        client.get(f"{P}/status").text,
        client.get(f"{P}/capabilities").text,
        client.get(f"{P}/sessions").text,
        client.get(f"{P}/sessions/{sid}").text,
    ]
    for body in bodies:
        assert API_KEY not in body
    # ...but it is sent upstream as a bearer credential.
    assert all(req.headers["authorization"] == f"Bearer {API_KEY}" for req in fake.requests)


def test_hermes_401_is_not_forwarded_as_401(client, fake):
    fake.fail_auth = True
    r = client.get(f"{P}/sessions")
    assert r.status_code == 502
    assert r.json()["error"]["code"] == "hermes_auth_failed"


def test_hermes_unreachable(client, fake):
    fake.unreachable = True
    r = client.get(f"{P}/sessions")
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "hermes_unavailable"
    status = client.get(f"{P}/status").json()
    assert status["hermes"]["reachable"] is False


def test_session_id_traversal_rejected(client):
    r = client.get(f"{P}/sessions/..%2F..%2Fetc/messages")
    assert r.status_code in (400, 404)
    r = client.get(f"{P}/sessions/a..b")
    assert r.status_code == 400


def test_json_content_type_required(client, fake):
    sid = _new_session(client, fake)
    r = client.patch(
        f"{P}/sessions/{sid}", content="title=x", headers={"X-Dash-Request": "1", "Content-Type": "text/plain"}
    )
    assert r.status_code == 415


def test_patch_rejects_unknown_fields_and_reserved_title(client, fake):
    sid = _new_session(client, fake)
    assert client.patch(f"{P}/sessions/{sid}", json={"hidden": True}, headers=MUT).status_code == 400
    r = client.patch(f"{P}/sessions/{sid}", json={"title": "Bot Chat"}, headers=MUT)
    assert r.json()["error"]["code"] == "reserved_title"
    r = client.patch(f"{P}/sessions/{sid}", json={"title": "  Renamed   chat "}, headers=MUT)
    assert r.json()["session"]["title"] == "Renamed chat"


# -- sessions, continuity -------------------------------------------------------------------


def test_create_session_sets_last_session(client):
    sid = client.post(f"{P}/sessions", json={}, headers=MUT).json()["session"]["id"]
    assert client.get(f"{P}/state").json()["last_session_id"] == sid


def test_last_session_round_trip(client):
    client.put(f"{P}/state/last-session", json={"session_id": "s1"}, headers=MUT)
    state_default = client.get(f"{P}/state").json()
    assert state_default["last_session_id"] == "s1"


def test_messages_are_allowlisted_and_hidden_rows_dropped(client, fake):
    sid = _new_session(client, fake)
    fake.messages[sid] = [
        {"id": 1, "role": "user", "content": "hi", "timestamp": 1},
        {"id": 2, "role": "assistant", "content": "", "display_kind": "hidden"},
        {
            "id": 3,
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {"id": "c1", "function": {"name": "terminal", "arguments": '{"cmd": "echo api_key=abc123secret"}'}}
            ],
        },
        {"id": 4, "role": "tool", "content": "Bearer abcdefghijklmnop", "tool_call_id": "c1", "tool_name": "terminal"},
        {
            "id": 5,
            "role": "user",
            "content": [
                {"type": "text", "text": "look"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
            ],
            "secret": "x",
        },
    ]
    msgs = client.get(f"{P}/sessions/{sid}/messages").json()["messages"]
    assert [m["id"] for m in msgs] == [1, 3, 4, 5]
    assert "abc123secret" not in json.dumps(msgs)
    assert "abcdefghijklmnop" not in json.dumps(msgs)
    assert msgs[3]["content"][1] == {"type": "image", "url": "data:image/png;base64,AAAA"}
    assert "secret" not in msgs[3]


def test_fork_and_delete(client, fake):
    sid = _new_session(client, fake, "topic")
    fork = client.post(f"{P}/sessions/{sid}/fork", json={}, headers=MUT).json()["session"]
    assert fork["parent_session_id"] == sid
    r = client.delete(f"{P}/sessions/{fork['id']}", headers={"X-Dash-Request": "1"})
    assert r.json()["deleted"] is True


def test_search_matches_title_and_preview(client, fake):
    fake.add_session("s_a", "Deploy notes")
    fake.add_session("s_b", "Groceries")
    fake.sessions["s_b"]["preview"] = "remember to deploy the cake"
    found = {s["id"] for s in client.get(f"{P}/sessions/search", params={"q": "DEPLOY"}).json()["sessions"]}
    assert found == {"s_a", "s_b"}


# -- Bot Chat -------------------------------------------------------------------------------


def test_bot_chat_discovers_hidden_canonical(client, fake):
    fake.add_session("botchat_1", "Bot Chat", hidden=True)
    r = client.post(f"{P}/bot-chat", headers={"X-Dash-Request": "1"}).json()
    assert r == {"session": r["session"], "created": False}
    assert r["session"]["id"] == "botchat_1" and r["session"]["is_bot_chat"]
    assert sum(1 for s in fake.sessions.values() if s.get("title") == "Bot Chat") == 1


def test_bot_chat_created_only_when_absent(client, fake):
    first = client.post(f"{P}/bot-chat", headers={"X-Dash-Request": "1"}).json()
    second = client.post(f"{P}/bot-chat", headers={"X-Dash-Request": "1"}).json()
    assert first["created"] is True and second["created"] is False
    assert first["session"]["id"] == second["session"]["id"]


def test_bot_chat_cannot_be_deleted_or_created_as_plain_session(client, fake):
    fake.add_session("botchat_1", "Bot Chat")
    assert client.delete(f"{P}/sessions/botchat_1", headers={"X-Dash-Request": "1"}).status_code == 409
    assert client.post(f"{P}/sessions", json={"title": "Bot Chat"}, headers=MUT).status_code == 400


# -- runs -----------------------------------------------------------------------------------


def _send(client, sid, crid=None, **extra):
    body = {"session_id": sid, "text": "hello", "client_request_id": crid or str(uuid.uuid4()), **extra}
    return client.post(f"{P}/runs", json=body, headers=MUT)


def test_run_submission_is_idempotent(client, fake):
    sid = _new_session(client, fake)
    crid = str(uuid.uuid4())
    a = _send(client, sid, crid)
    b = _send(client, sid, crid)
    assert a.status_code == b.status_code == 202
    assert a.json()["run_id"] == b.json()["run_id"]
    assert b.json()["replayed"] is True
    keys = {r.headers.get("idempotency-key") for r in fake.requests if r.url.path == "/v1/runs"}
    assert len(keys) == 1 and next(iter(keys)).startswith("dash-")


def test_busy_session_refuses_second_run(client, fake):
    sid = _new_session(client, fake)
    assert _send(client, sid).status_code == 202
    r = _send(client, sid)
    assert r.status_code == 409 and r.json()["error"]["code"] == "run_in_progress"


def test_active_run_recovery_and_terminal_clear(client, fake):
    sid = _new_session(client, fake)
    rid = _send(client, sid).json()["run_id"]
    recovered = client.get(f"{P}/sessions/{sid}/active-run").json()
    assert recovered["run"]["run_id"] == rid and recovered["run"]["terminal"] is False
    fake.runs[rid]["status"] = "completed"
    assert client.get(f"{P}/sessions/{sid}/active-run").json()["run"]["terminal"] is True
    assert client.get(f"{P}/sessions/{sid}/active-run").json() == {"run": None}


def test_run_event_stream_normalised_and_resumable(client, fake):
    sid = _new_session(client, fake)
    rid = _send(client, sid).json()["run_id"]
    with client.stream("GET", f"{P}/runs/{rid}/events") as r:
        assert r.headers["content-type"].startswith("text/event-stream")
        assert r.headers["x-accel-buffering"] == "no"
        raw = r.read().decode()
    data = [json.loads(line[6:]) for line in raw.splitlines() if line.startswith("data: ")]
    types = [d["type"] for d in data]
    assert types == ["delta", "tool", "tool", "delta", "run", "stream_end"]
    assert data[2]["phase"] == "failed"
    assert "supersecretvalue123" not in raw
    assert data[4]["status"] == "completed" and data[4]["usage"]["total_tokens"] == 5
    assert "id: 4" in raw
    # Resume after seq 2: only later events, forwarded via Last-Event-ID.
    with client.stream("GET", f"{P}/runs/{rid}/events", headers={"Last-Event-ID": "2"}) as r:
        resumed = [json.loads(line[6:]) for line in r.read().decode().splitlines() if line.startswith("data: ")]
    assert [d.get("seq") for d in resumed] == [3, 4, None]
    assert any(req.headers.get("last-event-id") == "2" for req in fake.requests)
    # Terminal event cleared the pointer.
    assert client.get(f"{P}/sessions/{sid}/active-run").json() == {"run": None}


def test_stream_error_for_unknown_run_is_inline(client):
    rid = "run_" + "0" * 32
    with client.stream("GET", f"{P}/runs/{rid}/events") as r:
        raw = r.read().decode()
    assert '"type":"stream_error"' in raw and '"status":404' in raw


def test_invalid_run_id(client):
    assert client.get(f"{P}/runs/../../x").status_code == 404
    assert client.get(f"{P}/runs/run_xyz").status_code == 400
    assert client.get(f"{P}/runs/run_xyz/events").status_code == 400


def test_stop_calls_hermes(client, fake):
    sid = _new_session(client, fake)
    rid = _send(client, sid).json()["run_id"]
    r = client.post(f"{P}/runs/{rid}/stop", headers={"X-Dash-Request": "1"})
    assert r.json()["status"] == "stopping" and fake.stops == [rid]


def test_approval_requires_explicit_valid_choice(client, fake):
    sid = _new_session(client, fake)
    rid = _send(client, sid).json()["run_id"]
    assert client.post(f"{P}/runs/{rid}/approval", json={}, headers=MUT).status_code == 400
    assert client.post(f"{P}/runs/{rid}/approval", json={"choice": "yolo"}, headers=MUT).status_code == 400
    assert fake.approvals == []
    r = client.post(f"{P}/runs/{rid}/approval", json={"choice": "deny", "request_id": "req-1"}, headers=MUT)
    assert r.status_code == 200 and fake.approvals == [{"choice": "deny", "request_id": "req-1"}]


def test_message_validation(client, fake):
    sid = _new_session(client, fake)
    assert _send(client, sid, text="   ").status_code == 400
    assert _send(client, sid, text="x" * 70000).status_code == 400
    assert _send(client, sid, client_request_id="not-a-uuid").status_code == 400


def test_image_run_builds_multimodal_input(client, fake):
    sid = _new_session(client, fake)
    r = _send(client, sid, text="what is this", images=[{"mime": "image/png", "data": PNG}])
    assert r.status_code == 202, r.text
    rid = r.json()["run_id"]
    run_input = fake.runs[rid]["input"]
    assert run_input[0]["role"] == "user"
    parts = run_input[0]["content"]
    assert parts[0] == {"type": "text", "text": "what is this"}
    assert parts[1]["type"] == "image_url" and parts[1]["image_url"]["url"].startswith("data:image/png;base64,")


def test_image_type_spoofing_rejected(client, fake):
    sid = _new_session(client, fake)
    svg = base64.b64encode(b"<svg onload=alert(1)>").decode()
    r = _send(client, sid, images=[{"mime": "image/svg+xml", "data": svg}])
    assert r.json()["error"]["code"] == "unsupported_image_type"
    r = _send(client, sid, images=[{"mime": "image/png", "data": svg}])
    assert r.json()["error"]["code"] == "image_type_mismatch"


def test_capabilities_reflect_hermes_features(client, fake):
    fake.features_override = {"session_fork": False}
    caps = client.get(f"{P}/capabilities").json()["capabilities"]
    assert caps["sessions"]["fork"] is False
    assert caps["runs"]["approval"] is True
    assert caps["hermes"]["memory_read"] is False
    assert caps["media"]["uploads"] is False


def test_fork_refused_when_unsupported(client, fake):
    fake.features_override = {"session_fork": False}
    sid = _new_session(client, fake)
    r = client.post(f"{P}/sessions/{sid}/fork", json={}, headers=MUT)
    assert r.status_code == 501 and r.json()["error"]["code"] == "unsupported_capability"


def test_read_only_hermes_context_is_allowlisted(client):
    skills = client.get(f"{P}/hermes/skills").json()["skills"]
    assert skills == [{"name": "plan", "description": "Plan", "category": "x"}]
    assert client.get(f"{P}/hermes/toolsets").json()["toolsets"][0]["tools"] == ["terminal"]


def test_preferences_validated(client):
    assert (
        client.put(f"{P}/preferences", json={"density": "compact"}, headers=MUT).json()["preferences"]["density"]
        == "compact"
    )
    assert client.put(f"{P}/preferences", json={"density": "<script>"}, headers=MUT).status_code == 400
    assert client.put(f"{P}/preferences", json={"api_url": "http://evil"}, headers=MUT).status_code == 400
