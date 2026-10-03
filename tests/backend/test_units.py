"""Unit tests for parsing, config, uploads and the disposable state store."""

from __future__ import annotations

import asyncio
import os
import stat
import time

import pytest
from conftest import MUT

from dash_bff import config, events, store, uploads, validation
from dash_bff.errors import DashError, redact

# -- SSE parser / adapter -------------------------------------------------------------------


def test_sse_parser_handles_split_chunks_and_crlf():
    parser = events.SSEParser()
    frames = []
    for chunk in ["id: 7\r", '\ndata: {"event":"message.delta",', '"delta":"hi"}\r\n\r\n', ": keepalive\n\n"]:
        frames.extend(parser.feed(chunk))
    assert frames[0].id == "7" and frames[0].data == '{"event":"message.delta","delta":"hi"}'
    assert frames[1].comment == "keepalive"
    event = events.parse_frame(frames[0])
    assert event == {"seq": 7, "run_id": None, "ts": None, "type": "delta", "text": "hi"}


def test_unknown_event_passthrough_marker():
    assert events.normalize({"event": "future.thing", "x": 1}, 3)["type"] == "unknown"


def test_approval_event_allowlist():
    ev = events.normalize(
        {
            "event": "approval.request",
            "command": "rm -rf /tmp/x",
            "description": "dangerous",
            "choices": ["once", "deny", "hack"],
            "session_key": "sk",
            "secret": "s",
        },
        1,
    )
    assert ev["choices"] == ["once", "deny"]
    assert "session_key" not in ev and "secret" not in ev


def test_run_terminal_events():
    ev = events.normalize(
        {"event": "run.failed", "error": "provider said api_key=sk-abcdefghijklmnopqrstu", "completed": False}, 9
    )
    assert ev["status"] == "failed" and "sk-abcdefghij" not in ev["error"]
    status = events.normalize_run_status(
        {"run_id": "run_x", "status": "waiting_for_approval", "approval": {"event": "approval.request", "command": "x"}}
    )
    assert status["approval"]["type"] == "approval" and status["terminal"] is False


def test_redaction():
    text = "Authorization: Bearer abcdefghijklmnop token=xyz12345 sk-ABCDEFGHIJKLMNOPQR " + "a" * 64
    out = redact(text)
    for secret in ("abcdefghijklmnop", "xyz12345", "sk-ABCDEFGHIJ", "a" * 64):
        assert secret not in out


# -- validation -----------------------------------------------------------------------------


@pytest.mark.parametrize("sid", ["", "../x", "a/b", "a\\b", "x" * 300, ".hidden", "a..b", "a b"])
def test_bad_session_ids(sid):
    with pytest.raises(validation.ValidationError):
        validation.session_id(sid)


@pytest.mark.parametrize("sid", ["20261003_103437_160bfe", "api_1696_abcd1234", "telegram:123@x"])
def test_good_session_ids(sid):
    assert validation.session_id(sid) == sid


def test_profile_names():
    assert validation.profile_name(None) is None
    assert validation.profile_name("work-2") == "work-2"
    for bad in ("Work", "../x", "a" * 65, "-x"):
        with pytest.raises(validation.ValidationError):
            validation.profile_name(bad)


def test_image_limits():
    import base64

    png = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 2000).decode()
    with pytest.raises(validation.ValidationError, match="exceeds"):
        validation.images([{"mime": "image/png", "data": png}], max_count=4, max_bytes=1024)
    with pytest.raises(validation.ValidationError):
        validation.images([{"mime": "image/png", "data": png}] * 3, max_count=2, max_bytes=10_000)
    with pytest.raises(validation.ValidationError):
        validation.images([{"mime": "image/png", "data": "!!notbase64"}], max_count=2, max_bytes=10_000)


# -- config ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    ["ftp://h", "http://user:pw@127.0.0.1:1", "http://10.0.0.5:8642", "http://127.0.0.1:8642/?x=1", "https://"],
)
def test_bad_override_urls(url):
    with pytest.raises(config.ConfigError):
        config.validate_base_url(url, allow_remote_http=False)


def test_good_override_urls():
    assert config.validate_base_url("http://127.0.0.1:8642/", allow_remote_http=False) == "http://127.0.0.1:8642"
    assert (
        config.validate_base_url("https://hermes.tailnet.ts.net", allow_remote_http=False)
        == "https://hermes.tailnet.ts.net"
    )
    assert config.validate_base_url("http://10.0.0.5:8642", allow_remote_http=True) == "http://10.0.0.5:8642"


def test_wildcard_bind_connects_via_loopback(monkeypatch):
    from dash_bff import compat

    monkeypatch.delenv("DASH_HERMES_API_URL", raising=False)
    monkeypatch.setattr(compat, "api_server_settings", lambda: ("0.0.0.0", 9000, None))  # noqa: S104
    monkeypatch.setattr(compat, "get_secret", lambda n: "k" * 20)
    target = config.resolve_target("default", is_launch_profile=True)
    assert target.base_url == "http://127.0.0.1:9000" and target.routing == "direct"
    assert "k" * 20 not in str(target.describe())


def test_override_routes_named_profiles_via_prefix(monkeypatch):
    from dash_bff import compat

    monkeypatch.setenv("DASH_HERMES_API_URL", "https://h.example")
    monkeypatch.setattr(compat, "get_secret", lambda n: "")
    assert config.resolve_target("work", is_launch_profile=False).base_url == "https://h.example/p/work"


# -- uploads --------------------------------------------------------------------------------


async def _chunks(*parts: bytes):
    for p in parts:
        yield p


def test_upload_save_generated_name_and_permissions(monkeypatch, tmp_path):
    monkeypatch.setenv("DASH_DATA_DIR", str(tmp_path))
    stored = asyncio.run(uploads.save(_chunks(b"hello ", b"world"), filename="../../etc/passwd.txt", max_bytes=100))
    assert stored.name == "passwd.txt"
    assert stored.path.parent == tmp_path / "uploads"
    assert uploads.UPLOAD_ID_RE.fullmatch(stored.upload_id)
    assert stat.S_IMODE(os.stat(stored.path).st_mode) == 0o600
    assert uploads.load(stored.upload_id).size == 11


@pytest.mark.parametrize(
    "name,data,code",
    [
        ("x.exe", b"MZ", "unsupported_upload_type"),
        ("x.svg", b"<svg/>", "unsupported_upload_type"),
        ("x.pdf", b"not a pdf", "upload_content_mismatch"),
        ("x.txt", b"\xff\xfe\x00bin", "upload_content_mismatch"),
        ("x.txt", b"a" * 200, "upload_too_large"),
        ("x.txt", b"", "empty_upload"),
    ],
)
def test_upload_rejections_leave_no_files(monkeypatch, tmp_path, name, data, code):
    monkeypatch.setenv("DASH_DATA_DIR", str(tmp_path))
    with pytest.raises(DashError) as exc:
        asyncio.run(uploads.save(_chunks(data), filename=name, max_bytes=100))
    assert exc.value.code == code
    assert not [p for p in (tmp_path / "uploads").iterdir()] if (tmp_path / "uploads").exists() else True


def test_upload_ids_validated(monkeypatch, tmp_path):
    monkeypatch.setenv("DASH_DATA_DIR", str(tmp_path))
    for bad in ("../state", "upl_../../x", "upl_" + "g" * 32):
        with pytest.raises(DashError):
            uploads.load(bad)


def test_upload_ttl_cleanup(monkeypatch, tmp_path):
    monkeypatch.setenv("DASH_DATA_DIR", str(tmp_path))
    stored = asyncio.run(uploads.save(_chunks(b"x"), filename="a.md", max_bytes=10))
    old = time.time() - 3 * 3600
    os.utime(stored.path, (old, old))
    assert uploads.cleanup(ttl_hours=1) == 1


def test_upload_routes_disabled_by_default(client):
    r = client.post(
        "/api/plugins/dash/uploads", content=b"x", headers={"X-Dash-Request": "1", "X-Dash-Filename": "a.txt"}
    )
    assert r.status_code == 403 and r.json()["error"]["code"] == "uploads_disabled"


def test_upload_route_enabled(client, monkeypatch, fake):
    import uuid

    monkeypatch.setenv("DASH_UPLOADS_ENABLED", "1")
    r = client.post(
        "/api/plugins/dash/uploads",
        content=b"# notes",
        headers={"X-Dash-Request": "1", "X-Dash-Filename": "notes%2Emd"},
    )
    assert r.status_code == 201, r.text
    uid = r.json()["upload"]["upload_id"]
    fake.add_session("s1")
    r = client.post(
        "/api/plugins/dash/runs",
        json={"session_id": "s1", "text": "", "client_request_id": str(uuid.uuid4()), "uploads": [uid]},
        headers=MUT,
    )
    assert r.status_code == 202
    sent = fake.runs[r.json()["run_id"]]["input"]
    assert "notes.md" in sent and uid in sent

    second = client.post(
        "/api/plugins/dash/uploads",
        content=b"remove me",
        headers={"X-Dash-Request": "1", "X-Dash-Filename": "remove.txt"},
    ).json()["upload"]["upload_id"]
    assert client.delete(f"/api/plugins/dash/uploads/{second}", headers={"X-Dash-Request": "1"}).json() == {
        "deleted": True
    }
    assert not (uploads.upload_dir() / f"{second}.txt").exists()


# -- store ----------------------------------------------------------------------------------


def test_store_atomic_private_and_pruned(tmp_path, monkeypatch):
    s = store.StateStore(tmp_path)
    s.set_active_run("s1", "run_" + "a" * 32, "c1")
    assert stat.S_IMODE(os.stat(s.path).st_mode) == 0o600
    future = time.time() + store.ACTIVE_RUN_TTL_SECONDS + 10
    monkeypatch.setattr(store.time, "time", lambda: future)
    assert s.active_run("s1") is None


def test_store_survives_corruption(tmp_path):
    s = store.StateStore(tmp_path)
    s.path.write_text("{not json")
    assert s.last_session() is None
    s.set_last_session("abc")
    assert s.last_session() == "abc"
