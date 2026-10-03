# dash 1.0.0 verification report

Date: 2026-10-03 (Europe/Amsterdam)
Scope: release verification of the complete source tree, release metadata, documentation,
installer/package path, CI/release workflows, and real Hermes integration. Two independent
passes contributed: a continuation audit (fixes up to `ff2cae7`, with the API/browser
integration it reported) and a final continuation that re-ran every gate and both real
integration suites itself, fixed the defects listed below, and verified the **installed
release archive** against real Hermes. Every result in this report was produced by a command
that was actually run. Nothing is carried over unverified.

## Verdict

The 1.0.0 candidate meets the documented dash mandate for the Hermes surfaces that the
tested source exposes. The browser remains a presentation layer: Hermes owns sessions,
history, runs, profiles, models, tools and approvals. dash keeps only disposable UI pointers,
preferences and tab-scoped drafts/retry metadata. No parallel conversation database or
browser-visible Hermes credential was found.

The release archive, installed with its own `install.sh` into a fresh Hermes home, passed
**19/19 API-level checks and 7/7 real-Chromium checks** against the installed Hermes gateway
API server and Dashboard. Everything except the model provider was real: the plugin loader,
session store, run engine, SSE stream, tools, approval gate and profile multiplexer. The model
provider was a deterministic OpenAI-compatible stub. This is real Hermes/browser integration,
**not** a live-provider test.

## Exact environment

| Component | Tested value |
|---|---|
| dash | 1.0.0 (release commit `8cfe479`) |
| Hermes runtime | `Hermes Agent v0.21.5+6579.g3d0a61a (2026.9.24) · upstream 3d0a61ac` |
| Hermes source | `3d0a61ac94e1181985177fdd975c4efeb478e9b7`; `git describe`: `v0.21.4+canary.20261003T070620Z-355-g3d0a61ac94` (checkout clean) |
| Dashboard SDK | contract 1.1.0 (`web/src/plugins/registry.ts`) |
| Hermes runtime Python | 3.14.7 |
| Hermes runtime libraries | FastAPI 0.133.1, Starlette 1.3.1, httpx 0.28.1, Pydantic 2.13.4 |
| local Node/npm | Node 26.7.0, npm 11.19.0 |
| local Python tooling | uv 0.11.16, project venv Python 3.14 |
| browser | Chromium via `playwright-core` 1.63.0, headless |

The integration harness used fresh isolated `HERMES_HOME`s in a scratch directory, ran with
`env -i` and a scratch `$HOME` (no inherited credentials), generated scratch API keys with mode
0600, and never touched the operator's real Hermes home, sessions or gateway. The installed
Hermes launcher shim checksum was identical before and after (`f773bf77dda103d8…`).

## Local release gates (final tree)

| Command | Result |
|---|---|
| `npm ci --include=dev` | pass; npm audit: 0 vulnerabilities |
| `npm run check` | pass: version consistency (all six sources 1.0.0), ESLint, TypeScript, Vitest **6 files / 25 tests**, Vite production build (`index.js` 109 kB, `style.css` 15 kB) |
| bundle guard (as in CI) | pass: no `react.production` in `dist/index.js`; `__HERMES_PLUGIN_SDK__` referenced |
| `uv sync --locked` | pass |
| `uv run ruff check .` / `uv run ruff format --check .` | pass / pass (32 files) |
| `uv run pytest` | pass: **78 tests**; one upstream Starlette `TestClient`/httpx deprecation warning |
| `git diff --check` | pass |
| `bash scripts/package.sh` (twice, same commit) | identical SHA-256 for both archives locally. The first hosted CI build of the same commit produced an identical source archive and identical file contents, but a different install-archive hash, because tar recorded the builder's umask (664 vs 644). After permissions were normalised (`64dc4d2`), hosted CI run 37139401990 built `SHA256SUMS` identical to the local build of that commit (`5c648317…` install, `b52bee19…` source). |
| `shellcheck` | **not run**: not installed in this environment (`bash -n` syntax checks only) |

The frontend and backend suites are unit and component tests against fake upstreams. They
are not counted as real-Hermes evidence.

Hosted CI (`.github/workflows/ci.yml`) passed all seven jobs on `1a1c45b` (run 37139306654)
and `64dc4d2` (run 37139401990): frontend on Node 22 and 24, backend on Python 3.11–3.14, and
package. GitHub warned that the pinned `actions/checkout`, `setup-node` and `setup-uv`
majors target the deprecated Node 20 runtime. This is a maintenance item, not a failure.

Pinned GitHub Actions were resolved through the GitHub API. Each full commit id exists and
matches the tag in its comment (`actions/checkout` v4.4.0, `actions/setup-node` v4.4.0,
`astral-sh/setup-uv` v6.8.0, `actions/upload-artifact` v4.6.2).

## Real Hermes and browser integration

Commands (environment kept alive in a detached session, ports chosen to avoid the
operator's services):

```bash
bash scripts/package.sh                                  # clean committed tree
tar -xzf release/dash-v1.0.0.tar.gz -C "$PKG"
"$PKG/dash-v1.0.0/install.sh" --hermes-home "$DASH_IT_DIR/home"   # real directory, not a symlink
scripts/integration/env.sh up                            # keeps the installed plugins/dash
uv run python scripts/integration/e2e.py --report "$DASH_IT_DIR/e2e-report.json"
node scripts/integration/browser_e2e.mjs
scripts/integration/env.sh down
```

| Run | Plugin under test | API suite | Browser suite |
|---|---|---|---|
| A (re-check of the inherited tree before fixes) | working tree at `ff2cae7` + inherited 1.0.0 changes (symlink) | 19/19 at 2026-10-03T16:54:08Z | 7/7 at 2026-10-03T16:54:38Z |
| B (release evidence) | **installed archive** `dash-v1.0.0.tar.gz` built from `8cfe479` | **19/19 at 2026-10-03T17:04:41Z** | **7/7 at 2026-10-03T17:05:06Z** |

In run B, Hermes compiled `__pycache__` inside the installed `plugins/dash/dashboard/`, which
confirms that the BFF was imported from the installed copy.

API-level checks (each asserts on the real Hermes response, not on a dash echo):

- Dashboard auth gate (401 without session token) and plugin runtime gate;
- manifest, BFF and displayed version all 1.0.0; real Hermes reachable;
- API key absent from every browser-facing response;
- mutation header and exact-origin refusal;
- native `/v1/runs` send with streamed SSE answer and integer `seq` ids;
- canonical history read back through dash, the official Dashboard API, the API server, and
  the Hermes CLI (`hermes sessions list` / `sessions export`);
- durable idempotent replay: same `client_request_id` returns the same run, and exactly one
  user turn is recorded;
- disconnect mid-run, `active-run` rediscovery, resume with `Last-Event-ID` and a contiguous
  `seq` (`min(resumed) == last + 1`), completion without resend;
- explicit Stop through Hermes' stop API settles as `cancelled` (stream and status);
- real terminal-tool `started`/`completed` events;
- approval request plus explicit `deny` (action blocked) and `once` (action ran);
- native image input reaching the model through `/v1/runs`;
- rename, pin, fork, search and delete through Hermes;
- canonical Bot Chat is unique and protected, and a dash-authored Bot Chat turn is read back
  through the official Dashboard API and API server;
- plugin-data state file mode 0600, limited to disposable pointers/preferences;
- named-profile routing via `/p/<profile>/` with distinct keys; history, run and state
  isolation; cross-profile 404s;
- model override limited to Hermes-offered models and honoured by the run;
- read-only toolset/model discovery, with the broken skills endpoint degrading to a safe 502.

Browser checks (real Chromium inside the real Dashboard):

- plugin rendered as `\ dash v1.0.0`, Connected;
- browser send displayed the streamed answer;
- reload during an active run re-attached without a duplicate user turn;
- the approval card required an explicit Deny click;
- Ctrl/Cmd+K opened search, and plain Ctrl+N was not intercepted;
- the 390×844 viewport had a working drawer, sticky composer and 0 px horizontal overflow;
- no dash-related console errors.

## Final-continuation audit: defects found and fixed

An independent read-only review of the BFF, frontend and docs against the installed Hermes
source found no high-severity issue. Each finding was verified against the code before it was
fixed:

| Defect | Fix (commit) | Evidence |
|---|---|---|
| Images within dash's limits exceeded Hermes' 10 MB `MAX_REQUEST_BYTES` once base64-encoded (e.g. 2×4 MB photos → 413) | 7,000,000-byte per-message image budget in BFF, capabilities and composer; per-image max clamped; JSON body cap lowered to 12 MiB (`ea619fd`, `31d6199`) | unit test (budget + arithmetic bound vs 10,000,000) |
| `.json` uploads collided with their own metadata file (500, orphaned file) | metadata stored as `upl_<id>.meta.json` (`ea619fd`) | unit test (save/load/delete of a `.json` upload) |
| The canonical Bot Chat could be renamed through the BFF, orphaning it (the next lookup would create a duplicate) | rename refused with 409; pin/archive still allowed (`ea619fd`) | route test |
| A first send's session created after a profile/chat switch was adopted and sent into | abort when generation/profile changed (`31d6199`) | component test, confirmed to fail without the guard |
| Lost-response retry record survived after Hermes reported its run, so an identical later message could be swallowed as a replay | record dropped when `active-run` reports the same request id (`31d6199`) | code review; covered by the existing retry test path |
| Half-open stream after phone sleep could hang in "open" | 45 s idle watchdog (Hermes keepalive is 10 s) and stale-on-wake abort, then resume with `Last-Event-ID` (`31d6199`) | code review + existing reconnect tests; **not** exercised on a real sleeping device |
| Stream end without a terminal event could leave the UI "running"; finish ran inside a React state updater | status check on stream end; finish once, outside the updater (`31d6199`) | component test |
| Installer backup `dash.bak-*` stayed inside `plugins/` as a second plugin named `dash` (only sort order kept it inert) | backups move to `plugin-backups/` (`c965413`) | installer run twice into a scratch home |
| Package copied untracked `docs/*.md` | only committed docs are packaged (`1620323`) | package listing |
| 1.0.0 changelog codename was `backslash`; README claimed the approval card shows the "exact" command (Hermes redacts it) | codename `dash`; wording corrected (`8cfe479`, `92394af`) | — |

## API and security audit

- The frontend uses the documented plugin registration and host React singleton. React is
  excluded from the production bundle, and browser calls stay relative to
  `/api/plugins/dash/*`.
- The BFF is the only API-server caller. It resolves each profile's key in Hermes' scoped
  server context, uses an allow-listed target, refuses redirects and ambient proxy settings,
  and never returns the key.
- Mutation origins require an exact `scheme://Host` or an explicit exact
  `DASH_TRUSTED_ORIGINS` entry. `X-Forwarded-Host` is not trusted.
- Inputs, ids, image magic/size/count/total, model choices and optional uploads are bounded
  and validated. Uploads are off by default, use generated 0600 files, can be explicitly
  deleted, and are passed to the agent only by server-side path.
- Markdown becomes React elements without HTML injection. Remote images are not auto-loaded,
  link schemes and inline image types are allow-listed, and tool/error data is redacted.
- SSE is streamed, not buffered (`X-Accel-Buffering: no`, `Cache-Control: no-cache,
  no-transform`). Keepalives are forwarded, and a browser disconnect never cancels the run.
- Pending-submit recovery uses an exact digest of text, image MIME/data, upload ids and model.
  It stores neither text nor attachment bytes and cannot reuse an id for a different body.
- No direct Hermes database access, parallel chat store, automatic approval or invented
  success path was found.

Compatibility was checked against the installed source and the official Dashboard-plugin
and API-server documentation. Surfaces that are source-verified but incompletely documented
are listed individually in [compatibility.md](compatibility.md) and are not presented as
general SDK guarantees.

## Packaging and workflow audit

- The installer copies only the plugin tree, moves an existing install to
  `plugin-backups/`, validates the manifest/build outputs, never edits configuration, and
  prints the exact enable/restart steps. The printed `hermes gateway restart` and
  `hermes dashboard --stop` commands exist in the tested CLI.
- `package.sh` refuses a dirty tracked tree. It builds an install archive and a `git archive`
  source archive with stable order, owner and timestamps, scans the stage for
  credential-shaped data and forbidden files, and emits `SHA256SUMS` plus `README-PACK.md`
  (per-file and archive SHA-256).
- CI covers Node 22/24 and Python 3.11–3.14: locked installs, lint, types, unit tests,
  build, the host-React bundle guard, package construction and checksum verification.
- The release workflow requires an annotated `vX.Y.Z` tag, exact metadata/tag agreement,
  all local gates, a non-empty matching changelog section and checksum verification before
  `gh release create --verify-tag`.

## Candid gaps and upstream limitations

- **Model provider:** no production model/provider credentials were used. Model-network
  behavior, billing and provider-specific failures remain untested.
- **Messaging transports:** no live Telegram, Discord, Slack or other transport was
  connected. Bot Chat interoperability is proven through official Hermes APIs and the CLI,
  not through external message delivery.
- **Remote deployment:** Tailscale, SSH, Caddy, nginx, Traefik, gated OAuth/password auth and
  path-prefix setups were source-reviewed but not deployed end to end.
- **Browsers and devices:** only Chromium was exercised. Firefox/WebKit, a physical touch
  device and real phone sleep were not. The new idle watchdog is unit-level and code-reviewed
  only. No manual screen-reader audit was done.
- **Unit-only fixes:** the 7 MB image budget, `.json` upload metadata and Bot Chat rename
  refusal are covered by unit/route tests, not by a dedicated real-Hermes check. Optional
  uploads are disabled in the integration environment.
- **Skills endpoint:** the tested Hermes `GET /v1/skills` raises an upstream `TypeError`
  (`_find_all_skills()` has no `include_editorial` parameter) and returns 500. dash shows a
  redacted, retryable 502 and does not claim skills browsing works on this build.
- **Not exposed by Hermes:** SOUL/USER/MEMORY reads, MCP status, full-text message search,
  the queued tool state and native arbitrary-document run attachments are not exposed by the
  tested API. dash hides or labels them and does not mock them.
- **Milestones:** 0.2.0–0.9.0 were implemented on the way to 1.0.0 and were not published
  as separate releases or tags.
- **ShellCheck** was unavailable locally.
