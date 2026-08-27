#!/usr/bin/env sh
# Bring up the whole SoloW stack against a built web app, not the dev server:
#   - web app (Next.js SPA + tRPC API)          → http://localhost:5000  (`next start`, built once)
#   - orchestrator (WebSocket hub + /events +
#     /api/inngest, Decision 0004)               → http://localhost:5001  (no --hot)
#   - Inngest Dev Server (the durable engine
#     Decision 0004 chose, run locally)          → http://localhost:8288
# Same three services as `bun run dev`, same shared database and encryption key, but without
# Next.js's dev-server compile-per-route and the orchestrator's --hot file-watcher — useful when
# you want the stack up to exercise it (or point another tool at it) without paying dev mode's
# first-request latency and rebuild churn on every change. Ctrl-C stops all three.
#
# This is still a local, single-Owner dev-owner-mode stack — not a production deployment
# (Inngest Dev Server, SQLite, `.solow/` on disk). Source changes need a re-run of this
# script (which rebuilds the web app) to take effect; nothing here watches files.
set -eu

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

GC_DIR="$ROOT/.solow"
mkdir -p "$GC_DIR"

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
# Dev-owner mode skips sign-in and binds to the seeded Workspace with the core flag on.
# Set SOLOW_DEV_OWNER=off to exercise the real BetterAuth flow: the first visit to
# /sign-in creates the single Owner account, then enable the feature for their Workspace with
#   bun run flag enable ff-core-program
export SOLOW_DEV_OWNER="${SOLOW_DEV_OWNER:-on}"
# Signs the session cookie; the env module refuses anything under 32 characters.
export SOLOW_AUTH_SECRET="${SOLOW_AUTH_SECRET:-dev-insecure-session-secret-32ch}"
# Shared by web (signs stream tickets) and orchestrator (verifies them) — same value, both sides.
export SOLOW_STREAM_SECRET="${SOLOW_STREAM_SECRET:-dev-insecure-stream}"
# The Claude Code binary each run's agent_catalog row names (packages/db/src/agent-catalog-
# defaults.ts seeds "claude"; these two are read by nothing in apps/orchestrator/src today, so
# they do not override that — kept only for a deployment that wires its own catalog lookup to
# them). SoloW adds the arguments it needs itself, including --worktree, so each Task gets
# its own working tree off the repository.
export SOLOW_AGENT_COMMAND="${SOLOW_AGENT_COMMAND:-claude}"
export SOLOW_AGENT_ARGS="${SOLOW_AGENT_ARGS:-}"
export SOLOW_WS_PORT="${SOLOW_WS_PORT:-5001}"
export SOLOW_WS_URL="${SOLOW_WS_URL:-ws://localhost:5001}"
export SOLOW_WEB_URL="${SOLOW_WEB_URL:-http://localhost:5000}"
# Where the web app's emit() POSTs task-run/review events (apps/web/src/server/orchestrator-
# client.ts) — the orchestrator's own /events route, which forwards them into a real
# inngest.send() (Decision 0004). Without this, enqueueTaskRun()/resumeReview() silently no-op
# in dev-owner mode instead of ever reaching an agent.
export SOLOW_ORCHESTRATOR_URL="${SOLOW_ORCHESTRATOR_URL:-http://localhost:$SOLOW_WS_PORT}"
export SOLOW_INNGEST_PORT="${SOLOW_INNGEST_PORT:-8288}"
# Inngest's own env var (not SoloW's — see apps/orchestrator/src/inngest/client.ts): a URL
# routes the orchestrator's Inngest client at this local Dev Server instead of Inngest Cloud.
# Pointed at $SOLOW_INNGEST_PORT explicitly rather than left as the bare "1" the SDK also
# accepts — "1" falls back to the SDK's own hardcoded default of :8288, which silently breaks
# registration the moment SOLOW_INNGEST_PORT is overridden to anything else (reproduced
# while verifying this wiring: the orchestrator kept POSTing registration at :8288 while the Dev
# Server listened on the overridden port, and the two never found each other).
export INNGEST_DEV="${INNGEST_DEV:-http://localhost:$SOLOW_INNGEST_PORT}"

# Database setup. Migrations run on every start, not just the first: drizzle skips the ones
# already recorded, so this is cheap, and without it an existing database silently drifts behind
# main and the API 500s on tables that do not exist yet. Seeding stays first-run only.
if [ ! -f "$SOLOW_SQLITE_PATH" ]; then
    echo "[start] initializing database at $SOLOW_SQLITE_PATH"
    bun run db:migrate
    bun run db:seed
else
    bun run db:migrate
fi

# Built once, up front, rather than left to `next dev`'s per-route compile-on-request — that
# first-hit latency (and the orchestrator's --hot file-watcher) is exactly what this script trades
# away. A stale build would silently serve old code, so this always rebuilds rather than reusing
# whatever `.next/` happens to be on disk; skip it yourself with SOLOW_SKIP_BUILD=1 if
# you've just built and only want to restart the servers.
if [ "${SOLOW_SKIP_BUILD:-0}" != "1" ]; then
    echo "[start] building web app..."
    (cd apps/web && exec bun --bun run build)
else
    echo "[start] SOLOW_SKIP_BUILD=1 set, reusing the existing apps/web/.next build"
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

# 5000 is a literal because `apps/web/package.json` owns it (`next start --port 5000`), and a
# variable here would be a second answer to the same question.
for port in "$SOLOW_WS_PORT" "$SOLOW_INNGEST_PORT" 5000; do
    if port_in_use "$port"; then
        echo "[start] port $port is already in use — stop what holds it and try again" >&2
        echo "[start]   ss -ltnp 'sport = :$port'" >&2
        exit 1
    fi
done

# Track child PIDs and stop all three services on exit.
PIDS=""
cleanup() {
    trap - INT TERM EXIT
    # shellcheck disable=SC2086
    [ -n "$PIDS" ] && kill $PIDS 2> /dev/null || true
}
trap cleanup INT TERM EXIT

echo "[start] orchestrator → ws://localhost:$SOLOW_WS_PORT  (+ /events, /api/inngest)"
bun run apps/orchestrator/src/main.ts &
PIDS="$PIDS $!"

echo "[start] inngest      → http://localhost:$SOLOW_INNGEST_PORT  (Dev Server, Decision 0004)"
bunx inngest-cli dev --no-discovery \
    -u "http://localhost:$SOLOW_WS_PORT/api/inngest" \
    -p "$SOLOW_INNGEST_PORT" &
PIDS="$PIDS $!"

echo "[start] web           → http://localhost:5000  (built, dev-owner mode)"
# `bun --bun` forces the Bun runtime so the DAL's bun:sqlite import resolves.
(cd apps/web && exec bun --bun run start) &
PIDS="$PIDS $!"

# Wait for **any** service to exit, then let the trap stop the rest.
#
# A bare `wait` waits for all of them, which is what let a dead service go unnoticed: the two
# survivors kept the script alive and the stack ran degraded with nothing said. `wait -n` would
# express this directly but is not POSIX, and this file is `sh`, so the same thing is done by
# watching the pids.
while :; do
    for pid in $PIDS; do
        if ! kill -0 "$pid" 2> /dev/null; then
            echo "[start] a service exited (pid $pid) — stopping the rest" >&2
            exit 1
        fi
    done
    sleep 1
done
