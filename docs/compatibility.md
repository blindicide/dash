# Compatibility matrix

dash only uses Hermes surfaces that exist in the tested Hermes source **and** are documented
upstream (or, where marked, are verified from source plus a real integration run). Every
row cites where the surface is defined, so a future Hermes change can be checked quickly.

## Tested versions

| Component | Version tested | How it was established |
|-----------|----------------|------------------------|
| Hermes Agent | **v0.21.5+6579.g3d0a61a** (2026.9.24), source checkout `3d0a61ac94e1181985177fdd975c4efeb478e9b7` (`git describe`: `v0.21.4+canary.20261003T070620Z-355-g3d0a61ac94`) | runtime `hermes --version`, plus `git rev-parse HEAD` and `git describe` in `~/.hermes/hermes-agent` |
| Dashboard plugin SDK | contract **1.1.0** (`SDK_CONTRACT_VERSION`) | `web/src/plugins/registry.ts` |
| Dashboard runtime | Python 3.14.7, FastAPI 0.133.1, Starlette 1.3.1, httpx 0.28.1, Pydantic 2.13.4 | imported in the Dashboard's runtime environment |
| Dashboard frontend | React 19.2.7 (provided by the host; dash bundles none) | `web/package.json` |
| Upstream docs | `user-guide/features/extending-the-dashboard`, `user-guide/features/api-server` (fetched 2026-10-03) | hermes-agent.nousresearch.com |

Results of the real-Hermes runs against this exact source checkout are in
[verification-report.md](verification-report.md).

## Dashboard plugin surface

| Surface dash uses | Defined in tested source `3d0a61ac` | Documented upstream | Notes |
|---|---|---|---|
| `dashboard/manifest.json`: `name`, `label`, `description`, `icon`, `version`, `tab.path`, `tab.position`, `entry`, `css`, `api` | `hermes_cli/web_server_dashboard.py::_dashboard_plugin_entry` | yes | No other manifest fields are used. `tab.position: "after:chat"` places the tab after Chat. |
| Backend `plugin_api.py` exporting module-level `router`, mounted at `/api/plugins/<name>/` once at startup | `_mount_plugin_api_routes` | yes | dash's `plugin_api.py` loads its private `dash_bff` package from the sibling directory. |
| User plugins must be in `plugins.enabled` (import gate + per-request gate) | `_plugin_api_mount_skip_reason`, `web_server.py::_plugin_api_runtime_gate` | partly (docs mention the request-time gate only) | `hermes plugins enable dash` does **not** work for a dashboard-only plugin (it needs an agent `plugin.yaml`); the entry is added to `config.yaml`. |
| Per-request profile + secret scope for plugin routes via `?profile=` | `_plugin_route_secret_scope` → `web_server_profiles._config_profile_scope` | no (source only) | dash reads the requested profile's `API_SERVER_KEY` through `agent.secret_scope.get_secret` inside that scope. Isolated in `dash_bff/compat.py`. |
| Dashboard auth for plugin routes (loopback session-token header / gated OAuth cookie) | `web_server.py::auth_middleware`, `dashboard_auth/*` | yes | dash adds its own mutation header + Origin check on top. |
| `window.__HERMES_PLUGINS__.register(name, Component)` | `web/src/plugins/registry.ts` | yes | |
| `SDK.React` (host singleton) | same | yes | React is aliased at build time to the host instance. |
| `SDK.fetchJSON` | same | yes | Fallback transport for hosts without `authedFetch`. |
| `SDK.authedFetch` | same (SDK 1.1.0), `web/src/lib/api.ts` | **no** (in `sdk.d.ts`, not in the docs page) | Needed for SSE over fetch. Feature-detected; without it dash degrades to polling run status. |
| `SDK.components.Button`, `Badge`, `Dialog*` | same | Button/Badge yes, Dialog in source | Used through adapters with native fallbacks (`frontend/src/components/ui.tsx`). |
| Theme tokens `--color-*`, `--theme-font-*`, `--radius` | `web/src/index.css` | yes | All dash colours derive from them. |
| Plugin data directory `<home>/plugin-data/<name>/` | `plugins/plugin_storage.py::plugin_data_dir` | no (bundled-plugin convention) | Fallback to `get_hermes_home()/plugin-data/dash`. |
| Profile names | `hermes_cli/profiles.py::list_profiles` | Dashboard `/api/profiles` is documented | Read-only, in-process (the docs allow backend plugins to import Hermes modules). |
| API server listen address | `gateway/config.py::load_gateway_config`, `api_server.listen_address` | env vars documented | Overridable with `DASH_HERMES_API_URL`. |

## Hermes API server surface (called only by the BFF)

| dash feature | Hermes endpoint | Capability flag checked | Defined in | Documented | Integration-verified |
|---|---|---|---|---|---|
| Capability discovery | `GET /v1/capabilities` | — | `api_server.py::_handle_capabilities` | yes | yes |
| List sessions | `GET /api/sessions?limit&offset` | `session_resources`, endpoint `sessions` | `_handle_list_sessions` | yes | yes |
| Bot Chat lookup | `GET /api/sessions?title=Bot Chat&include_hidden=1` | — | same + `hermes_cli/subcommands/peer.py::_find_bot_chat` | `title`/`include_hidden` **not** in docs (source + official `hermes peer dm` client) | yes |
| Create / get / patch (`title`, `pinned`, `archived`) / delete session | `POST/GET/PATCH/DELETE /api/sessions[/{id}]` | endpoints `session_*` | `_handle_*_session` | yes (`pinned`/`archived` source only) | yes |
| Messages | `GET /api/sessions/{id}/messages?limit&offset&order` | `session_messages` | `_handle_session_messages` | yes | yes |
| Fork / branch | `POST /api/sessions/{id}/fork` | `session_fork` | `_handle_fork_session` | yes | yes |
| Submit run | `POST /v1/runs` (`input`, `session_id`, optional `provider`+`model`) + `Idempotency-Key` | `run_submission`, `runs_idempotency` | `api_server_runs.py::_handle_runs` | yes | yes |
| Run status (reattach) | `GET /v1/runs/{id}` | `run_status` | `_handle_get_run` | yes | yes |
| Run events (SSE, `id:` = seq, `Last-Event-ID` resume, `replay.truncated`) | `GET /v1/runs/{id}/events` | `run_events_sse` | `_handle_run_events` | events yes; **resume semantics source only** | yes |
| Stop | `POST /v1/runs/{id}/stop` | `run_stop` | `_handle_stop_run` | yes | yes |
| Approval | `POST /v1/runs/{id}/approval` (`choice` ∈ once/session/always/deny, `request_id`) | `run_approval_response`, `approval_events` | `_handle_run_approval` | endpoint yes; **body schema source only** | yes (deny, once) |
| Image input | `/v1/runs` `input=[{role:"user",content:[text, image_url]}]` | `run_submission` | `_handle_runs` forwards the last message content to the agent; same agent contract as session chat's validated multimodal path | images documented for chat/session-chat, **not explicitly for runs** | yes (reported as `source_verified`) |
| Model choices | `GET /api/model/options` | `model_options` | `_handle_model_options` | yes | yes |
| Toolsets (read-only) | `GET /v1/toolsets` | endpoint `toolsets` | `_handle_toolsets` | yes | yes |
| Skills (read-only) | `GET /v1/skills` | `skills_api` | `_handle_skills` | yes | **Hermes defect in tested source**: `TypeError: _find_all_skills() got an unexpected keyword argument 'include_editorial'` (HTTP 500). dash shows the error and keeps working; verified. |
| Named profiles | `/p/<profile>/…` with that profile's own `API_SERVER_KEY` | `gateway.multiplex_profiles` | `_make_profile_prefix_middleware`, `_expected_api_key` | yes | yes |

### Run events dash understands

`message.delta`, `message.interim`, `reasoning.available`, `tool.started`, `tool.completed`
(with `error` flag), `tool.failed` (listed upstream, not emitted by the tested runs),
`subagent.start`, `subagent.complete`, `approval.request`, `approval.responded`,
`run.steered`, `run.completed`, `run.failed`, `run.cancelled`, `run.interrupted`,
`replay.truncated`. Anything else is passed through as an `unknown` marker and ignored by the
UI, so a newer Hermes does not break an older dash.

## Version differences and how they are isolated

| Difference | Where | dash behaviour |
|---|---|---|
| Upstream docs list only `register`, `fetchJSON`, components, `api`, `utils`, `useI18n` on the SDK; the tested SDK also has `sdkVersion`, `authedFetch`, `buildWsUrl` | `frontend/src/lib/api.ts::supportsStreaming` | `authedFetch` present → streaming; absent → `fetchJSON` for JSON and status polling for runs (approvals and final answers still work). |
| `GET /api/sessions` `title`/`include_hidden` are newer than the docs | `routes.py::_find_bot_chat` | Exact-title filtering is repeated client-side, so a Hermes that ignores the params cannot match a non-canonical row (same approach as `hermes peer dm`). |
| `tool.failed` documented upstream; tested runs send `tool.completed` with `error: true` | `events.py::normalize` | Both map to `phase: "failed"`. |
| Capability flags may be absent on older/newer servers | `routes.py::_derive_capabilities` | Each UI control is shown only when its flag/endpoint is advertised; missing → hidden, and the BFF refuses with `501 unsupported_capability`. |
| In-process helpers (`get_secret`, `plugin_data_dir`, `list_profiles`, `load_gateway_config`, `serving_profile_name`) may move | `dash_bff/compat.py` | Each has a fallback; what was used is reported in `GET /api/plugins/dash/status` → `compat`. |

## Not supported by the tested Hermes build (shown as unavailable, never mocked)

| Requested capability | Why unavailable |
|---|---|
| Tool **queued** state | No queued event exists on the run stream; dash shows running/completed/failed/denied/stopped only. |
| Tool-call ids on the live stream | Not emitted; live completions are matched FIFO by tool name. Historical tool calls use the stored `tool_call_id`. |
| "List active runs" for a session | No endpoint. dash stores a disposable `session → run_id` pointer in plugin-data to re-attach after reload. |
| Full-text message search via the API server | No endpoint. dash searches titles, previews and ids from `GET /api/sessions` (up to 1000 most recent). The Dashboard's own Sessions page keeps its full-text search. |
| SOUL / USER / MEMORY read | The API server exposes no read endpoint (`memory_write_api: false`, no SOUL route). dash does not read the files directly. |
| MCP server status | No API server endpoint. |
| Reasoning-effort control | `/v1/runs` accepts `model_options`, but its keys are not documented; dash only offers provider/model selection. |
| Arbitrary document attachments as native run input | Not supported by `/v1/runs`. dash's optional upload feature (off by default) stores the file and gives the agent its server path instead. |
| Steering a running agent | Supported by Hermes (`/v1/runs/{id}/steer`) but outside the mandate's scope; not exposed in the UI. |
