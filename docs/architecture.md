# Architecture

dash (`\`) is a presentation layer. Hermes owns every profile, session, message, run,
model/provider setting, SOUL, memory, skill, tool, MCP server and approval. dash keeps only
disposable UI pointers and preferences.

```
 Browser (desktop / mobile)
 ┌──────────────────────────────────────────────┐
 │ Hermes Dashboard SPA                         │
 │  └─ dash tab (/dash)  ← plugin IIFE bundle   │  React = host singleton (SDK.React)
 │      lib/api.ts  ── SDK.authedFetch ──┐      │  relative /api/plugins/dash/* only
 └───────────────────────────────────────┼──────┘
                                         │  Dashboard auth (session token header or OAuth cookie)
 Hermes Dashboard process (FastAPI)      ▼
 ┌──────────────────────────────────────────────┐
 │ auth middleware → plugin runtime gate        │
 │ _plugin_route_secret_scope(?profile=)        │  enters that profile's HERMES_HOME + secrets
 │ /api/plugins/dash/*  = dash_bff.routes       │
 │   validation · mutation guard · redaction    │
 │   store.py (plugin-data/dash/state.json)     │  pointers + prefs only
 │   hermes_client.py (one pooled httpx client) │
 └───────────────────────┬──────────────────────┘
                         │  Bearer API_SERVER_KEY (server-side only)
                         ▼  http://127.0.0.1:8642[/p/<profile>]
 Hermes gateway — API server platform
 ┌──────────────────────────────────────────────┐
 │ /v1/capabilities  /v1/runs (+events/stop/approval)
 │ /api/sessions (+messages/fork)  /api/model/options
 │ SessionDB (state.db) — the canonical history │  shared with CLI, Dashboard, attached Bot clients
 └──────────────────────────────────────────────┘
```

## Components

| Path | Role |
|---|---|
| `plugin/dashboard/manifest.json` | Dashboard plugin manifest (tab `/dash` after Chat, entry, css, api). |
| `plugin/dashboard/plugin_api.py` | Entry imported by the Dashboard; loads the private `dash_bff` package and exports `router`. |
| `plugin/dashboard/dash_bff/compat.py` | **Only** place that imports Hermes in-process helpers; each has a fallback. |
| `…/config.py` | Server-side settings (`DASH_*` env) and Hermes target resolution per profile. Never reads browser input. |
| `…/hermes_client.py` | **Only** place that calls the Hermes API server. Shared async client, typed calls, SSE adapter, error translation. |
| `…/events.py` | Incremental SSE parser + allow-listing normaliser for run events and run status. |
| `…/routes.py` | BFF routes: validation, mutation guard, capability gating, Bot Chat rules, idempotency key derivation. |
| `…/store.py` | Disposable per-profile state in `<profile home>/plugin-data/dash/state.json` (0600, atomic writes). |
| `…/uploads.py` | Optional, off-by-default file uploads (see [security.md](security.md)). |
| `frontend/src/lib/api.ts` | Browser client for the BFF (relative paths, auth via SDK). |
| `frontend/src/lib/stream.ts` | Resumable run subscription (fetch SSE, `Last-Event-ID`, backoff, polling fallback). |
| `frontend/src/lib/runState.ts` | Pure reducer: events → live turn model (text, commentary, tools, approvals). |
| `frontend/src/lib/markdown.tsx` | Markdown lexer → React elements (no HTML injection). |
| `frontend/src/hooks/useDash.ts` | Controller: profile/session lifecycle, send/stop/approve, generation guards. |
| `frontend/src/components/*` | Header, sidebar, conversation, cards, composer, dialogs. |

## Key flows

### Session vs run

A **session** is a Hermes conversation (`/api/sessions/{id}`), shared by every Hermes
client. A **run** is one agent turn in a session (`/v1/runs`, id `run_<hex>`). dash submits
`{input, session_id}` so Hermes loads the session's history, executes the turn and persists
it to the same session row that the CLI and Dashboard see. A Bot transport sees it when it
owns or attaches to that same session (not every arbitrary session is a messaging thread).

### Send (idempotent)

1. The composer creates a `client_request_id` (UUID) and stores the session, id and an exact
   digest of the text, images, upload ids and model choice in `sessionStorage` *before*
   sending. Attachment bytes and message text are not stored in that record.
2. The BFF validates input and derives `Idempotency-Key = "dash-" + sha256(profile, session,
   client_request_id)[:48]`, then calls `POST /v1/runs`.
3. Hermes reserves the key durably. A retry after a network failure reuses the same id, so
   Hermes answers `202` with `Idempotency-Replayed: true` and the original `run_id` instead of
   starting a second turn. Reusing a key with a different body gets `409`.
4. On `202` the pending record is cleared; the BFF writes a `session → run_id` pointer to
   plugin-data.

### Streaming, disconnect and resume

- The browser reads `GET /api/plugins/dash/runs/{id}/events` with `fetch` (EventSource
  cannot send the Dashboard auth header). The BFF proxies Hermes' SSE without buffering
  (`X-Accel-Buffering: no`, `Cache-Control: no-cache, no-transform`), normalising each event
  and keeping Hermes' `seq` as the SSE `id`.
- A browser disconnect (refresh, sleep, network change) only closes that subscription. The
  run lives in the Hermes gateway and continues.
- Hermes writes a keepalive every 10 s and the BFF forwards it. A connection that stays
  silent for 45 s, or for more than 15 s when the tab becomes visible or the device comes back
  online, is treated as half-open: the browser aborts it and resumes. A stream that ends
  without a terminal event is settled from `GET /v1/runs/{id}` instead of being left running.
- Reconnect sends `Last-Event-ID: <last seq>`; Hermes replays the missed events from its
  per-run backlog (1000 events). Duplicates are dropped by sequence number. If the backlog was
  exceeded Hermes sends `replay.truncated`, and dash reloads the canonical transcript when the
  run ends.
- After a full page reload, dash asks the BFF for the session's active-run pointer, confirms
  with `GET /v1/runs/{id}` that it is still running, and re-attaches with a full replay. It
  never resends the message.
- **Stop** is the only path that cancels: `POST /v1/runs/{id}/stop`; the run settles as
  `cancelled`.

### Tools and approvals

`tool.started` / `tool.completed` become cards (running → completed/failed); a denial while
a tool runs marks it `denied`, and a run ending while a tool runs marks it `stopped`.
`approval.request` shows the redacted command, description and pattern exactly as Hermes
supplied them, with only the choices Hermes allows. Nothing is answered automatically; a
click posts `{choice, request_id}` to `/v1/runs/{id}/approval`.

### Profiles

The selected profile name (validated against `^[a-z0-9][a-z0-9_-]{0,63}$`) is sent as
`?profile=` on BFF calls for non-launch profiles. The Dashboard then enters that profile's
home and secret scope. The BFF reads that profile's `API_SERVER_KEY` and talks to
`/p/<profile>/…` on the multiplexed listener (or the profile's own listener). Hermes itself
enforces per-profile keys and run ownership. In the browser a generation counter discards
any response from a previous profile, and every list, stream and composer draft is reset on
switch. Each profile's last session lives in that profile's own plugin-data.

### Bot Chat

dash looks up the canonical Bot Chat exactly like `hermes peer dm` does (exact title
`Bot Chat`, `include_hidden=1`, re-filtered client-side). It creates one via
`POST /api/sessions {title: "Bot Chat"}` only when none exists, and re-discovers after a
uniqueness conflict. It refuses to delete the Bot Chat, and refuses to create or rename any
other session to that title.

## Why a BFF (not direct browser → Hermes API)

The Hermes API server is a privileged, terminal-capable endpoint authenticated by a static
bearer key. Exposing it to browsers would leak that key. The Dashboard already
authenticates users, so dash runs its backend inside the Dashboard process and keeps the key
server-side. The browser can address only `/api/plugins/dash/*` and a validated profile
name. It can never choose a URL, host, path or file.
