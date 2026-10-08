#!/usr/bin/env sh
# Bring up the whole SoloW stack against a built web app, not the dev server:
#   - web app (Next.js SPA + tRPC API)          → http://localhost:5000  (`next start`, built once)
#   - orchestrator (WebSocket hub + /events +
#     /api/inngest, Decision 0004)               → http://localhost:5001  (no --hot)
#   - Inngest server (inngest start) (the durable engine
#     Decision 0004 chose, run locally)          → http://localhost:8288
# Same three services as `bun run dev`, same shared database and encryption key, but without
# Next.js's dev-server compile-per-route and the orchestrator's --hot file-watcher — useful when
# you want the stack up to exercise it (or point another tool at it) without paying dev mode's
# first-request latency and rebuild churn on every change. Ctrl-C stops all three.
#
# This is still a local, single-Owner stack — not a production deployment
# (Inngest server (inngest start), SQLite, `.solow/` on disk). Source changes need a re-run of this
# script (which rebuilds the web app) to take effect; nothing here watches files.
set -eu

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

# shellcheck disable=SC2034 # read by scripts/lib/data-dir.sh
LOG_TAG=start
# The data folder ($SOLOW_HOME, default .solow/), the absolute roots under it, the pid file.
# shellcheck source=/dev/null
. "$ROOT/scripts/lib/data-dir.sh"
# shellcheck source=/dev/null
. "$ROOT/scripts/lib/supervise.sh"

# Persistent 32-byte base64 key (kept out of git via .gitignore's /.solow/).
KEY_FILE="$GC_DIR/dev-secret.key"
if [ ! -f "$KEY_FILE" ]; then
    openssl rand -base64 32 > "$KEY_FILE"
    echo "[start] generated $KEY_FILE"
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
    *) echo "[start] WARNING: SOLOW_BIND_HOST=$SOLOW_BIND_HOST exposes SoloW to the network; anyone who can reach it can attempt to sign in." >&2 ;;
esac
if [ "$SOLOW_DEV_OWNER" = "on" ]; then
    echo "[start] WARNING: SOLOW_DEV_OWNER=on — there is no sign-in and every visitor is the Owner." >&2
    case "$SOLOW_BIND_HOST" in
        127.* | localhost | ::1) ;;
        *)
            echo "[start] refusing to start: dev-owner mode on a non-loopback SOLOW_BIND_HOST would hand the machine to the network." >&2
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
# A clean stop for a service manager, which sends TERM and reads anything else as a failure.
trap 'exit 0' TERM
claim_data_dir

# Database setup. Migrations run on every start, not just the first: drizzle skips the ones
# already recorded, so this is cheap, and without it an existing database silently drifts behind
# main and the API 500s on tables that do not exist yet. When one is pending, the migration first
# takes a consistent copy of the database and its keys into $SOLOW_HOME/backups (FINDINGS F1).
if [ ! -f "$SOLOW_SQLITE_PATH" ]; then
    echo "[start] initializing database at $SOLOW_SQLITE_PATH"
fi
bun run db:migrate
# Every start, not only the first: this creates the Workspace and its harness catalog and nothing
# else, so it is a no-op once they exist.
bun run db:bootstrap

# Built once, up front, rather than left to `next dev`'s per-route compile-on-request — that
# first-hit latency (and the orchestrator's --hot file-watcher) is exactly what this script trades
# away.
#
# Through Turborepo, so that it is only *actually* built when something the bundle is built from
# has changed. This used to run `next build` on every start, on the argument that a stale build
# silently serves old code — true, but the cure cost 50–85 s per restart, including the restarts
# that touch only the orchestrator, which is not in the bundle at all. `turbo run build` hashes
# the web package's files, its workspace dependencies, the lockfile and the env `turbo.json`
# names, and on a hit restores `.next/` from `.turbo/cache` in a few seconds instead. Force a
# rebuild with SOLOW_FORCE_BUILD=1; skip the step entirely with SOLOW_SKIP_BUILD=1.
if [ "${SOLOW_SKIP_BUILD:-0}" = "1" ]; then
    echo "[start] SOLOW_SKIP_BUILD=1 set, reusing the existing apps/web/.next build"
else
    echo "[start] building web app (cached: turbo)..."
    if [ "${SOLOW_FORCE_BUILD:-0}" = "1" ]; then
        bunx turbo run build --filter=@solow/web --force
    else
        bunx turbo run build --filter=@solow/web
    fi
fi

# Refuse to start on a port something else already holds.
#
# Learned the hard way: a second `start.sh` over a running one left the previous orchestrator
# holding :5001, the new one printed "Failed to start server. Is port 5001 in use?" into the
# same log as everything else, and the script carried on — so the stack came up serving the
# *old* binary while claiming to be fresh. Twenty minutes of a debugging session went into
# testing code that was not running.
#
# `ss` is what a Linux dev box has; if it is missing the check is skipped rather than made a
# reason the script cannot run at all.
port_in_use() {
    command -v ss > /dev/null 2>&1 || return 1
    ss -ltn "sport = :$1" 2> /dev/null | grep -q LISTEN
}

for port in "$SOLOW_WS_PORT" "$SOLOW_INNGEST_PORT" "$SOLOW_WEB_PORT"; do
    if port_in_use "$port"; then
        echo "[start] port $port is already in use — stop what holds it and try again" >&2
        echo "[start]   ss -ltnp 'sport = :$port'" >&2
        exit 1
    fi
done

# Each service under its own supervisor (scripts/lib/supervise.sh): one that crashes is started
# again after a short backoff while the other two keep running, and the engine redrives the run
# it was in the middle of (docs/operations/running-as-a-service.md). Only a service that keeps
# crashing takes the stack down, so that a service manager above this script sees it. Each is a
# command, not a shell function: it runs in a process group of its own, so that a restart or a stop
# reaches the server it starts as well.
echo "[start] orchestrator → ws://localhost:$SOLOW_WS_PORT  (+ /events, /api/inngest)"
supervise orchestrator bun run apps/orchestrator/src/main.ts

# `inngest start` persists to --sqlite-dir (what `dev --persist` did), shared with dev.sh. The
# signing/event keys come from the environment, not argv, so they stay out of `ps`.
# SOLOW_INNGEST_ARGS appends flags — e.g. `--connect-gateway-port` and the two gRPC ports, which
# bind fixed ports on every interface and so collide when a second stack runs on this machine.
echo "[start] inngest      → http://localhost:$SOLOW_INNGEST_PORT  (self-hosted, signed, Decision 0004)"
# shellcheck disable=SC2086 # SOLOW_INNGEST_ARGS is a list of flags
supervise inngest bunx inngest-cli start \
    --sqlite-dir "$GC_DIR/inngest" \
    -u "$SOLOW_INNGEST_SDK_URL" \
    -p "$SOLOW_INNGEST_PORT" --host "$SOLOW_BIND_HOST" ${SOLOW_INNGEST_ARGS:-}

# `bun --bun` forces the Bun runtime so the DAL's bun:sqlite import resolves.
echo "[start] web           → http://localhost:$SOLOW_WEB_PORT  (built, listening on $SOLOW_BIND_HOST)"
# shellcheck disable=SC2016 # expanded by that shell, from the arguments after it
supervise web sh -c 'cd apps/web && exec "$@"' web \
    bun --bun run start --port "$SOLOW_WEB_PORT" --hostname "$SOLOW_BIND_HOST"
echo "[start] data         → $GC_DIR"

# Until a supervisor gives up. A bare `wait` would wait for all three, which is what once let a
# dead service go unnoticed while the two survivors kept the script alive.
supervise_wait || {
    echo "[start] a service would not stay up — stopping the rest" >&2
    exit 1
}
