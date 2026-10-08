# shellcheck shell=sh
# Sourced by scripts/dev.sh and scripts/start.sh (needs $GC_DIR, $SOLOW_BIND_HOST, $SOLOW_WS_PORT
# and $SOLOW_INNGEST_PORT set).
#
# Secrets for the trust boundaries around the stack (FINDINGS B3, F6):
#   - SOLOW_ORCHESTRATOR_SECRET: the web app presents it on POST /events; without it anyone who
#     can reach the orchestrator's port can start a run.
#   - INNGEST_SIGNING_KEY / INNGEST_EVENT_KEY: `inngest start` only syncs and drives functions
#     with signed requests, and only accepts events that carry the event key.
#   - SOLOW_STREAM_SECRET: signs the stream tickets that authorise the orchestrator's /terminal
#     (a shell on this host), /probe-agent and /explain. A constant here would let anyone who read
#     this file mint one.
#   - SOLOW_AUTH_SECRET: signs the session cookie. Moving it off the old constant signs everyone
#     out once; that is the cost of no longer sharing a session key with every other checkout.
# Generated once and kept 0600 under the data folder (git-ignored), so a restart does not
# invalidate the engine's persisted state or anyone's session. An exported value wins, for a
# deployment that manages its own. The file names are the ones `npx solow` uses.

engine_secret() {
    # $1 file name, $2 openssl rand format flag
    _file="$GC_DIR/$1"
    if [ ! -s "$_file" ]; then
        (umask 077 && openssl rand "$2" 32 > "$_file")
        echo "[engine] generated $_file" >&2
    fi
    cat "$_file"
}

SOLOW_ORCHESTRATOR_SECRET="${SOLOW_ORCHESTRATOR_SECRET:-$(engine_secret orchestrator.secret -base64)}"
INNGEST_SIGNING_KEY="${INNGEST_SIGNING_KEY:-$(engine_secret inngest-signing.key -hex)}"
INNGEST_EVENT_KEY="${INNGEST_EVENT_KEY:-$(engine_secret inngest-event.key -hex)}"
SOLOW_STREAM_SECRET="${SOLOW_STREAM_SECRET:-$(engine_secret stream.secret -base64)}"
SOLOW_AUTH_SECRET="${SOLOW_AUTH_SECRET:-$(engine_secret auth.secret -base64)}"
export SOLOW_ORCHESTRATOR_SECRET INNGEST_SIGNING_KEY INNGEST_EVENT_KEY SOLOW_STREAM_SECRET \
    SOLOW_AUTH_SECRET

# Where the services reach each other. Not `localhost`: it can resolve to ::1 first while the
# services listen on 127.0.0.1, and a specific SOLOW_BIND_HOST (a LAN address) is not listening on
# loopback at all. A wildcard bind is reachable on loopback, so that is used for it.
case "$SOLOW_BIND_HOST" in
    0.0.0.0 | :: | localhost | '') SOLOW_INTERNAL_HOST=127.0.0.1 ;;
    *:*) SOLOW_INTERNAL_HOST="[$SOLOW_BIND_HOST]" ;;
    *) SOLOW_INTERNAL_HOST="$SOLOW_BIND_HOST" ;;
esac

# The SDK treats any INNGEST_DEV as "talk to a Dev Server, skip signature checks", so it must be
# gone; INNGEST_BASE_URL is what points a non-dev SDK at a self-hosted server instead of Cloud.
unset INNGEST_DEV
INNGEST_BASE_URL="http://$SOLOW_INTERNAL_HOST:$SOLOW_INNGEST_PORT"
# Where the web app's emit() POSTs task-run/review events (apps/web/src/server/orchestrator-
# client.ts) — the orchestrator's own /events route, which forwards them into a real
# inngest.send() (Decision 0004).
SOLOW_ORCHESTRATOR_URL="${SOLOW_ORCHESTRATOR_URL:-http://$SOLOW_INTERNAL_HOST:$SOLOW_WS_PORT}"
# What the engine calls to sync and drive the functions.
# shellcheck disable=SC2034 # read by the launcher that sources this file
SOLOW_INNGEST_SDK_URL="http://$SOLOW_INTERNAL_HOST:$SOLOW_WS_PORT/api/inngest"
export INNGEST_BASE_URL SOLOW_ORCHESTRATOR_URL
