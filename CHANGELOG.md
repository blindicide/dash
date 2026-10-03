# Changelog

All notable changes to dash (`\`) are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.1] - 2026-10-03 — `dash`

Release-automation fix; the plugin itself is unchanged apart from its version.

### Fixed
- The tagged release workflow now fetches the annotated tag object before checking it.
  `actions/checkout` had fetched `v1.0.0` without it, so that tag's release job stopped and
  **no GitHub Release or archives were published for v1.0.0**. 1.0.1 is the first published
  release.

## [1.0.0] - 2026-10-03 — `dash`

The roadmap milestones 0.2.0 `continuity` through 0.9.0 `remote` were implemented on the way
to this release and are not published as separate versions.

### Added
- Complete conversation workspace for canonical Hermes sessions: grouped history, search,
  rename, pin, archive, delete, fork, drafts, mobile drawer and keyboard navigation.
- Native `/v1/runs` streaming with durable idempotency, reconnect/replay, reload recovery,
  cancellation, tool/subagent lifecycle cards and explicit approval handling.
- Canonical Bot Chat discovery/creation/protection and named-profile isolation using each
  profile's scoped API key and multiplexed Hermes routes.
- PNG/JPEG/GIF/WebP input, optional off-by-default validated file uploads, per-message model
  selection, and capability-gated read-only model/toolset/skill context.
- Reproducible install/source archives, checksums, installer, compatibility/security/
  deployment documentation, real-Hermes integration harness, CI and release automation.

### Changed
- Release and compatibility claims now name the exact tested Hermes source and distinguish
  real gateway/Dashboard/browser coverage from the scripted model provider.
- Pending-submit recovery fingerprints the complete request (text, images, uploads and
  model) without persisting message or attachment content.
- Reverse-proxy guidance requires exact trusted origins; mutation checks do not trust
  browser-supplied forwarding headers.

### Fixed
- Prevented stale profile/session requests and run callbacks from overwriting the active UI.
- Preserved exact request ids after lost image or upload submissions without replaying a
  different request under the same Hermes idempotency key.
- Cleared migrated new-chat drafts, supported attachment-only sends and document drops, and
  deleted temporary uploads when users remove them.
- Allowed upload-only BFF runs while retaining the requirement for at least one text, image
  or upload input.
- Kept image runs below Hermes' 10 MB request limit with a 7,000,000-byte per-message image
  budget (BFF, capabilities and composer).
- Stored upload metadata apart from the data file, so `.json` uploads no longer fail.
- Refused renaming the canonical Bot Chat, which would have orphaned it.
- Resumed half-open run streams after phone sleep or network changes via an idle watchdog,
  and settled runs whose stream ended without a terminal event.
- Never sent a first message into a session created for a previously selected profile, and
  dropped stale lost-response retry records once Hermes reports the run.
- Installer backups now live in `plugin-backups/`, outside the Dashboard's plugin scan.

## [0.1.0] - 2026-10-03 — `backslash`

### Added
- Hermes Dashboard frontend plugin mounted at `/dash` (tab after Chat) with `\ dash` branding and visible version.
- Dashboard backend plugin (BFF) at `/api/plugins/dash/` bridging to the Hermes API server; browser never sees the Hermes URL or `API_SERVER_KEY`.
- List/open Hermes sessions, load canonical messages, send text through native `/v1/runs`, stream the answer.
