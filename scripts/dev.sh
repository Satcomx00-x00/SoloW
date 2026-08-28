#!/usr/bin/env sh
# Bring up the whole SoloW stack for local development:
#   - web app (Next.js SPA + tRPC API)          → http://localhost:5000
#   - orchestrator (WebSocket hub + /events +
#     /api/inngest, Decision 0004)               → http://localhost:5001
#   - Inngest Dev Server (the durable engine
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
# already recorded, so this is cheap, and without it an existing dev database silently drifts
# behind main and the API 500s on tables that do not exist yet.
if [ ! -f "$SOLOW_SQLITE_PATH" ]; then
    echo "[dev] initializing database at $SOLOW_SQLITE_PATH"
    bun run db:migrate
else
    bun run db:migrate
fi
# Every start, not only the first: this creates the Workspace and its agent catalog and nothing
# else, so it is a no-op once they exist — and a database from a build that predates the catalog
# gets one instead of a Settings page with an empty agent picker.
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
# an agent that had already done the work. The web app has no such state — a reload there costs a
# re-render — so it keeps the fast loop, and this one trades an edit-time restart for runs that
# survive being edited around. Restart the stack after changing anything under `apps/orchestrator`
# or `packages/` for it to take effect.
bun run apps/orchestrator/src/main.ts &
PIDS="$PIDS $!"

echo "[dev] inngest      → http://localhost:$SOLOW_INNGEST_PORT  (Dev Server, Decision 0004)"
# `--persist` keeps the durable engine's state (queued events AND in-flight runs)
# across restarts. Without it the Dev Server holds everything in memory, so any run
# parked at the review gate (`task-run`'s `waitForEvent("review.decided")`) is lost
# the moment the server restarts, and every manual restart of the orchestrator above
# is one such moment. A lost parked run leaves its Task
# stranded in `review`: `review.decide` then publishes `review.decided` to a wait
# that no longer exists, the decision is recorded but never applied, and Approve /
# Request changes appear dead. The app DB and the secret key are already persisted
# a few lines up for the same reason — the engine's state was the missing third.
bunx inngest-cli dev --no-discovery --persist \
    -u "http://localhost:$SOLOW_WS_PORT/api/inngest" \
    -p "$SOLOW_INNGEST_PORT" &
PIDS="$PIDS $!"

echo "[dev] web          → http://localhost:5000  (dev-owner mode)"
# `bun --bun` forces the Bun runtime so the DAL's bun:sqlite import resolves.
(cd apps/web && exec bun --bun run dev) &
PIDS="$PIDS $!"

# Wait for any service to exit, then cleanup runs via the trap.
wait
