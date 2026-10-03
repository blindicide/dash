# Installing dash

dash is a Hermes Dashboard plugin. It needs:

- Hermes Agent with the Dashboard plugin system and the API server (tested:
  **v0.21.5+6579.g3d0a61a**, source `3d0a61ac`; see
  [compatibility.md](compatibility.md)).
- The Hermes **API server** enabled on the gateway, with a strong `API_SERVER_KEY`.
- The Hermes **Dashboard** (`hermes dashboard`) — dash runs inside it.

dash does not start its own Hermes process. It talks to the gateway you already run, so its
sessions show up in the CLI and Dashboard. A messaging transport sees the same history when
it is attached to that session; dash's **Bot Chat** action targets Hermes' canonical Bot
Chat session.

## 1. Enable the Hermes API server

In `~/.hermes/.env` (or the profile's `.env`):

```bash
API_SERVER_ENABLED=true
API_SERVER_KEY=<output of: openssl rand -hex 32>
# optional; defaults shown
API_SERVER_HOST=127.0.0.1
API_SERVER_PORT=8642
```

Keep the API server on loopback (`127.0.0.1`). dash's backend runs in the same machine's
Dashboard process and is the only thing that needs to reach it. Restart the gateway:

```bash
hermes gateway restart
curl -s http://127.0.0.1:8642/health      # → {"status": "ok", …}
```

> The key is a credential for a terminal-capable agent. Never put it in a browser, a URL
> or a committed file. dash reads it server-side through Hermes' profile-scoped secret API.

## 2. Install the plugin files

From a release archive:

```bash
tar -xzf dash-vX.Y.Z.tar.gz
cd dash-vX.Y.Z
./install.sh                       # → ~/.hermes/plugins/dash   (or --hermes-home DIR)
```

From a source checkout:

```bash
npm ci --include=dev && npm run build
./scripts/install.sh               # copies ./plugin as ~/.hermes/plugins/dash
```

The installer moves any previous install to `~/.hermes/plugin-backups/dash-<timestamp>`
(outside `plugins/`, so the Dashboard never discovers two plugins named `dash`). It never edits
`config.yaml` and never restarts services.

## 3. Enable it for the Dashboard

The Dashboard only imports a user plugin's backend, and only serves its JS/CSS, when the
plugin is listed in `plugins.enabled` in `~/.hermes/config.yaml`:

```yaml
plugins:
  enabled:
    - dash        # keep the entries you already have
```

`hermes plugins enable dash` does **not** work here: that command manages agent plugins
(with a `plugin.yaml`), and dash deliberately has no agent-side code.

## 4. Restart the Dashboard

Backend routes are mounted at Dashboard startup:

```bash
hermes dashboard --stop
hermes dashboard            # or your systemd/launchd unit
```

Open the Dashboard. A **`\ dash`** tab appears after **Chat** (path `/dash`). The header
shows the dash version and a green **Connected** dot when the API server is reachable.

## Configuration (server-side environment of the Dashboard process)

| Variable | Default | Meaning |
|---|---|---|
| `DASH_HERMES_API_URL` | from Hermes config (`platforms.api_server` / `API_SERVER_HOST`/`PORT`) | Override the API server base URL. http is allowed only for loopback unless `DASH_ALLOW_REMOTE_HTTP=1`; credentials, query or fragment in the URL are refused. Named profiles use `<url>/p/<profile>`. |
| `DASH_ALLOW_REMOTE_HTTP` | `0` | Permit plain-http to a non-loopback API server (not recommended). |
| `DASH_HTTP_TIMEOUT` | `30` | Seconds for non-streaming Hermes calls (5–300). |
| `DASH_TRUSTED_ORIGINS` | — | Extra comma-separated exact origins accepted for mutations when the browser-facing origin differs from the request's `scheme://Host`. |
| `DASH_IMAGE_MAX_BYTES` / `DASH_IMAGE_MAX_COUNT` | `5242880` / `4` | Per-image size (at most 7,000,000) and count limits. All images of one message also share a fixed 7,000,000-byte budget so the run request stays below Hermes' 10 MB body limit. |
| `DASH_UPLOADS_ENABLED` | `0` | Enable optional general file uploads (see [security.md](security.md)). |
| `DASH_UPLOAD_MAX_BYTES` / `DASH_UPLOAD_TTL_HOURS` | `10485760` / `24` | Upload limits and retention. |
| `DASH_DATA_DIR` | `<profile home>/plugin-data/dash` | Override the UI state directory (tests). |

## Multiple profiles

dash lists Hermes profiles and can switch between them. For a named profile it calls the
documented multiplexed route `/p/<profile>/…` with **that profile's own** `API_SERVER_KEY`:

```yaml
# ~/.hermes/config.yaml
gateway:
  multiplex_profiles: true
```

```bash
# ~/.hermes/profiles/<name>/.env
API_SERVER_KEY=<a different strong key>
```

A profile that runs its own gateway on a different port is reached at that address
instead. A profile with no key is shown as unavailable (Hermes fails closed).

## Upgrade / uninstall

- Upgrade: run the new release's `install.sh`, then restart the Dashboard.
- Uninstall: remove `dash` from `plugins.enabled`, restart the Dashboard, then delete
  `~/.hermes/plugins/dash`. The disposable UI state is in
  `<profile home>/plugin-data/dash/` and can be deleted at any time. Your conversations are
  untouched because they live in Hermes.
