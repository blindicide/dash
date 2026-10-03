# Changelog

All notable changes to dash (`\`) are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-03 — `backslash`

### Added
- Hermes Dashboard frontend plugin mounted at `/dash` (tab after Chat) with `\ dash` branding and visible version.
- Dashboard backend plugin (BFF) at `/api/plugins/dash/` bridging to the Hermes API server; browser never sees the Hermes URL or `API_SERVER_KEY`.
- List/open Hermes sessions, load canonical messages, send text through native `/v1/runs`, stream the answer.
