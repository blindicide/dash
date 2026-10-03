# BFF API reference

Base path: `/api/plugins/dash` on the Hermes Dashboard (relative — the Dashboard's base path
and auth are applied by the plugin SDK). All responses are JSON unless noted.

**Profile scoping:** append `?profile=<name>` to address a named Hermes profile; omit it for
the Dashboard's own (launch) profile. The name must match `^[a-z0-9][a-z0-9_-]{0,63}$`.

**Mutations** (`POST`/`PUT`/`PATCH`/`DELETE`) require `X-Dash-Request: 1`, and when the
browser sends `Origin` it must exactly match the request's `scheme://Host` (or an exact
origin in `DASH_TRUSTED_ORIGINS`). Client-supplied forwarding headers are not trusted by
this check. JSON bodies require `Content-Type: application/json`.

**Errors:** `{"error": {"code": "…", "message": "…", "retryable": bool}}` (dependency-level
errors nest the same object under `detail`). Hermes' own `401` is reported as
`502 hermes_auth_failed`, so the Dashboard does not mistake it for an expired login.

| Code | Meaning |
|---|---|
| `hermes_unavailable` (503) | API server unreachable / timed out |
| `hermes_auth_failed` (502) | `API_SERVER_KEY` for this profile rejected or missing |
| `unsupported_capability` (501) | Hermes does not advertise the feature |
| `invalid_*` (400) | validation failure (`invalid_session_id`, `invalid_profile`, …) |
| `missing_dash_header` / `cross_origin` (403) | mutation guard |
| `run_in_progress` (409) | a dash-submitted run is still active in the session |
| `reserved_title`, `bot_chat_protected` | Bot Chat rules |
| `uploads_disabled` (403) | uploads are off on this server |

## Status and discovery

| Method & path | Response |
|---|---|
| `GET /status` | `{product, symbol, version, profile, launch_profile, target:{profile, routing, auth_configured}, hermes:{version, reachable, model, api_platform, error?}, compat:{…}, server_time}` |
| `GET /capabilities` | `{profile, version, capabilities}` — see `frontend/src/lib/types.ts::Capabilities` |
| `GET /profiles` | `{launch_profile, profiles:[{name, is_default, is_launch, model, provider}]}` |

## Sessions

| Method & path | Body / query | Response |
|---|---|---|
| `GET /sessions` | `limit` 1–200, `offset` | `{sessions:[Session], has_more}` |
| `GET /sessions/search` | `q` (1–200 chars) | `{query, sessions, scanned, truncated}` — titles, previews, ids |
| `POST /sessions` | `{title?}` | `{session}` |
| `GET /sessions/{id}` | — | `{session}` |
| `PATCH /sessions/{id}` | `{title?, pinned?, archived?}` | `{session}` |
| `DELETE /sessions/{id}` | — | `{deleted, id}` (refused for the Bot Chat) |
| `GET /sessions/{id}/messages` | `limit` 1–500, `offset`, `order=latest|oldest` | `{session_id, messages:[Message], returned, …}` |
| `POST /sessions/{id}/fork` | `{title?}` | `{session}` |
| `GET /sessions/{id}/active-run` | — | `{run: RunRecord|null, client_request_id?}` |
| `GET /bot-chat` | — | `{session|null}` |
| `POST /bot-chat` | — | `{session, created}` — discover, else create once |

`Session` and `Message` are allow-listed projections of Hermes' session/message resources
(`frontend/src/lib/types.ts`). Hidden/compaction rows are dropped; tool arguments and tool
results are redacted for credential-shaped strings.

## Runs

| Method & path | Body | Response |
|---|---|---|
| `POST /runs` | `{session_id, text?, client_request_id (UUID), images?:[{mime, data(base64)}], uploads?:[upload_id], model?:{provider, model}}` | `202 {run_id, status, replayed, session_id}`; at least one of text/images/uploads is required |
| `GET /runs/{run_id}` | — | `{run: RunRecord}` |
| `GET /runs/{run_id}/events` | header `Last-Event-ID` or `?last_seq=` | `text/event-stream` (below) |
| `POST /runs/{run_id}/stop` | — | `{run_id, status}` |
| `POST /runs/{run_id}/approval` | `{choice: once|session|always|deny, request_id?}` | `{run_id, choice, resolved}` |
| `GET /models/choices` | — | `{available, current:{provider, model}, providers:[{provider, name, current, models}]}` |

Images: PNG/JPEG/GIF/WebP only, magic bytes must match the declared type, default ≤ 5 MB
each and ≤ 4 per message (`DASH_IMAGE_MAX_BYTES`, `DASH_IMAGE_MAX_COUNT`), and together at
most 7,000,000 bytes per message (`images_too_large`; reported as
`capabilities.media.image_total_max_bytes`), because Hermes rejects run requests over 10 MB
and images travel base64-encoded. `model` must be one of the choices Hermes offers for the
profile.

### Event stream

Each frame is `id: <seq>` + `data: <json>`. The first frame is a comment
(`: dash stream open`) with `retry: 2000`; keepalive comments are forwarded. Event objects:

| `type` | Fields |
|---|---|
| `delta` | `text` — streamed answer text |
| `commentary` | `text`, `already_streamed` — mid-turn assistant commentary |
| `reasoning` | `text` — reasoning the model exposed (hidden unless the preference is on) |
| `tool` | `phase: running|completed|failed`, `tool`, `preview`, `duration?` |
| `subagent` | `phase: started|completed`, `goal?`, `summary?`, `status?`, … |
| `approval` | `command?`, `description?`, `pattern_key?`, `pattern_keys?`, `request_id?`, `choices`, `smart_denied?` |
| `approval_resolved` | `choice`, `request_id` |
| `run` | `status: completed|failed|cancelled|interrupted|…`, `output?`, `error?`, `usage?`, `runtime?` |
| `replay_truncated` | `oldest_retained_seq` |
| `stream_end` | terminal marker — Hermes closed the stream |
| `stream_error` | `code`, `message`, `retryable`, `status` — the subscription failed (the run may still be running) |
| `unknown` | `name` — event from a newer Hermes, ignored by the UI |

All objects also carry `seq`, `run_id`, `ts`.

## UI state (disposable)

| Method & path | Body | Response |
|---|---|---|
| `GET /state` | — | `{profile, last_session_id, preferences}` |
| `PUT /state/last-session` | `{session_id|null}` | `{last_session_id}` |
| `PUT /preferences` | any of `{density: comfortable|compact, show_reasoning, show_tool_details, enter_to_send}` | `{preferences}` |

## Read-only Hermes context

| Method & path | Response |
|---|---|
| `GET /hermes/models` | bounded copy of `/api/model/options` |
| `GET /hermes/toolsets` | `{toolsets:[{name, label, description, enabled, configured, tools}]}` |
| `GET /hermes/skills` | `{skills:[{name, description, category, enabled}]}` (the tested Hermes build returns an upstream error here; see compatibility) |

## Optional uploads (`DASH_UPLOADS_ENABLED=1`)

The mandate's suggested `/upload` route is implemented as the `/uploads` collection so that
the same resource also supports `DELETE /uploads/{upload_id}`.

| Method & path | Request | Response |
|---|---|---|
| `POST /uploads` | raw body, header `X-Dash-Filename` (URL-encoded display name) | `201 {upload:{upload_id, name, mime, size}}` |
| `DELETE /uploads/{upload_id}` | — | `{deleted}` |
