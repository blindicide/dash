#!/usr/bin/env python3
"""Deterministic OpenAI-compatible model endpoint for dash's real-Hermes integration harness.

This replaces ONLY the LLM provider. Hermes itself (gateway, API server, runs, SSE, session
DB, tool execution, approval gate, Dashboard and the dash plugin) runs for real. Behaviour is
keyed on markers in the latest user message:

  E2E-SLOW    stream ~40 short chunks over ~20 s (reload/reconnect and stop tests)
  E2E-TOOL    call the `terminal` tool with a harmless echo, then answer
  E2E-DANGER  call `terminal` with `rm -rf <target>` (dangerous -> Hermes approval gate)
  (images)    answer "image-received: N" when image parts reach the provider
  otherwise   "dash-e2e-ok: <first 40 chars of the message>"

Every request is appended to --log as JSON (counts only, never message bodies beyond the
first 80 chars of the latest user text) for assertions.
"""

from __future__ import annotations

import argparse
import json
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

LOG_LOCK = threading.Lock()


def _text_of(content: Any) -> tuple[str, int]:
    if isinstance(content, str):
        return content, 0
    text, images = [], 0
    if isinstance(content, list):
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") in ("text", "input_text"):
                text.append(str(part.get("text") or ""))
            elif part.get("type") in ("image_url", "input_image", "image"):
                images += 1
    return "\n".join(text), images


def plan(body: dict[str, Any], danger_target: str) -> dict[str, Any]:
    messages = body.get("messages") or []
    last = messages[-1] if messages else {}
    user = next((m for m in reversed(messages) if m.get("role") == "user"), {})
    text, images = _text_of(user.get("content"))
    has_tools = bool(body.get("tools"))
    if last.get("role") == "tool":
        result, _ = _text_of(last.get("content"))
        return {
            "kind": "text",
            "text": f"tool-finished: {result.strip()[:120]}",
            "slow": False,
            "images": images,
            "user": text,
        }
    if "E2E-TOOL" in text and has_tools:
        return {"kind": "tool", "command": "echo hello-from-dash-tool", "images": images, "user": text}
    if "E2E-DANGER" in text and has_tools:
        return {"kind": "tool", "command": f"rm -rf {danger_target}", "images": images, "user": text}
    if images:
        return {"kind": "text", "text": f"image-received: {images}", "slow": False, "images": images, "user": text}
    if "E2E-SLOW" in text:
        return {
            "kind": "text",
            "text": " ".join(f"tick{i}" for i in range(40)),
            "slow": True,
            "images": 0,
            "user": text,
        }
    return {"kind": "text", "text": f"dash-e2e-ok: {text.strip()[:40]}", "slow": False, "images": 0, "user": text}


class Handler(BaseHTTPRequestHandler):
    server_version = "dash-scripted-model/1"

    def log_message(self, *_args: Any) -> None:  # quiet
        return

    def _json(self, status: int, payload: Any) -> None:
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/").endswith("/models"):
            self._json(200, {"object": "list", "data": [{"id": "scripted", "object": "model", "owned_by": "dash-e2e"}]})
        else:
            self._json(404, {"error": {"message": "not found"}})

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        if not self.path.rstrip("/").endswith("/chat/completions"):
            self._json(404, {"error": {"message": f"unsupported path {self.path}"}})
            return
        p = plan(body, self.server.danger_target)  # type: ignore[attr-defined]
        with LOG_LOCK, open(self.server.log_path, "a", encoding="utf-8") as fh:  # type: ignore[attr-defined]
            fh.write(
                json.dumps(
                    {
                        "ts": time.time(),
                        "stream": bool(body.get("stream")),
                        "n_messages": len(body.get("messages") or []),
                        "n_tools": len(body.get("tools") or []),
                        "kind": p["kind"],
                        "images": p.get("images", 0),
                        "user_head": (p.get("user") or "")[:80],
                    }
                )
                + "\n"
            )
        cid = f"chatcmpl-{uuid.uuid4().hex[:12]}"
        created = int(time.time())
        if p["kind"] == "tool":
            call = {
                "index": 0,
                "id": f"call_{uuid.uuid4().hex[:10]}",
                "type": "function",
                "function": {"name": "terminal", "arguments": json.dumps({"command": p["command"]})},
            }
            if body.get("stream"):
                self._stream(cid, created, [{"role": "assistant", "tool_calls": [call]}], "tool_calls", slow=False)
            else:
                msg = {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{k: v for k, v in call.items() if k != "index"}],
                }
                self._json(200, self._completion(cid, created, msg, "tool_calls"))
            return
        text = p["text"]
        if body.get("stream"):
            words = text.split(" ")
            deltas = [{"role": "assistant", "content": ""}] + [
                {"content": (w if i == 0 else " " + w)} for i, w in enumerate(words)
            ]
            self._stream(cid, created, deltas, "stop", slow=p.get("slow", False))
        else:
            self._json(200, self._completion(cid, created, {"role": "assistant", "content": text}, "stop"))

    @staticmethod
    def _completion(cid: str, created: int, message: dict, finish: str) -> dict:
        return {
            "id": cid,
            "object": "chat.completion",
            "created": created,
            "model": "scripted",
            "choices": [{"index": 0, "message": message, "finish_reason": finish}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        }

    def _stream(self, cid: str, created: int, deltas: list[dict], finish: str, *, slow: bool) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            for delta in deltas:
                chunk = {
                    "id": cid,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": "scripted",
                    "choices": [{"index": 0, "delta": delta, "finish_reason": None}],
                }
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
                self.wfile.flush()
                if slow:
                    time.sleep(0.5)
            final = {
                "id": cid,
                "object": "chat.completion.chunk",
                "created": created,
                "model": "scripted",
                "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            }
            self.wfile.write(f"data: {json.dumps(final)}\n\ndata: [DONE]\n\n".encode())
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--log", required=True)
    ap.add_argument("--danger-target", required=True)
    args = ap.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    server.log_path = args.log  # type: ignore[attr-defined]
    server.danger_target = args.danger_target  # type: ignore[attr-defined]
    server.serve_forever()


if __name__ == "__main__":
    main()
