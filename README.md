# `\` dash

**dash (`\`) is a persistent web companion interface for Hermes Agent.** Hermes remains the
agent; dash is one more presentation layer on top of it, alongside the CLI and the
Dashboard. When dash opens Hermes' canonical Bot Chat, Bot-capable Hermes clients share
that session too.

dash is a [Hermes Dashboard](https://hermes-agent.nousresearch.com/docs/user-guide/features/extending-the-dashboard)
plugin. It adds a conversation-first tab at `/dash` and a small backend inside the Dashboard
that talks to the Hermes API server. Every message, session and run lives in Hermes, so a
conversation you start in dash is the same canonical history you see in `hermes sessions`
and the Dashboard. It is visible to a messaging transport when that transport is attached
to the same Hermes session.

## Features

- **Conversations**: sidebar grouped by date (pinned, today, yesterday, …), rename, pin,
  archive, delete with confirmation, fork/branch, title/preview search (Ctrl/Cmd+K).
- **Canonical Bot Chat**: opens the profile's existing "Bot Chat" and never creates a
  duplicate. Created through the Hermes API only when absent.
- **Native Hermes runs**: answers stream token by token over Hermes' `/v1/runs` events;
  sends are idempotent; an explicit **Stop** calls Hermes cancellation.
- **Survives reloads**: closing the tab, a network drop or phone sleep never cancels a run.
  dash re-attaches and resumes from the last event (`Last-Event-ID`) without resending.
- **Tool and approval cards**: running / completed / failed / denied / stopped tool cards
  with optional developer detail; approval requests show the command as Hermes reports it
  (with Hermes' own secret redaction) and need an explicit Approve or Deny.
- **Profiles**: switch between Hermes profiles; history, runs, drafts and dash state stay
  isolated per profile.
- **Images**: attach PNG/JPEG/GIF/WebP by picker, paste or drag-and-drop (validated
  type/size, previews). Optional general file uploads, off by default.
- **Model choice**: pick any model the Hermes profile offers for the next message (only
  models Hermes lists).
- **Read-only Hermes context**: toolsets and model inventory as exposed by the API server.
- **Safe rendering**: Markdown, code blocks with copy, tables and links rendered without HTML
  injection. Remote images are never auto-loaded.
- **Responsive and accessible**: mobile drawer, sticky composer, keyboard navigation,
  labelled controls, live status regions, theme-aware (uses the Dashboard's colours).

Features the tested Hermes build does not expose are shown as unavailable, never mocked:
SOUL/memory view, MCP status, full-text message search, tool "queued" state. See
[docs/compatibility.md](docs/compatibility.md).

## Requirements

- Hermes Agent with the Dashboard plugin system and API server. Tested:
  **v0.21.5+6579.g3d0a61a** / source `3d0a61ac` (Dashboard plugin SDK 1.1.0).
- The Hermes API server enabled with a strong `API_SERVER_KEY` (kept on loopback).

## Install

```bash
tar -xzf dash-vX.Y.Z.tar.gz && cd dash-vX.Y.Z
./install.sh
```

Then add `dash` to `plugins.enabled` in `~/.hermes/config.yaml`, enable the API server
(`API_SERVER_ENABLED=true`, `API_SERVER_KEY=…` in `~/.hermes/.env`), and restart the gateway
and the Dashboard. Full guide: [docs/install.md](docs/install.md). Remote access via
Tailscale, Caddy, nginx or Traefik (including SSE settings): [docs/deployment.md](docs/deployment.md).

## How it works

```
browser ─(Dashboard auth)─▶ Hermes Dashboard ─▶ /api/plugins/dash (BFF) ─(Bearer key, server-side)─▶ Hermes API server ─▶ Hermes sessions/runs
```

The browser never sees the Hermes API key and never talks to the API server. It can only
call `/api/plugins/dash/*` with a validated profile name. Details:
[docs/architecture.md](docs/architecture.md), [docs/api.md](docs/api.md),
[docs/security.md](docs/security.md).

## Development

```bash
npm ci --include=dev && uv sync
npm run check                       # lint, typecheck, tests, build
uv run ruff check . && uv run pytest
scripts/integration/env.sh up       # isolated real-Hermes environment
uv run python scripts/integration/e2e.py && node scripts/integration/browser_e2e.mjs
```

See [docs/development.md](docs/development.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## Status

Version **1.0.1**. Verified against a real Hermes gateway and Dashboard in an isolated
environment with a scripted model provider: 19 API-level and 7 real-Chromium end-to-end
checks. Live production-model use, external messaging delivery and remote proxy deployments
were not exercised. The full, candid account is in
[docs/verification-report.md](docs/verification-report.md).

## License

[MIT](LICENSE)
