#!/usr/bin/env sh
# Bring up the whole SoloW stack for local development:
#   - web app (Next.js SPA + tRPC API)          → http://localhost:5000
#   - orchestrator (WebSocket hub + /events +
#     /api/inngest, Decision 0004)               → http://localhost:5001
#   - Inngest server (inngest start) (the durable engine
#     Decision 0004 chose, run locally)          → http://localhost:8288
# All three share one SQLite database and a persistent encryption key so stored secrets stay
# decryptable across runs. First run migrates + seeds automatically. Ctrl-C stops all three.
set -eu

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

# shellcheck disable=SC2034 # read by scripts/lib/data-dir.sh
LOG_TAG=dev
# The data folder ($SOLOW_HOME, default .solow/), the absolute roots under it, the pid file.
# shellcheck source=/dev/null
. "$ROOT/scripts/lib/data-dir.sh"
# shellcheck source=/dev/null
. "$ROOT/scripts/lib/supervise.sh"

# Persistent 32-byte base64 key (kept out of git via .gitignore's /.solow/).
KEY_FILE="$GC_DIR/dev-secret.key"
if [ ! -f "$KEY_FILE" ]; then
    openssl rand -base64 32 > "$KEY_FILE"
    echo "[dev] generated $KEY_FILE"
fi

SOLOW_SQLITE_PATH="$GC_DIR/solow.db"
SOLOW_SECRET_KEY="$(cat "$KEY_FILE")"
export SOLOW_SQLITE_PATH SOLOW_SECRET_KEY
export SOLOW_DB_DRIVER="${SOLOW_DB_DRIVER:-sqlite}"
# Sign-in is on: the first visit to /sign-in creates the single Owner account. Feature flags
# default ON, so nothing has to be switched on after that; `bun run flag list` shows them and
# `bun run flag disable <key>` is the kill switch.
# Dev-owner mode (every visitor is the Owner, no sign-in) exists only for development and is
# never a default here: opt in with SOLOW_DEV_OWNER=on, and only on a machine nobody else can reach.
export SOLOW_DEV_OWNER="${SOLOW_DEV_OWNER:-off}"
# Which interface the web app, the orchestrator and Inngest listen on. Loopback by default; set
# SOLOW_BIND_HOST=0.0.0.0 to reach the stack from the network, which is only sensible behind
# sign-in (and a reverse proxy with TLS).
export SOLOW_BIND_HOST="${SOLOW_BIND_HOST:-127.0.0.1}"
case "$SOLOW_BIND_HOST" in
    127.* | localhost | ::1) ;;
    *) echo "[dev] WARNING: SOLOW_BIND_HOST=$SOLOW_BIND_HOST exposes SoloW to the network; anyone who can reach it can attempt to sign in." >&2 ;;
esac
if [ "$SOLOW_DEV_OWNER" = "on" ]; then
    echo "[dev] WARNING: SOLOW_DEV_OWNER=on — there is no sign-in and every visitor is the Owner." >&2
    case "$SOLOW_BIND_HOST" in
        127.* | localhost | ::1) ;;
        *)
            echo "[dev] refusing to start: dev-owner mode on a non-loopback SOLOW_BIND_HOST would hand the machine to the network." >&2
            exit 1
            ;;
    esac
fi
# The Claude Code binary each run's agent_catalog row names (packages/db/src/harness-catalog-
# defaults.ts seeds "claude"; these two are read by nothing in apps/orchestrator/src today, so
# they do not override that — kept only for a deployment that wires its own catalog lookup to
# them). SoloW adds the arguments it needs itself, including --worktree, so each Task gets
# its own working tree off the repository.
export SOLOW_AGENT_COMMAND="${SOLOW_AGENT_COMMAND:-claude}"
export SOLOW_AGENT_ARGS="${SOLOW_AGENT_ARGS:-}"
# `apps/web/package.json` says 5000 as well; the `--port` passed below comes later on the command
# line and wins, the same way `--hostname` does, so a second stack can run beside the first.
SOLOW_WEB_PORT="${SOLOW_WEB_PORT:-5000}"
export SOLOW_WS_PORT="${SOLOW_WS_PORT:-5001}"
export SOLOW_WS_URL="${SOLOW_WS_URL:-ws://localhost:$SOLOW_WS_PORT}"
export SOLOW_WEB_URL="${SOLOW_WEB_URL:-http://localhost:$SOLOW_WEB_PORT}"
export SOLOW_INNGEST_PORT="${SOLOW_INNGEST_PORT:-8288}"
# The session and stream-ticket secrets, the signing + event keys for `inngest start`, the
# web->orchestrator secret (B3, F6), and the loopback URLs the services reach each other on.
# shellcheck source=/dev/null
. "$ROOT/scripts/lib/engine-env.sh"

# From here until exit the folder is ours: nothing else may migrate it, start on it or restore
# into it. The traps stop the services and give the folder back however this script ends.
cleanup() {
    trap - INT TERM EXIT
    supervise_stop
    release_data_dir
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 0' TERM
claim_data_dir

# Database setup. Migrations run on every start, not just the first: drizzle skips the ones
# already recorded, so this is cheap, and without it an existing dev database silently drifts
# behind main and the API 500s on tables that do not exist yet. When one is pending, the migration
# first takes a consistent copy of the database and its keys into $SOLOW_HOME/backups (F1).
if [ ! -f "$SOLOW_SQLITE_PATH" ]; then
    echo "[dev] initializing database at $SOLOW_SQLITE_PATH"
fi
bun run db:migrate
# Every start, not only the first: this creates the Workspace and its harness catalog and nothing
# else, so it is a no-op once they exist — and a database from a build that predates the catalog
# gets one instead of a Settings page with an empty harness picker.
bun run db:bootstrap

# Each service under its own supervisor (scripts/lib/supervise.sh): one that crashes is started
# again after a short backoff while the other two keep running. Only a service that keeps crashing
# takes the stack down. Each is a command, not a shell function: it runs in a process group of its
# own, so that a restart or a stop reaches the server it starts as well.

# Deliberately **not** `--hot`, where the web app below is.
#
# Hot-reloading the orchestrator reloads the module graph an in-flight run is executing in, and
# in practice that kills the run: three real runs were lost to it in one afternoon, each of them
# a harness that had already done the work. The web app has no such state — a reload there costs a
# re-render — so it keeps the fast loop, and this one trades an edit-time restart for runs that
# survive being edited around. Restart the stack after changing anything under `apps/orchestrator`
# or `packages/` for it to take effect.
echo "[dev] orchestrator → ws://localhost:$SOLOW_WS_PORT  (+ /events, /api/inngest)"
supervise orchestrator bun run apps/orchestrator/src/main.ts

# `inngest start` persists queued events AND in-flight runs to --sqlite-dir (what `dev --persist`
# did), so a run mid-round survives a restart. Keys come from the environment, not argv, so they
# stay out of `ps`. (A review gate no longer depends on this: a run ends at the gate, and the
# decision is a row in the app DB that starts the next run.) SOLOW_INNGEST_ARGS appends flags,
# e.g. to move the connect gateway and gRPC ports a second stack on this machine would share.
echo "[dev] inngest      → http://localhost:$SOLOW_INNGEST_PORT  (self-hosted, signed, Decision 0004)"
# shellcheck disable=SC2086 # SOLOW_INNGEST_ARGS is a list of flags
supervise inngest bunx inngest-cli start \
    --sqlite-dir "$GC_DIR/inngest" \
    -u "$SOLOW_INNGEST_SDK_URL" \
    -p "$SOLOW_INNGEST_PORT" --host "$SOLOW_BIND_HOST" ${SOLOW_INNGEST_ARGS:-}

# `bun --bun` forces the Bun runtime so the DAL's bun:sqlite import resolves.
echo "[dev] web          → http://localhost:$SOLOW_WEB_PORT  (listening on $SOLOW_BIND_HOST)"
# shellcheck disable=SC2016 # expanded by that shell, from the arguments after it
supervise web sh -c 'cd apps/web && exec "$@"' web \
    bun --bun run dev --port "$SOLOW_WEB_PORT" --hostname "$SOLOW_BIND_HOST"
echo "[dev] data         → $GC_DIR"

supervise_wait || {
    echo "[dev] a service would not stay up — stopping the rest" >&2
    exit 1
}
