# Contributing to dash

Thanks for helping. dash stays small and honest, so please keep these rules in mind:

1. **Hermes is the authority.** Never store conversations, never touch Hermes databases,
   never add a parallel agent or memory. Mutations go through the Hermes API server.
2. **No invented surfaces.** Use only Hermes endpoints, SDK members and manifest fields that
   exist in a released Hermes and, ideally, its docs. Record each one in
   `docs/compatibility.md` with the source location that defines it.
3. **Capability-gate everything.** Unsupported features are hidden and refused, not mocked.
4. **The browser never gets credentials** and never chooses URLs, hosts, paths or files.
5. **No HTML injection.** Render untrusted content as React elements (lint enforces this).

## Workflow

```bash
npm ci --include=dev && uv sync
npm run check
uv run ruff check . && uv run ruff format --check . && uv run pytest
```

For changes that touch Hermes integration, also run the real-Hermes harness
(`docs/development.md` → *Real-Hermes integration harness*) and mention the result in the PR.

- Keep commits scoped and descriptive (`feat(bff): …`, `fix(frontend): …`, `docs: …`).
- Add tests for security boundaries and state transitions you change.
- Bump versions only with `node scripts/version.mjs set X.Y.Z` plus a CHANGELOG entry.

By contributing you agree that your contributions are licensed under the MIT License.
