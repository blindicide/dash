#!/usr/bin/env bash
# Build distributable dash artifacts into release/:
#
#   release/dash-vX.Y.Z.tar.gz          installable plugin package (+ install.sh, docs, README-PACK.md)
#   release/dash-vX.Y.Z-source.tar.gz   `git archive` of the committed tree (no untracked/operator files)
#   release/SHA256SUMS
#   release/README-PACK.md              manifest (also inside the package)
#
# Reproducible: file order, owners, permissions and mtimes (commit time, SOURCE_DATE_EPOCH)
# are normalised and gzip omits timestamps, so the same commit yields the same bytes given
# the same build toolchain. Refuses to package a dirty tracked tree unless
# DASH_ALLOW_DIRTY=1. Never includes .git, node_modules, caches, .env files or .integration/.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

node scripts/version.mjs check >/dev/null
VERSION="$(node scripts/version.mjs get)"
NAME="dash-v$VERSION"
OUT="$ROOT/release"
STAGE="$OUT/stage/$NAME"

if [[ -n "$(git status --porcelain --untracked-files=no)" && "${DASH_ALLOW_DIRTY:-0}" != "1" ]]; then
  echo "tracked files have uncommitted changes; commit first (or DASH_ALLOW_DIRTY=1 for a local test build)" >&2
  exit 1
fi
COMMIT="$(git rev-parse HEAD)"
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct)}"

if [[ "${DASH_SKIP_BUILD:-0}" != "1" ]]; then
  npm run -s build
fi
for f in plugin/dashboard/dist/index.js plugin/dashboard/dist/style.css; do
  [[ -s "$f" ]] || { echo "missing build output $f" >&2; exit 1; }
done

rm -rf "$OUT/stage" "$OUT/$NAME.tar.gz" "$OUT/$NAME-source.tar.gz" "$OUT/SHA256SUMS" "$OUT/README-PACK.md"
mkdir -p "$STAGE/dash/dashboard/dash_bff" "$STAGE/dash/dashboard/dist" "$STAGE/docs"

cp plugin/dashboard/manifest.json plugin/dashboard/plugin_api.py "$STAGE/dash/dashboard/"
cp plugin/dashboard/dash_bff/*.py "$STAGE/dash/dashboard/dash_bff/"
cp plugin/dashboard/dist/index.js plugin/dashboard/dist/style.css "$STAGE/dash/dashboard/dist/"
cp scripts/install.sh "$STAGE/install.sh"
cp README.md LICENSE CHANGELOG.md SECURITY.md "$STAGE/"
# Only committed docs (never a stray untracked note).
git ls-files -z -- 'docs/*.md' | xargs -0 -I{} cp {} "$STAGE/docs/"
chmod 755 "$STAGE/install.sh"

# Secret / junk guard on the staged tree.
if find "$STAGE" \( -name '.env*' -o -name '*.pem' -o -name '*.key' -o -name '__pycache__' -o -name 'node_modules' -o -name '.git' \) | grep -q .; then
  echo "refusing to package: forbidden file in stage" >&2
  exit 1
fi
if grep -RInE '(API_SERVER_KEY|OPENAI_API_KEY)=[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}' "$STAGE" >/dev/null; then
  echo "refusing to package: credential-shaped string in stage" >&2
  exit 1
fi

# --mode makes permissions independent of the builder's umask (664 vs 644 broke cross-machine
# reproducibility): files 644, directories and install.sh 755.
TAR_FLAGS=(--sort=name --owner=0 --group=0 --numeric-owner --mode=u=rwX,go=rX --mtime="@$SOURCE_DATE_EPOCH" --format=gnu)

write_manifest() { # target file
  local target="$1"
  {
    echo "# README-PACK — dash v$VERSION"
    echo
    echo "dash (\`\\\`) is a persistent web companion interface for Hermes Agent. Hermes remains"
    echo "the agent; dash is a Hermes Dashboard plugin (frontend tab + backend-for-frontend)."
    echo
    echo "- Version: $VERSION"
    echo "- Commit: $COMMIT"
    echo "- Built (SOURCE_DATE_EPOCH): $(date -u -d "@$SOURCE_DATE_EPOCH" +%Y-%m-%dT%H:%M:%SZ)"
    echo "- Tested Hermes: v0.21.5+6579.g3d0a61a / source 3d0a61ac (Dashboard plugin SDK 1.1.0); see docs/compatibility.md"
    echo "- License: MIT"
    echo
    echo "## Artifacts"
    echo
    echo "| File | Purpose |"
    echo "|------|---------|"
    echo "| \`$NAME.tar.gz\` | Installable package: \`dash/\` plugin directory, \`install.sh\`, docs |"
    echo "| \`$NAME-source.tar.gz\` | Full source of commit \`${COMMIT:0:12}\` (\`git archive\`) |"
    echo "| \`SHA256SUMS\` | Checksums of both archives |"
    echo
    echo "## Install"
    echo
    echo '```bash'
    echo "tar -xzf $NAME.tar.gz && cd $NAME && ./install.sh"
    echo '```'
    echo
    echo "Then follow the printed steps: add \`dash\` to \`plugins.enabled\`, enable the Hermes API"
    echo "server with a strong \`API_SERVER_KEY\`, restart the gateway and the Dashboard. Details:"
    echo "\`docs/install.md\`, deployment behind a proxy: \`docs/deployment.md\`."
    echo
    echo "## Package contents"
    echo
    echo '```'
    (cd "$OUT/stage" && find "$NAME" -type f ! -name README-PACK.md | LC_ALL=C sort | while read -r f; do
      printf '%s  %s\n' "$(sha256sum "$f" | cut -c1-64)" "$f"
    done)
    echo '```'
    echo
    echo "## Verification"
    echo
    echo "See \`docs/verification-report.md\` for gate outputs, the real-Hermes integration results and"
    echo "the explicit list of unverified items and limitations."
  } >"$target"
}

write_manifest "$STAGE/README-PACK.md"
(cd "$OUT/stage" && tar "${TAR_FLAGS[@]}" -cf - "$NAME" | gzip -n -9 >"$OUT/$NAME.tar.gz")
git archive --format=tar --prefix="$NAME-source/" "$COMMIT" | gzip -n -9 >"$OUT/$NAME-source.tar.gz"
(cd "$OUT" && sha256sum "$NAME.tar.gz" "$NAME-source.tar.gz" >SHA256SUMS)
cp "$STAGE/README-PACK.md" "$OUT/README-PACK.md"
{
  echo
  echo "## Archive checksums"
  echo
  echo '```'
  cat "$OUT/SHA256SUMS"
  echo '```'
} >>"$OUT/README-PACK.md"
rm -rf "$OUT/stage"
echo "packaged:"
ls -l "$OUT"
cat "$OUT/SHA256SUMS"
