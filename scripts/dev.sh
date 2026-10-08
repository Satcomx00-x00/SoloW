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

GC_DIR="$ROOT/.solow"
mkdir -p "$GC_DIR"

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
export SOLOW_WS_PORT="${SOLOW_WS_PORT:-5001}"
export SOLOW_WS_URL="${SOLOW_WS_URL:-ws://localhost:5001}"
export SOLOW_WEB_URL="${SOLOW_WEB_URL:-http://localhost:5000}"
export SOLOW_INNGEST_PORT="${SOLOW_INNGEST_PORT:-8288}"
# The session and stream-ticket secrets, the signing + event keys for `inngest start`, the
# web->orchestrator secret (B3, F6), and the loopback URLs the services reach each other on.
# shellcheck source=/dev/null
. "$ROOT/scripts/lib/engine-env.sh"

# Database setup. Migrations run on every start, not just the first: drizzle skips the ones
# already recorded, so this is cheap, and without it an existing dev database silently drifts
# behind main and the API 500s on tables that do not exist yet.
if [ ! -f "$SOLOW_SQLITE_PATH" ]; then
    echo "[dev] initializing database at $SOLOW_SQLITE_PATH"
    bun run db:migrate
else
    bun run db:migrate
fi
# Every start, not only the first: this creates the Workspace and its harness catalog and nothing
# else, so it is a no-op once they exist — and a database from a build that predates the catalog
# gets one instead of a Settings page with an empty harness picker.
bun run db:bootstrap

# Track child PIDs and stop all three services on exit.
PIDS=""
cleanup() {
    trap - INT TERM EXIT
    # shellcheck disable=SC2086
    [ -n "$PIDS" ] && kill $PIDS 2> /dev/null || true
}
trap cleanup INT TERM EXIT

echo "[dev] orchestrator → ws://localhost:$SOLOW_WS_PORT  (+ /events, /api/inngest)"
# Deliberately **not** `--hot`, where the web app below is.
#
# Hot-reloading the orchestrator reloads the module graph an in-flight run is executing in, and
# in practice that kills the run: three real runs were lost to it in one afternoon, each of them
# a harness that had already done the work. The web app has no such state — a reload there costs a
# re-render — so it keeps the fast loop, and this one trades an edit-time restart for runs that
# survive being edited around. Restart the stack after changing anything under `apps/orchestrator`
# or `packages/` for it to take effect.
bun run apps/orchestrator/src/main.ts &
PIDS="$PIDS $!"

echo "[dev] inngest      → http://localhost:$SOLOW_INNGEST_PORT  (self-hosted, signed, Decision 0004)"
# `inngest start` persists queued events AND in-flight runs to --sqlite-dir (what `dev --persist`
# did), so a run mid-round survives a restart. Keys come from the environment, not argv, so they
# stay out of `ps`. (A review gate no longer depends on this: a run ends at the gate, and the
# decision is a row in the app DB that starts the next run.)
bunx inngest-cli start \
    --sqlite-dir "$GC_DIR/inngest" \
    -u "$SOLOW_INNGEST_SDK_URL" \
    -p "$SOLOW_INNGEST_PORT" --host "$SOLOW_BIND_HOST" &
PIDS="$PIDS $!"

echo "[dev] web          → http://localhost:5000  (listening on $SOLOW_BIND_HOST)"
# `bun --bun` forces the Bun runtime so the DAL's bun:sqlite import resolves.
(cd apps/web && exec bun --bun run dev --hostname "$SOLOW_BIND_HOST") &
PIDS="$PIDS $!"

# Wait for any service to exit, then cleanup runs via the trap.
wait
