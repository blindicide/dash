#!/usr/bin/env bash
# Isolated real-Hermes integration environment for dash.
#
#   scripts/integration/env.sh up      # create scratch HERMES_HOME, start model stub, gateway API server, dashboard
#   scripts/integration/env.sh down    # stop everything started by `up`
#   scripts/integration/env.sh status
#
# Uses the INSTALLED Hermes source + its already-installed runtime venv with a throwaway
# HERMES_HOME under .integration/, so the operator's real ~/.hermes, its gateway and its
# sessions are never touched. Only the LLM provider is replaced (scripted_model.py); Hermes
# itself is real. The API server key is generated per run, written only into the scratch
# home's .env (mode 600) and never printed.
#
# SAFETY: do NOT run the `hermes` launcher with a fresh HERMES_HOME. Its bootstrap
# (hermes_bootstrap -> venv_sync.prepare_launch) provisions a new runtime for that home and,
# on Hermes v0.21.5, regenerates the shared checkout launcher shims
# (<hermes-agent>/.hermes/bin/hermes, hermes-acp) to point at the scratch interpreter. This
# script therefore starts `hermes_cli.main` with the installed runtime venv and
# HERMES_DISABLE_LAZY_INSTALLS=1 (the supported opt-out that makes prepare_launch a no-op),
# runs the dashboard with --isolated (the user's machine-level Dashboard keeps the host
# lock), and checksums the launcher shims before/after, failing loudly on change.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="${DASH_IT_DIR:-$ROOT/.integration}"
HOME_DIR="$WORK/home"
MODEL_PORT="${DASH_IT_MODEL_PORT:-18765}"
API_PORT="${DASH_IT_API_PORT:-18642}"
DASH_PORT="${DASH_IT_DASHBOARD_PORT:-19119}"
PY="${DASH_IT_PYTHON:-python3}"
HERMES_SRC="${DASH_IT_HERMES_SRC:-$HOME/.hermes/hermes-agent}"
SHIMS=("$HERMES_SRC/.hermes/bin/hermes" "$HERMES_SRC/.hermes/bin/hermes-acp")

# The installed runtime venv that can run Hermes (override with DASH_IT_HERMES_VENV_PY).
runtime_python() {
  if [[ -n "${DASH_IT_HERMES_VENV_PY:-}" ]]; then echo "$DASH_IT_HERMES_VENV_PY"; return; fi
  local best="" best_t=0 v t
  for v in "$HOME"/.hermes/installs/*/environments/*/venv/bin/python; do
    [[ -x "$v" ]] || continue
    "$v" -I -c "import ruamel.yaml, fastapi, aiohttp, httpx" >/dev/null 2>&1 || continue
    t=$(stat -c %Y "$(dirname "$(dirname "$v")")/pyvenv.cfg" 2>/dev/null || echo 0)
    if ((t > best_t)); then best="$v"; best_t=$t; fi
  done
  [[ -n "$best" ]] || { echo "no usable Hermes runtime venv found; set DASH_IT_HERMES_VENV_PY" >&2; exit 1; }
  echo "$best"
}

# `hermes <args...>` with the scratch HERMES_HOME, without the bootstrap launcher. Printed as
# an argv (one per line) so callers can exec it (keeps the recorded PID = the Python PID).
HERMES_MAIN="import sys; sys.path.insert(0, sys.argv.pop(1)); from hermes_cli.main import main; sys.argv[0] = 'hermes'; sys.exit(main())"
# Scrubbed environment: no inherited credentials, and a scratch $HOME so Hermes cannot
# discover the operator's auth stores (CLI logins, keyrings) or touch their per-user host
# lock/rendezvous directory.
FAKE_HOME="$WORK/userhome"
sandbox_env() {
  echo env -i "HOME=$FAKE_HOME" "PATH=/usr/local/bin:/usr/bin:/bin" "LANG=C.UTF-8" "TZ=${TZ:-UTC}" \
    "HERMES_HOME=$HOME_DIR" "HERMES_DISABLE_LAZY_INSTALLS=1"
}
hermes_direct() {
  mkdir -p "$FAKE_HOME"
  # shellcheck disable=SC2046
  $(sandbox_env) "$(runtime_python)" -I -c "$HERMES_MAIN" "$HERMES_SRC" "$@"
}

shim_sums() { sha256sum "${SHIMS[@]}" 2>/dev/null || true; }

pidfile() { echo "$WORK/$1.pid"; }

wait_http() { # url, seconds
  local url="$1" deadline=$((SECONDS + $2))
  until curl -fsS -o /dev/null "$url" 2>/dev/null; do
    if ((SECONDS > deadline)); then echo "timeout waiting for $url" >&2; return 1; fi
    sleep 0.5
  done
}

start_bg() { # name, logfile, cmd...
  local name="$1" log="$2"; shift 2
  ("$@" >"$log" 2>&1 & echo $! >"$(pidfile "$name")")
}

up() {
  mkdir -p "$WORK" "$HOME_DIR/plugins" "$WORK/danger"
  chmod 700 "$WORK" "$HOME_DIR"
  if [[ ! -f "$ROOT/plugin/dashboard/dist/index.js" ]]; then
    echo "build the frontend first: npm run build" >&2
    exit 1
  fi
  ln -sfn "$ROOT/plugin" "$HOME_DIR/plugins/dash"

  cat >"$HOME_DIR/config.yaml" <<YAML
model:
  default: scripted
  provider: custom
  base_url: http://127.0.0.1:${MODEL_PORT}/v1
approvals:
  mode: manual
  timeout: 300
plugins:
  enabled:
    - dash
gateway:
  multiplex_profiles: true
platforms:
  api_server:
    enabled: true
    extra:
      host: 127.0.0.1
      port: ${API_PORT}
YAML
  if [[ ! -f "$HOME_DIR/.env" ]]; then
    umask 077
    {
      echo "API_SERVER_ENABLED=true"
      echo "API_SERVER_KEY=$(openssl rand -hex 32)"
      echo "API_SERVER_PORT=${API_PORT}"
      echo "API_SERVER_HOST=127.0.0.1"
      echo "OPENAI_API_KEY=dash-e2e-placeholder-not-a-secret"
    } >"$HOME_DIR/.env"
  fi
  chmod 600 "$HOME_DIR/.env"

  # Secondary profiles served through the multiplexed listener at /p/<name>/, each with its
  # OWN API_SERVER_KEY (Hermes rejects the default key on a named prefix). --no-alias keeps
  # Hermes from writing wrapper scripts outside the scratch home.
  local prof
  for prof in ${DASH_IT_PROFILES-work}; do
    if [[ ! -d "$HOME_DIR/profiles/$prof" ]]; then
      hermes_direct profile create "$prof" --clone --no-alias >"$WORK/profile-$prof.log" 2>&1
    fi
    local penv="$HOME_DIR/profiles/$prof/.env"
    if ! grep -q "^# dash-it distinct key" "$penv" 2>/dev/null; then
      grep -v '^API_SERVER_KEY=' "$penv" >"$penv.tmp" 2>/dev/null || true
      { echo "# dash-it distinct key"; echo "API_SERVER_KEY=$(openssl rand -hex 32)"; } >>"$penv.tmp"
      mv "$penv.tmp" "$penv"
    fi
    chmod 600 "$penv"
  done

  : >"$WORK/model-requests.jsonl"
  start_bg model "$WORK/model.log" "$PY" "$ROOT/scripts/integration/scripted_model.py" \
    --port "$MODEL_PORT" --log "$WORK/model-requests.jsonl" --danger-target "$WORK/danger/target"
  wait_http "http://127.0.0.1:${MODEL_PORT}/v1/models" 20

  shim_sums >"$WORK/shims.before"
  local rpy; rpy="$(runtime_python)"
  mkdir -p "$FAKE_HOME"
  # shellcheck disable=SC2046
  start_bg gateway "$WORK/gateway.log" $(sandbox_env) "$rpy" -I -c "$HERMES_MAIN" "$HERMES_SRC" gateway run
  wait_http "http://127.0.0.1:${API_PORT}/health" 180

  # shellcheck disable=SC2046
  start_bg dashboard "$WORK/dashboard.log" $(sandbox_env) "$rpy" -I -c "$HERMES_MAIN" "$HERMES_SRC" \
    dashboard --isolated --host 127.0.0.1 --port "$DASH_PORT" --skip-build --no-open
  wait_http "http://127.0.0.1:${DASH_PORT}/" 180
  check_shims
  echo "up: model :${MODEL_PORT}, api :${API_PORT}, dashboard http://127.0.0.1:${DASH_PORT}/dash (HERMES_HOME=$HOME_DIR)"
}

check_shims() {
  if [[ -f "$WORK/shims.before" ]] && ! diff -q <(shim_sums) "$WORK/shims.before" >/dev/null; then
    echo "ERROR: Hermes launcher shims changed during the integration run:" >&2
    diff <(shim_sums) "$WORK/shims.before" >&2 || true
    exit 3
  fi
}

down() {
  for name in dashboard gateway model; do
    local f; f="$(pidfile "$name")"
    if [[ -f "$f" ]]; then
      local pid; pid="$(cat "$f")"
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
        kill -9 "$pid" 2>/dev/null || true
      fi
      rm -f "$f"
    fi
  done
  check_shims
  echo "down"
}

status() {
  for name in model gateway dashboard; do
    local f; f="$(pidfile "$name")"
    if [[ -f "$f" ]] && kill -0 "$(cat "$f")" 2>/dev/null; then echo "$name: running ($(cat "$f"))"; else echo "$name: stopped"; fi
  done
}

case "${1:-}" in
  up) up ;;
  hermes) shift; hermes_direct "$@" ;;
  down) down ;;
  status) status ;;
  *) echo "usage: $0 up|down|status|hermes <args>" >&2; exit 2 ;;
esac
