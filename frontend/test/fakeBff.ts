/** In-browser fake of the dash BFF for UI tests (wire shapes from dash_bff/routes.py). */
import type { Message, Session } from "../src/lib/types";

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export class FakeBff {
  calls: Call[] = [];
  sessions: Session[] = [
    { id: "s_old", title: "Earlier chat", is_bot_chat: false, last_active: Date.now() / 1000 - 3600, source: "cli" },
  ];
  messages: Record<string, Message[]> = {
    s_old: [
      { id: 1, role: "user", content: "hello from the CLI", timestamp: 1 },
      { id: 2, role: "assistant", content: "**hi** there", timestamp: 2 },
    ],
  };
  lastSession: Record<string, string | null> = { default: "s_old", work: null };
  activeRun: Record<string, string> = {};
  runStatus: Record<string, string> = {};
  streams: Record<string, ReadableStreamDefaultController<Uint8Array>[]> = {};
  runCount = 0;
  enc = new TextEncoder();

  push(runId: string, payload: string) {
    for (const c of this.streams[runId] ?? []) c.enqueue(this.enc.encode(payload));
  }
  event(runId: string, seq: number, ev: Record<string, unknown>) {
    this.push(runId, `id: ${seq}\ndata: ${JSON.stringify({ seq, run_id: runId, ...ev })}\n\n`);
  }
  end(runId: string) {
    this.push(runId, `data: ${JSON.stringify({ type: "stream_end", seq: null })}\n\n`);
    for (const c of this.streams[runId] ?? []) c.close();
    this.streams[runId] = [];
  }
  drop(runId: string) {
    for (const c of this.streams[runId] ?? []) c.error(new TypeError("network"));
    this.streams[runId] = [];
  }

  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url, "http://dash.test");
    const path = u.pathname.replace("/api/plugins/dash", "");
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    this.calls.push({ method, path, query: u.searchParams, headers: new Headers(init.headers), body });
    const profile = u.searchParams.get("profile") ?? "default";
    if (method !== "GET" && new Headers(init.headers).get("X-Dash-Request") !== "1") return json({ detail: { error: { code: "missing_dash_header", message: "no" } } }, 403);
    if (path === "/profiles")
      return json({
        launch_profile: "default",
        profiles: [
          { name: "default", is_default: true, is_launch: true, model: "m", provider: "p" },
          { name: "work", is_default: false, is_launch: false, model: "m2", provider: "p" },
        ],
      });
    if (path === "/status")
      return json({ product: "dash", symbol: "\\", version: "t", profile, launch_profile: "default", target: { profile, routing: "direct", auth_configured: true }, hermes: { version: "0.21.5", reachable: true, model: "hermes-agent" } });
    if (path === "/capabilities")
      return json({
        profile,
        capabilities: {
          sessions: { list: true, create: true, get: true, rename: true, delete: true, messages: true, fork: true, pin_archive: true, search: "titles_and_previews" },
          runs: { submit: true, status: true, events: true, stop: true, approval: true, tool_events: true, reasoning_events: true, idempotency: true, idempotency_durable: true, resume_from_seq: true },
          media: { images: "source_verified", image_max_bytes: 1000, image_max_count: 2, uploads: false, upload_max_bytes: 0 },
          hermes: { model_options: true, skills: true, toolsets: true, memory_read: false, soul_read: false, mcp_status: false },
          bot_chat: true,
          steer: true,
        },
      });
    if (path === "/state") return json({ profile, last_session_id: this.lastSession[profile] ?? null, preferences: { density: "comfortable", show_reasoning: false, show_tool_details: false, enter_to_send: true } });
    if (path === "/state/last-session") {
      this.lastSession[profile] = (body as { session_id: string | null }).session_id;
      return json({ last_session_id: this.lastSession[profile] });
    }
    if (path === "/sessions" && method === "GET") return json({ sessions: profile === "work" ? [] : this.sessions, has_more: false });
    if (path === "/sessions" && method === "POST") {
      const s: Session = { id: `s_new${this.sessions.length}`, title: null, is_bot_chat: false };
      this.sessions.unshift(s);
      this.messages[s.id] = [];
      return json({ session: s });
    }
    if (path === "/bot-chat") return json({ session: null });
    const m = /^\/sessions\/([^/]+)(\/[a-z-]+)?$/.exec(path);
    if (m) {
      const sid = decodeURIComponent(m[1]!);
      const s = this.sessions.find((x) => x.id === sid);
      if (!s) return json({ error: { code: "session_not_found", message: "Session not found" } }, 404);
      if (!m[2]) return json({ session: s });
      if (m[2] === "/messages") return json({ session_id: sid, messages: this.messages[sid] ?? [], returned: 0 });
      if (m[2] === "/active-run") {
        const rid = this.activeRun[sid];
        return json({ run: rid ? { run_id: rid, status: "running", session_id: sid, terminal: false } : null });
      }
    }
    if (path === "/runs" && method === "POST") {
      const b = body as { session_id: string; text: string };
      const rid = `run_${String(++this.runCount).padStart(32, "0")}`;
      this.activeRun[b.session_id] = rid;
      return json({ run_id: rid, status: "started", replayed: false, session_id: b.session_id }, 202);
    }
    const r = /^\/runs\/(run_[0-9a-f]{32})(\/[a-z]+)?$/.exec(path);
    if (r) {
      const rid = r[1]!;
      if (r[2] === "/events") {
        const stream = new ReadableStream<Uint8Array>({
          start: (controller) => {
            (this.streams[rid] ??= []).push(controller);
            controller.enqueue(this.enc.encode(": dash stream open\nretry: 2000\n\n"));
          },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      if (r[2] === "/approval") return json({ choice: (body as { choice: string }).choice, resolved: 1 });
      if (r[2] === "/stop") return json({ run_id: rid, status: "stopping" });
      const status = this.runStatus[rid] ?? "running";
      return json({ run: { run_id: rid, status, session_id: null, terminal: status !== "running" } });
    }
    return json({ error: { code: "nope", message: `unhandled ${method} ${path}` } }, 404);
  };
}
