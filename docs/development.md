# Development

## Layout

```
plugin/                  → installs as ~/.hermes/plugins/dash
  dashboard/manifest.json
  dashboard/plugin_api.py   (Dashboard entry; loads dash_bff)
  dashboard/dash_bff/       (Python BFF package)
  dashboard/dist/           (build output, not committed)
frontend/src/            TypeScript/React plugin UI
frontend/test/           Vitest + Testing Library
tests/backend/           pytest for the BFF
scripts/                 version, package, install, integration harness
docs/                    documentation
```

## Toolchain

- Node ^22.22.2, ^24.15.0 or ≥ 26 (required by Vitest 5 / jsdom 30; CI: 22 and 24), npm. If your shell exports `NODE_ENV=production`, install
  with `npm ci --include=dev`.
- Python ≥ 3.11 (CI: 3.11–3.14) with [uv](https://docs.astral.sh/uv/). Runtime deps
  (FastAPI, httpx) are provided by the Hermes Dashboard. The `dev` group only exists for
  tests.

```bash
npm ci --include=dev
uv sync

npm run check          # version consistency, eslint, tsc, vitest, vite build
uv run ruff check . && uv run ruff format --check . && uv run pytest
```

`npm run build` writes `plugin/dashboard/dist/index.js` and `style.css`. React and
`react/jsx-runtime` are aliased to `frontend/src/sdk-shims/`, so the bundle uses the host's
React. Never add a dependency that bundles its own React.

## Live development against a Hermes Dashboard

```bash
npm run build
ln -s "$PWD/plugin" ~/.hermes/plugins/dash     # or scripts/install.sh
# add `dash` to plugins.enabled in ~/.hermes/config.yaml, then
hermes dashboard --stop; hermes dashboard
```

Frontend changes only need `npm run build` and a page reload. BFF changes need a Dashboard
restart, because plugin routes are mounted at startup.

## Real-Hermes integration harness

`scripts/integration/` runs the **installed** Hermes (gateway API server + Dashboard + this
plugin) in a throwaway `HERMES_HOME` under `.integration/`, with a scripted
OpenAI-compatible model so runs are deterministic and free. Hermes itself is real: sessions,
runs, SSE, tool execution, the approval gate, persistence and profile multiplexing.

```bash
npm run build
scripts/integration/env.sh up          # ports 18765 (model), 18642 (API), 19119 (Dashboard)
uv run python scripts/integration/e2e.py      # API-level checks → .integration/e2e-report.json
node scripts/integration/browser_e2e.mjs      # headless Chromium → .integration/browser-report.json
scripts/integration/env.sh down
```

The browser suite uses `playwright-core` and an already-installed Chromium (no download).
Install one with `npx playwright install chromium` if needed.

`DASH_IT_DIR` and `DASH_IT_{MODEL,API,DASHBOARD}_PORT` relocate the environment. To test a
release archive instead of the working tree, unpack it and run its
`install.sh --hermes-home "$DASH_IT_DIR/home"` before `env.sh up`: the harness keeps an
installed `plugins/dash` directory and only symlinks the working tree when none exists.

Safety properties of the harness (see the header of `env.sh`):

- It never runs the `hermes` launcher with the scratch home. On Hermes v0.21.5 that launcher
  provisions a runtime for a fresh `HERMES_HOME` and rewrites the shared checkout launcher
  shims. The harness starts `hermes_cli.main` from the installed runtime venv with
  `HERMES_DISABLE_LAZY_INSTALLS=1`, and checksums the shims before and after.
- Hermes processes run with `env -i` and a scratch `$HOME`, so they cannot see your
  credentials or auth stores, and do not touch your per-user host lock.
- The Dashboard runs with `--isolated`, so your own machine-level Dashboard keeps ownership
  of the host.
- Generated API keys exist only in `.integration/home/**/.env` (0600, git-ignored).

## Versioning and releases

`node scripts/version.mjs set X.Y.Z` updates `package.json`, `package-lock.json`,
`pyproject.toml`, the plugin manifest and `dash_bff/version.py`. Add a matching
`## [X.Y.Z]` entry to `CHANGELOG.md`. `node scripts/version.mjs check` (run in CI) fails on
any mismatch. In a tag build it also fails when the tag differs from `vX.Y.Z`.

`scripts/package.sh` builds `release/dash-vX.Y.Z.tar.gz` (installable package),
`release/dash-vX.Y.Z-source.tar.gz` (`git archive`), `SHA256SUMS` and `README-PACK.md`,
with normalised order/owners/mtimes (`SOURCE_DATE_EPOCH` = commit time).

Pushing an annotated tag `vX.Y.Z` runs `.github/workflows/release.yml`: gates, package,
checksum verification, and a GitHub Release with the archives.

## Coding rules

- Hermes API calls only in `dash_bff/hermes_client.py`. Hermes in-process imports only in
  `dash_bff/compat.py`.
- Never invent Hermes endpoints, SDK members or manifest fields. Add a row to
  `docs/compatibility.md` (with the defining source location) for any new surface.
- Capability-gate every feature. Unsupported means hidden and refused with
  `unsupported_capability`, never mocked.
- Tests must cover security boundaries and state transitions rather than implementation
  trivia.
