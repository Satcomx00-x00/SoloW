#!/usr/bin/env sh
# Bring up the whole GateControl stack for local development:
#   - web app (Next.js SPA + tRPC API)  → http://localhost:5000
#   - orchestrator (WebSocket hub)       → ws://localhost:5001
# Both share one SQLite database and a persistent encryption key so stored secrets stay
# decryptable across runs. First run migrates + seeds automatically. Ctrl-C stops both.
set -eu

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

GC_DIR="$ROOT/.gatecontrol"
mkdir -p "$GC_DIR"

# Persistent 32-byte base64 key (kept out of git via .gitignore's /.gatecontrol/).
KEY_FILE="$GC_DIR/dev-secret.key"
if [ ! -f "$KEY_FILE" ]; then
    openssl rand -base64 32 > "$KEY_FILE"
    echo "[dev] generated $KEY_FILE"
fi

GATECONTROL_SQLITE_PATH="$GC_DIR/gatecontrol.db"
GATECONTROL_SECRET_KEY="$(cat "$KEY_FILE")"
export GATECONTROL_SQLITE_PATH GATECONTROL_SECRET_KEY
export GATECONTROL_DB_DRIVER="${GATECONTROL_DB_DRIVER:-sqlite}"
# Dev-owner mode skips sign-in and binds to the seeded Workspace with the core flag on.
# Set GATECONTROL_DEV_OWNER=off to exercise the real BetterAuth flow: the first visit to
# /sign-in creates the single Owner account, then enable the feature for their Workspace with
#   bun run flag enable ff-core-program
export GATECONTROL_DEV_OWNER="${GATECONTROL_DEV_OWNER:-on}"
# Signs the session cookie; the env module refuses anything under 32 characters.
export GATECONTROL_AUTH_SECRET="${GATECONTROL_AUTH_SECRET:-dev-insecure-session-secret-32ch}"
# Shared by web (signs stream tickets) and orchestrator (verifies them) — same value, both sides.
export GATECONTROL_STREAM_SECRET="${GATECONTROL_STREAM_SECRET:-dev-insecure-stream}"
# The Claude Code binary the orchestrator spawns per run. GateControl adds the arguments it
# needs itself, including --worktree, so each Task gets its own working tree off the repository.
export GATECONTROL_AGENT_COMMAND="${GATECONTROL_AGENT_COMMAND:-claude}"
export GATECONTROL_AGENT_ARGS="${GATECONTROL_AGENT_ARGS:-}"
export GATECONTROL_WS_PORT="${GATECONTROL_WS_PORT:-5001}"
export GATECONTROL_WS_URL="${GATECONTROL_WS_URL:-ws://localhost:5001}"
export GATECONTROL_WEB_URL="${GATECONTROL_WEB_URL:-http://localhost:5000}"

# Database setup. Migrations run on every start, not just the first: drizzle skips the ones
# already recorded, so this is cheap, and without it an existing dev database silently drifts
# behind main and the API 500s on tables that do not exist yet. Seeding stays first-run only.
if [ ! -f "$GATECONTROL_SQLITE_PATH" ]; then
    echo "[dev] initializing database at $GATECONTROL_SQLITE_PATH"
    bun run db:migrate
    bun run db:seed
else
    bun run db:migrate
fi

# Track child PIDs and stop both services on exit.
PIDS=""
cleanup() {
    trap - INT TERM EXIT
    # shellcheck disable=SC2086
    [ -n "$PIDS" ] && kill $PIDS 2> /dev/null || true
}
trap cleanup INT TERM EXIT

echo "[dev] orchestrator → ws://localhost:$GATECONTROL_WS_PORT"
bun --hot run apps/orchestrator/src/main.ts &
PIDS="$PIDS $!"

echo "[dev] web         → http://localhost:5000  (dev-owner mode)"
# `bun --bun` forces the Bun runtime so the DAL's bun:sqlite import resolves.
(cd apps/web && exec bun --bun run dev) &
PIDS="$PIDS $!"

# Wait for either service to exit, then cleanup runs via the trap.
wait
