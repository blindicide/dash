# Security model

Hermes is a privileged local agent: it can run terminal commands, edit files and act on
connected accounts. dash is a remote control for it, so its security properties are the
Dashboard's plus the rules below. Report vulnerabilities as described in
[../SECURITY.md](../SECURITY.md).

## Trust boundaries

| Boundary | Enforcement |
|---|---|
| Browser → Dashboard | Hermes Dashboard auth: loopback session token (`X-Hermes-Session-Token`), or OAuth/password cookie (`SameSite=Lax`, HttpOnly) when the gate is on. Plugin routes are behind it, and disabled plugins get a 404 at request time. |
| Browser → dash BFF (mutations) | `X-Dash-Request: 1` required (a cross-site form cannot set it, and a cross-origin script would need a CORS preflight that the Dashboard refuses). A browser `Origin` must exactly equal the request's `scheme://Host` or an operator-listed `DASH_TRUSTED_ORIGINS` entry; client-supplied `X-Forwarded-*` headers are not trusted. JSON content type required. |
| dash BFF → Hermes API server | Bearer `API_SERVER_KEY` resolved server-side per profile through `agent.secret_scope.get_secret` inside the Dashboard's profile scope. Never logged, never returned, never stored by dash. Hermes enforces per-profile keys on `/p/<profile>/` and per-profile run ownership. |
| Browser input → upstream request | The browser chooses only a validated profile name, session id (`^[A-Za-z0-9][A-Za-z0-9_.:@+=-]{0,255}$`, no `..`), run id (`^run_[0-9a-f]{32}$`), and bounded text/images. It can never choose a URL, host, path, file or header for the upstream call. `DASH_HERMES_API_URL` is server-side configuration and is validated (scheme, no credentials, no query, http only on loopback by default). Redirects from Hermes are refused. Ambient proxy env vars are ignored (`trust_env=False`). |

## Hermes stays authoritative

- No conversation data is stored by dash. `plugin-data/dash/state.json` (mode 0600, atomic
  writes) holds only the last session id, `session → run_id` pointers (pruned after 24 h)
  and UI preferences. Deleting it loses nothing.
- dash never opens `state.db` or other Hermes databases. All mutations use the API server.
- dash refuses to delete the canonical Bot Chat, and to create or rename another session
  to that title.

## Approvals

- Approval cards show what Hermes supplied (Hermes redacts the flagged command before
  emitting it) and offer only the choices Hermes allows for that request.
- Nothing is approved automatically. The BFF forwards a choice only from an explicit
  `POST /runs/{id}/approval` with a valid `choice` and, when present, the exact
  `request_id`. "Always" and "session" choices are shown only when Hermes offers them.
- dash does not change Hermes' approval mode. If your Hermes runs with `approvals.mode: off`,
  dangerous commands will not ask for approval in dash either. Configure approval policy in
  Hermes.

## Rendering untrusted content

Assistant output, tool output and session titles are untrusted.

- Markdown is lexed with `marked` and rendered to React elements. No HTML string is ever
  injected (`dangerouslySetInnerHTML` is banned by lint), so raw HTML in a message renders
  as text.
- Links: only `http:`, `https:`, `mailto:`; control characters rejected; `target=_blank`
  with `rel="noopener noreferrer nofollow"`.
- Images: only inline `data:image/{png,jpeg,gif,webp};base64` render. Remote images become
  links and are never auto-fetched (no tracking pixels). SVG is never rendered.
- Tool arguments/results and error strings pass through a credential redactor (bearer
  tokens, `key=`/`token=`/`password=` pairs, `sk-…`, GitHub tokens, long hex strings) before
  reaching the browser. This is defence in depth on top of Hermes' own redaction, not a
  guarantee that arbitrary tool output contains no secrets.

## Images

PNG/JPEG/GIF/WebP only. The declared MIME type must match the decoded magic bytes. Sizes
and counts are limited (`DASH_IMAGE_MAX_BYTES`, `DASH_IMAGE_MAX_COUNT`, plus a 7,000,000-byte
total per message), and run request bodies are capped at 12 MiB. Images are sent to
Hermes as `data:` URLs inside the run input and are not written to disk by dash.

## Optional uploads (disabled by default)

Enabled only with `DASH_UPLOADS_ENABLED=1`:

- authenticated `POST /api/plugins/dash/uploads`, mutation guard applies;
- extension allow-list (`.txt .md .csv .json .log .pdf .png .jpg .jpeg .gif .webp`) plus
  content checks (magic bytes, or strict UTF-8 without NUL for text);
- streaming size cap (`DASH_UPLOAD_MAX_BYTES`, default 10 MB), with `Content-Length`
  pre-check;
- server-generated names `upl_<128-bit hex>.<ext>` in
  `<profile home>/plugin-data/dash/uploads/` (directory 0700, files 0600, `O_EXCL`); the
  client filename is sanitised display metadata only;
- the run text tells the agent the server path, so the agent reads the file with its own
  tools under its own policies;
- TTL cleanup (`DASH_UPLOAD_TTL_HOURS`, default 24 h) on each upload.
- removing an upload in the composer immediately calls the authenticated delete endpoint;
  a successful send also deletes its temporary upload after Hermes has accepted the run.

## Logging and privacy

dash logs only error class names, never request bodies, message text, tool output or
credentials. Errors returned to the browser are redacted and truncated.

## Browser storage

`localStorage` holds the selected profile name. `sessionStorage` (tab-scoped) holds unsent
composer drafts and a pending-submission record used for idempotent retry. That record
contains the request UUID and an exact digest of text, images, upload ids and model choice,
not image bytes, file content or message text. No credentials, tokens or conversation
history are stored in the browser by dash.

## Known limitations

- Anyone authenticated to the Dashboard can use dash with the Dashboard's privileges. This
  is the same trust level as the Dashboard's own Chat/terminal features.
- The redactor is pattern-based. Hermes' own redaction is the primary control.
- When uploads are enabled, uploaded files are readable by the agent (that is the point)
  and stay on disk until the TTL expires or the user deletes them.
