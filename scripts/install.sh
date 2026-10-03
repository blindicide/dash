#!/usr/bin/env bash
# Install the dash Hermes Dashboard plugin into a Hermes home.
#
#   ./install.sh                        # installs ./dash -> ${HERMES_HOME:-~/.hermes}/plugins/dash
#   ./install.sh --hermes-home /path    # explicit Hermes home (root home, not a profile dir)
#   ./install.sh --from /path/to/dash   # plugin directory to install (default: ./dash next to this script)
#
# Never edits config.yaml and never restarts anything: it prints the exact remaining steps.
# An existing install is moved to <hermes home>/plugin-backups/dash-<timestamp> (nothing is
# deleted). Backups live outside plugins/ so the Dashboard never discovers a second "dash".
set -euo pipefail

HERMES_HOME_DIR="${HERMES_HOME:-$HOME/.hermes}"
SRC=""
while (($#)); do
  case "$1" in
    --hermes-home) HERMES_HOME_DIR="$2"; shift 2 ;;
    --from) SRC="$2"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "$SRC" ]]; then
  if [[ -d "$HERE/dash/dashboard" ]]; then SRC="$HERE/dash"        # release archive layout
  elif [[ -d "$HERE/../plugin/dashboard" ]]; then SRC="$HERE/../plugin"  # source checkout layout
  else echo "cannot find the plugin directory; pass --from" >&2; exit 1; fi
fi
for f in dashboard/manifest.json dashboard/plugin_api.py dashboard/dist/index.js dashboard/dist/style.css; do
  [[ -f "$SRC/$f" ]] || { echo "missing $SRC/$f (build the frontend: npm run build)" >&2; exit 1; }
done
[[ -d "$HERMES_HOME_DIR" ]] || { echo "Hermes home not found: $HERMES_HOME_DIR" >&2; exit 1; }

DEST="$HERMES_HOME_DIR/plugins/dash"
mkdir -p "$HERMES_HOME_DIR/plugins"
if [[ -e "$DEST" || -L "$DEST" ]]; then
  mkdir -p "$HERMES_HOME_DIR/plugin-backups"
  BACKUP="$HERMES_HOME_DIR/plugin-backups/dash-$(date +%Y%m%d%H%M%S)"
  mv "$DEST" "$BACKUP"
  echo "previous install moved to $BACKUP"
fi
mkdir -p "$DEST"
cp -R "$SRC/dashboard" "$DEST/dashboard"
find "$DEST" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$DEST/dashboard/manifest.json")"
echo "installed dash v$VERSION -> $DEST"

ENABLED="no"
if grep -Eq '^[[:space:]]*-[[:space:]]*["'"'"']?dash["'"'"']?[[:space:]]*$' "$HERMES_HOME_DIR/config.yaml" 2>/dev/null; then ENABLED="probably"; fi

cat <<EOF

Remaining steps (dash does not change your Hermes configuration for you):

1. Enable the plugin for the Dashboard. User plugins only get their backend routes and
   static files served when listed in plugins.enabled in $HERMES_HOME_DIR/config.yaml:

     plugins:
       enabled:
         - dash          # keep any entries you already have
$( [[ "$ENABLED" == "probably" ]] && echo "   (a 'dash' entry already appears in config.yaml)" )
2. Make sure the Hermes API server is enabled with a strong key (in $HERMES_HOME_DIR/.env):
     API_SERVER_ENABLED=true
     API_SERVER_KEY=<output of: openssl rand -hex 32>
   and restart the gateway:  hermes gateway restart
   (dash reads this key server-side; the browser never sees it.)

3. Restart the Dashboard so it mounts /api/plugins/dash/ (backend routes mount at startup):
     hermes dashboard --stop && hermes dashboard

4. Open the Dashboard and choose the "\\ dash" tab (path /dash).
EOF
