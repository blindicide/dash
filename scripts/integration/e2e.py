#!/usr/bin/env python3
"""Real-Hermes end-to-end checks for dash (run after `scripts/integration/env.sh up`).

Acts as an authenticated *browser* against the Hermes Dashboard (loopback session-token
mode) and drives the dash BFF at /api/plugins/dash/*. Verifies results through OTHER official
Hermes surfaces — the `hermes` CLI and the Dashboard's own /api/sessions routes — so
"same canonical history" is proven against Hermes' store, not dash's view of it.

Writes a JSON report (default .integration/e2e-report.json). Exit code 0 only if every
check passed. The model provider is the scripted stub; everything else is real Hermes.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import time
import traceback
import uuid
import zlib
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx

ROOT = Path(__file__).resolve().parents[2]
WORK = Path(os.environ.get("DASH_IT_DIR", ROOT / ".integration"))
HOME = WORK / "home"
DASH = f"http://127.0.0.1:{os.environ.get('DASH_IT_DASHBOARD_PORT', '19119')}"
API = f"http://127.0.0.1:{os.environ.get('DASH_IT_API_PORT', '18642')}"
P = "/api/plugins/dash"
MUT = {"X-Dash-Request": "1", "Content-Type": "application/json"}

results: list[dict[str, Any]] = []
TAG = uuid.uuid4().hex[:6]  # Hermes enforces unique titles; keep reruns independent


def check(name: str):
    def deco(fn: Callable[[], Any]):
        def run():
            started = time.time()
            try:
                detail = fn()
                results.append(
                    {"check": name, "ok": True, "seconds": round(time.time() - started, 2), "detail": detail}
                )
                print(f"PASS  {name}")
            except Exception as exc:  # noqa: BLE001
                results.append(
                    {
                        "check": name,
                        "ok": False,
                        "seconds": round(time.time() - started, 2),
                        "error": f"{type(exc).__name__}: {exc}",
                        "trace": traceback.format_exc(limit=3),
                    }
                )
                print(f"FAIL  {name}: {type(exc).__name__}: {exc}")

        run.__name__ = fn.__name__
        return run

    return deco


def session_token() -> str:
    html = httpx.get(f"{DASH}/dash", timeout=10).text
    m = re.search(r'window.__HERMES_SESSION_TOKEN__="([^"]+)"', html)
    if not m:
        raise RuntimeError("dashboard did not inject a loopback session token (gated mode?)")
    return m.group(1)


TOKEN = ""


def browser() -> httpx.Client:
    return httpx.Client(base_url=DASH, headers={"X-Hermes-Session-Token": TOKEN}, timeout=60)


def api_key() -> str:
    for line in (HOME / ".env").read_text().splitlines():
        if line.startswith("API_SERVER_KEY="):
            return line.split("=", 1)[1].strip()
    raise RuntimeError("no API key in scratch .env")


def hermes_cli(*args: str) -> str:
    env = {**os.environ, "HERMES_HOME": str(HOME)}
    out = subprocess.run(
        ["bash", str(ROOT / "scripts/integration/env.sh"), "hermes", *args],
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )
    if out.returncode != 0:
        raise RuntimeError(f"hermes {' '.join(args)} failed: {out.stderr[-400:]}")
    return out.stdout


def sse_events(
    client: httpx.Client,
    run_id: str,
    *,
    last: int | None = None,
    stop_after: Callable[[dict], bool] | None = None,
    profile: str | None = None,
    max_seconds: float = 90,
) -> list[dict]:
    headers = {"Accept": "text/event-stream"}
    if last is not None:
        headers["Last-Event-ID"] = str(last)
    params = {"profile": profile} if profile else None
    events: list[dict] = []
    deadline = time.time() + max_seconds
    with client.stream(
        "GET", f"{P}/runs/{run_id}/events", headers=headers, params=params, timeout=httpx.Timeout(60, read=60)
    ) as r:
        assert r.status_code == 200, r.status_code
        assert r.headers.get("x-accel-buffering") == "no"
        buf = ""
        for chunk in r.iter_text():
            buf += chunk
            while "\n\n" in buf:
                frame, buf = buf.split("\n\n", 1)
                data = [ln[6:] for ln in frame.splitlines() if ln.startswith("data: ")]
                if not data:
                    continue
                ev = json.loads("\n".join(data))
                events.append(ev)
                if ev.get("type") in ("stream_end", "stream_error"):
                    return events
                if stop_after and stop_after(ev):
                    return events
            if time.time() > deadline:
                raise TimeoutError(
                    f"no terminal event within {max_seconds}s; got {[e.get('type') for e in events][-8:]}"
                )
    return events


def send(
    client: httpx.Client,
    session_id: str,
    text: str,
    *,
    crid: str | None = None,
    images=None,
    profile: str | None = None,
) -> dict:
    body: dict[str, Any] = {"session_id": session_id, "text": text, "client_request_id": crid or str(uuid.uuid4())}
    if images:
        body["images"] = images
    r = client.post(f"{P}/runs", json=body, headers=MUT, params={"profile": profile} if profile else None)
    assert r.status_code == 202, f"{r.status_code} {r.text[:300]}"
    return r.json()


def text_of(events: list[dict]) -> str:
    return "".join(e.get("text", "") for e in events if e.get("type") == "delta")


def terminal(events: list[dict]) -> dict:
    runs = [e for e in events if e.get("type") == "run"]
    assert runs, f"no run terminal event: {[e.get('type') for e in events]}"
    return runs[-1]


def png_1x1() -> str:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return len(data).to_bytes(4, "big") + kind + data + zlib.crc32(kind + data).to_bytes(4, "big")

    raw = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", (1).to_bytes(4, "big") * 2 + b"\x08\x02\x00\x00\x00")
    raw += chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00")) + chunk(b"IEND", b"")
    return base64.b64encode(raw).decode()


STATE: dict[str, Any] = {}


@check("dashboard auth gate protects the BFF (no session token -> 401)")
def t_auth():
    r = httpx.get(f"{DASH}{P}/status", timeout=10)
    assert r.status_code == 401, r.status_code
    return {"status": r.status_code}


@check("plugin route, version and Hermes connectivity via BFF")
def t_status():
    with browser() as c:
        st = c.get(f"{P}/status").json()
        caps = c.get(f"{P}/capabilities").json()["capabilities"]
        plugins = c.get("/api/dashboard/plugins").json()
    assert st["hermes"]["reachable"] is True, st
    assert st["symbol"] == "\\"
    dash = next(p for p in plugins if p["name"] == "dash")
    assert dash["tab"]["path"] == "/dash" and dash["has_api"] is True
    assert dash["version"] == st["version"]
    assert caps["runs"]["submit"] and caps["runs"]["events"] and caps["runs"]["approval"]
    assert caps["sessions"]["fork"] and caps["runs"]["idempotency_durable"]
    STATE["caps"] = caps
    return {
        "dash_version": st["version"],
        "hermes_version": st["hermes"]["version"],
        "routing": st["target"]["routing"],
        "manifest": {k: dash[k] for k in ("version", "tab", "has_api", "source")},
    }


@check("API key never reaches the browser")
def t_secret():
    key = api_key()
    with browser() as c:
        bodies = [c.get(f"{P}/{path}").text for path in ("status", "capabilities", "profiles", "sessions", "state")]
        html = c.get("/dash").text
    assert all(key not in b for b in bodies + [html])
    return {"checked_responses": len(bodies) + 1}


@check("mutations without the dash header are refused")
def t_csrf():
    with browser() as c:
        r = c.post(f"{P}/sessions", json={}, headers={"Content-Type": "application/json"})
        r2 = c.post(f"{P}/sessions", json={}, headers={**MUT, "Origin": "https://evil.example"})
    assert r.status_code == 403 and r2.status_code == 403
    return {"no_header": r.status_code, "cross_origin": r2.status_code}


@check("send text from dash and stream the answer (native /v1/runs SSE)")
def t_send():
    with browser() as c:
        sid = c.post(f"{P}/sessions", json={"title": f"dash e2e canonical {TAG}"}, headers=MUT).json()["session"]["id"]
        run = send(c, sid, "hello from dash e2e")
        evs = sse_events(c, run["run_id"])
    final = terminal(evs)
    streamed = text_of(evs)
    assert final["status"] == "completed", final
    assert "dash-e2e-ok: hello from dash e2e" in streamed, streamed
    assert all(isinstance(e.get("seq"), int) for e in evs if e["type"] in ("delta", "run"))
    STATE["sid"], STATE["run1"] = sid, run["run_id"]
    return {"session_id": sid, "run_id": run["run_id"], "events": len(evs), "streamed": streamed}


@check("same canonical history visible from official Hermes clients (CLI + Dashboard API + API server)")
def t_canonical():
    sid = STATE["sid"]
    with browser() as c:
        dash_msgs = c.get(f"{P}/sessions/{sid}/messages").json()["messages"]
        official = c.get(f"/api/sessions/{sid}/messages").json()
    direct = httpx.get(
        f"{API}/api/sessions/{sid}/messages", headers={"Authorization": f"Bearer {api_key()}"}, timeout=10
    ).json()
    cli_list = hermes_cli("sessions", "list", "--limit", "20")
    export_path = WORK / f"export-{sid}.json"
    hermes_cli("sessions", "export", "--session-id", sid, str(export_path))
    exported = export_path.read_text()

    def contents(rows):
        return [str(m.get("content")) for m in rows if m.get("role") in ("user", "assistant")]

    off_rows = official.get("messages") or official.get("data") or []
    assert contents(dash_msgs)[:2] == ["hello from dash e2e", "dash-e2e-ok: hello from dash e2e"], contents(dash_msgs)
    assert contents(direct["data"])[:2] == contents(dash_msgs)[:2]
    assert contents(off_rows)[:2] == contents(dash_msgs)[:2], off_rows[:2]
    assert f"dash e2e canonical {TAG}" in cli_list or sid in cli_list
    assert "dash-e2e-ok: hello from dash e2e" in exported
    return {
        "dash": contents(dash_msgs),
        "dashboard_api_rows": len(off_rows),
        "cli_list_mentions_session": True,
        "cli_export_bytes": len(exported),
    }


@check("idempotent submit: same client_request_id replays the same Hermes run")
def t_idem():
    sid = STATE["sid"]
    crid = str(uuid.uuid4())
    with browser() as c:
        a = send(c, sid, "idempotency probe", crid=crid)
        b = send(c, sid, "idempotency probe", crid=crid)
        sse_events(c, a["run_id"])
        msgs = c.get(f"{P}/sessions/{sid}/messages").json()["messages"]
    assert a["run_id"] == b["run_id"] and b["replayed"] is True, (a, b)
    probes = [m for m in msgs if m["role"] == "user" and m["content"] == "idempotency probe"]
    assert len(probes) == 1, len(probes)
    return {"run_id": a["run_id"], "replayed": b["replayed"], "user_turns_recorded": len(probes)}


@check("browser disconnect does not cancel; reload finds the active run and resumes with Last-Event-ID")
def t_reconnect():
    sid = STATE["sid"]
    with browser() as c:
        run = send(c, sid, "E2E-SLOW please")
        rid = run["run_id"]
        first = sse_events(c, rid, stop_after=lambda e: e.get("type") == "delta" and e.get("seq", 0) >= 5)
        # connection closed here (simulated refresh / phone sleep)
        time.sleep(2)
        active = c.get(f"{P}/sessions/{sid}/active-run").json()
        assert active["run"] and active["run"]["run_id"] == rid and not active["run"]["terminal"], active
        last_seq = max(e["seq"] for e in first if isinstance(e.get("seq"), int))
        rest = sse_events(c, rid, last=last_seq)
    resumed_seqs = [e["seq"] for e in rest if isinstance(e.get("seq"), int)]
    assert resumed_seqs and min(resumed_seqs) == last_seq + 1, (last_seq, resumed_seqs[:5])
    final = terminal(rest)
    assert final["status"] == "completed", final
    full = text_of(first) + text_of(rest)
    assert full.strip().endswith("tick39") and "tick0" in full, full[-80:]
    with browser() as c:
        after = c.get(f"{P}/sessions/{sid}/active-run").json()
    assert after["run"] is None or after["run"]["terminal"]
    return {
        "run_id": rid,
        "disconnected_after_seq": last_seq,
        "resumed_from": min(resumed_seqs),
        "final": final["status"],
    }


@check("explicit Stop calls Hermes cancellation and the run settles as cancelled")
def t_stop():
    sid = STATE["sid"]
    with browser() as c:
        run = send(c, sid, "E2E-SLOW stop me")
        sse_events(c, run["run_id"], stop_after=lambda e: e.get("type") == "delta" and e.get("seq", 0) >= 3)
        r = c.post(f"{P}/runs/{run['run_id']}/stop", headers={"X-Dash-Request": "1"})
        assert r.status_code == 200 and r.json()["status"] in ("stopping", "cancelled"), r.text
        rest = sse_events(c, run["run_id"], last=3)
        status = c.get(f"{P}/runs/{run['run_id']}").json()["run"]
    final = terminal(rest)
    assert final["status"] == "cancelled", final
    assert status["status"] == "cancelled" and status["terminal"], status
    return {"run_id": run["run_id"], "final": final["status"]}


@check("tool lifecycle events (terminal tool running -> completed)")
def t_tool():
    sid = STATE["sid"]
    with browser() as c:
        run = send(c, sid, "E2E-TOOL run a harmless command")
        evs = sse_events(c, run["run_id"])
    tools = [e for e in evs if e["type"] == "tool"]
    assert [t["phase"] for t in tools][:2] == ["running", "completed"], tools
    assert tools[0]["tool"] == "terminal"
    final = terminal(evs)
    assert final["status"] == "completed" and "hello-from-dash-tool" in (final.get("output") or text_of(evs)), final
    return {"tool_events": [(t["tool"], t["phase"]) for t in tools], "output": final.get("output")}


def _approval_flow(choice: str) -> dict:
    sid = STATE["sid"]
    target = WORK / "danger" / "target"
    target.mkdir(parents=True, exist_ok=True)
    (target / "keep.txt").write_text("x")
    with browser() as c:
        run = send(c, sid, f"E2E-DANGER {choice}")
        rid = run["run_id"]
        evs = sse_events(c, rid, stop_after=lambda e: e.get("type") == "approval")
        approval = next(e for e in evs if e["type"] == "approval")
        time.sleep(1)
        status = c.get(f"{P}/runs/{rid}").json()["run"]
        assert status["status"] == "waiting_for_approval", status
        r = c.post(
            f"{P}/runs/{rid}/approval",
            json={"choice": choice, **({"request_id": approval["request_id"]} if approval.get("request_id") else {})},
            headers=MUT,
        )
        assert r.status_code == 200, r.text
        rest = sse_events(c, rid, last=max(e["seq"] for e in evs if isinstance(e.get("seq"), int)))
    final = terminal(rest)
    resolved = [e for e in rest if e["type"] == "approval_resolved"]
    return {
        "approval": {k: approval.get(k) for k in ("command", "description", "pattern_key", "choices", "request_id")},
        "resolved": resolved[:1],
        "final": final["status"],
        "target_exists": target.exists(),
        "tools": [(e["tool"], e["phase"]) for e in rest if e["type"] == "tool"],
    }


@check("approval request surfaced; explicit Deny via Hermes approval API blocks the action")
def t_deny():
    d = _approval_flow("deny")
    assert d["approval"]["command"] and "rm -rf" in d["approval"]["command"], d
    assert d["target_exists"] is True, d
    assert d["final"] == "completed", d
    return d


@check("explicit Approve once via Hermes approval API lets the action run")
def t_approve():
    d = _approval_flow("once")
    assert d["target_exists"] is False, d
    return d


@check("native image input reaches the model through /v1/runs")
def t_image():
    sid = STATE["sid"]
    with browser() as c:
        run = send(c, sid, "what is in this picture?", images=[{"mime": "image/png", "data": png_1x1()}])
        evs = sse_events(c, run["run_id"])
    final = terminal(evs)
    text = final.get("output") or text_of(evs)
    assert final["status"] == "completed", final
    log = [json.loads(line) for line in (WORK / "model-requests.jsonl").read_text().splitlines()]
    # The PNG must reach the provider as an image part. With a model Hermes does not know to be
    # vision-capable (the scripted stub), Hermes' native path sends the image to its vision
    # step and injects the description into the turn; a vision model would get it directly.
    image_requests = [e for e in log if e["images"] == 1]
    assert image_requests, "no provider request carried the image"
    direct = "image-received: 1" in text
    described = any(
        "The user attached an image" in e["user_head"] and "image-received: 1" in e["user_head"] for e in log
    )
    assert direct or described, (text, log[-3:])
    return {
        "answer": text,
        "path": "direct" if direct else "hermes-vision-preprocess",
        "provider_image_requests": len(image_requests),
    }


@check("session rename / pin / fork / delete through Hermes")
def t_crud():
    with browser() as c:
        sid = c.post(f"{P}/sessions", json={}, headers=MUT).json()["session"]["id"]
        sse_events(c, send(c, sid, "crud seed")["run_id"])
        r = c.patch(f"{P}/sessions/{sid}", json={"title": f"dash crud test {TAG}", "pinned": True}, headers=MUT).json()[
            "session"
        ]
        assert r["title"] == f"dash crud test {TAG}" and r["pinned"] is True, r
        fork = c.post(f"{P}/sessions/{sid}/fork", json={}, headers=MUT).json()["session"]
        assert fork["parent_session_id"] == sid
        fork_msgs = c.get(f"{P}/sessions/{fork['id']}/messages").json()["messages"]
        assert any(m["content"] == "crud seed" for m in fork_msgs)
        found = c.get(f"{P}/sessions/search", params={"q": f"crud test {TAG}"}).json()["sessions"]
        assert any(s["id"] == sid for s in found)
        d = c.delete(f"{P}/sessions/{fork['id']}", headers={"X-Dash-Request": "1"}).json()
        gone = c.get(f"{P}/sessions/{fork['id']}")
    assert d["deleted"] is True and gone.status_code == 404
    return {"session": sid, "fork": fork["id"], "fork_title": fork.get("title")}


@check("canonical Bot Chat: discover-or-create once, never duplicated, protected from delete")
def t_bot():
    with browser() as c:
        a = c.post(f"{P}/bot-chat", headers={"X-Dash-Request": "1"}).json()
        b = c.post(f"{P}/bot-chat", headers={"X-Dash-Request": "1"}).json()
        g = c.get(f"{P}/bot-chat").json()
        dele = c.delete(f"{P}/sessions/{a['session']['id']}", headers={"X-Dash-Request": "1"})
    assert a["session"]["id"] == b["session"]["id"] == g["session"]["id"]
    assert b["created"] is False and dele.status_code == 409
    direct = httpx.get(
        f"{API}/api/sessions",
        params={"title": "Bot Chat", "include_hidden": "1", "limit": 200},
        headers={"Authorization": f"Bearer {api_key()}"},
        timeout=10,
    ).json()
    rows = [s for s in direct["data"] if s.get("title") == "Bot Chat"]
    assert len(rows) == 1, rows
    return {"bot_chat_id": a["session"]["id"], "created_first_call": a["created"]}


@check("last dash session persists per profile in plugin-data")
def t_state():
    with browser() as c:
        c.put(f"{P}/state/last-session", json={"session_id": STATE["sid"]}, headers=MUT)
        st = c.get(f"{P}/state").json()
    data = HOME / "plugin-data" / "dash" / "state.json"
    assert st["last_session_id"] == STATE["sid"]
    assert data.is_file() and oct(data.stat().st_mode & 0o777) == "0o600"
    assert "hello from dash" not in data.read_text()  # pointers only, no conversation content
    return {"state_file": str(data.relative_to(WORK)), "mode": oct(data.stat().st_mode & 0o777)}


def profile_key(name: str) -> str:
    for line in (HOME / "profiles" / name / ".env").read_text().splitlines():
        if line.startswith("API_SERVER_KEY="):
            return line.split("=", 1)[1].strip()
    raise RuntimeError(f"no API key for profile {name}")


@check(
    "profile isolation: named profile routed via /p/<profile>/ with its own key; history, runs and dash state isolated"
)
def t_profiles():
    with browser() as c:
        profiles = c.get(f"{P}/profiles").json()["profiles"]
        assert {"default", "work"} <= {p["name"] for p in profiles}, profiles
        st = c.get(f"{P}/status", params={"profile": "work"}).json()
        assert st["target"]["routing"] == "multiplex" and st["hermes"]["reachable"], st
        wsid = c.post(
            f"{P}/sessions", json={"title": f"work only {TAG}"}, headers=MUT, params={"profile": "work"}
        ).json()["session"]["id"]
        run = send(c, wsid, "hello work profile", profile="work")
        evs = sse_events(c, run["run_id"], profile="work")
        assert terminal(evs)["status"] == "completed"
        work_ids = {
            s["id"] for s in c.get(f"{P}/sessions", params={"profile": "work", "limit": 200}).json()["sessions"]
        }
        default_ids = {s["id"] for s in c.get(f"{P}/sessions", params={"limit": 200}).json()["sessions"]}
        cross_run = c.get(f"{P}/runs/{run['run_id']}")  # default profile asking for work's run
        cross_session = c.get(f"{P}/sessions/{wsid}")
        c.put(f"{P}/state/last-session", json={"session_id": wsid}, headers=MUT, params={"profile": "work"})
        default_state = c.get(f"{P}/state").json()
        work_state = c.get(f"{P}/state", params={"profile": "work"}).json()
    assert wsid in work_ids and wsid not in default_ids
    assert STATE["sid"] in default_ids and STATE["sid"] not in work_ids
    assert cross_run.status_code == 404 and cross_session.status_code == 404
    assert work_state["last_session_id"] == wsid and default_state["last_session_id"] != wsid
    assert (HOME / "profiles" / "work" / "plugin-data" / "dash" / "state.json").is_file()
    # Hermes itself: the default key is refused on the named prefix; the work key is accepted.
    wrong = httpx.get(f"{API}/p/work/api/sessions", headers={"Authorization": f"Bearer {api_key()}"}, timeout=10)
    right = httpx.get(
        f"{API}/p/work/api/sessions/{wsid}", headers={"Authorization": f"Bearer {profile_key('work')}"}, timeout=10
    )
    assert wrong.status_code == 401 and right.status_code == 200, (wrong.status_code, right.status_code)
    return {
        "work_session": wsid,
        "cross_profile_run_status": cross_run.status_code,
        "default_key_on_work_prefix": wrong.status_code,
    }


ALL = [
    t_auth,
    t_status,
    t_secret,
    t_csrf,
    t_send,
    t_canonical,
    t_idem,
    t_reconnect,
    t_stop,
    t_tool,
    t_deny,
    t_approve,
    t_image,
    t_crud,
    t_bot,
    t_state,
    t_profiles,
]


def main() -> int:
    global TOKEN
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", default=str(WORK / "e2e-report.json"))
    ap.add_argument("--only", nargs="*")
    args = ap.parse_args()
    TOKEN = session_token()
    for fn in ALL:
        if args.only and fn.__name__ not in args.only:
            continue
        fn()
    try:
        hermes_version = hermes_cli("--version").splitlines()[0]
    except Exception as exc:  # noqa: BLE001
        hermes_version = f"unknown ({type(exc).__name__})"
    report = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "hermes": hermes_version,
        "environment": "isolated HERMES_HOME; real Hermes gateway API server + Dashboard + dash plugin; scripted OpenAI-compatible model stub",
        "passed": sum(r["ok"] for r in results),
        "failed": sum(not r["ok"] for r in results),
        "results": results,
    }
    Path(args.report).write_text(json.dumps(report, indent=2))
    print(f"\n{report['passed']} passed, {report['failed']} failed -> {args.report}")
    return 0 if report["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
