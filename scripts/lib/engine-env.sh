# shellcheck shell=sh
# Sourced by scripts/dev.sh and scripts/start.sh after scripts/lib/supervise.sh (needs $GC_DIR,
# $SOLOW_BIND_HOST, $SOLOW_WS_PORT and $SOLOW_INNGEST_PORT set).
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
SOLOW_INNGEST_SDK_URL="http://$SOLOW_INTERNAL_HOST:$SOLOW_WS_PORT/api/inngest"
export INNGEST_BASE_URL SOLOW_ORCHESTRATOR_URL

# Starts `inngest start` under its supervisor; the one launch line dev.sh and start.sh share.
#
# `inngest start` persists queued events and in-flight runs to --sqlite-dir, so a run mid-round
# survives a restart. The signing and event keys come from the environment, not argv, so they stay
# out of `ps`. SOLOW_INNGEST_ARGS appends flags, e.g. to move the connect gateway and gRPC ports,
# which bind fixed ports on every interface and so collide when a second stack runs here.
#
# The two variables are for the engine alone. inngest-cli reports its own usage
# (`cli/command.executed`, then `cli/dev_ui.loaded` in bursts every minute, with a stored device
# id) through an embedded SDK client that follows INNGEST_EVENT_API_BASE_URL, else
# INNGEST_BASE_URL, else Inngest Cloud — and it has no switch to turn that off (1.46). With the
# INNGEST_BASE_URL exported above it posted them to itself with Inngest's key, which the engine
# rejected: the "rejecting event; event key not recognized" lines. Port 0 cannot be connected to,
# so they now fail on the spot, with no traffic and no log line. The orchestrator must not get it:
# its SDK reads the same variable for the events SoloW does send. The update notifier is off for
# the same reason, and because the version is the one package.json pins, not the user's to bump.
supervise_engine() {
    # shellcheck disable=SC2086 # SOLOW_INNGEST_ARGS is a list of flags
    supervise inngest env INNGEST_EVENT_API_BASE_URL=http://127.0.0.1:0 \
        INNGEST_NO_UPDATE_NOTIFIER=1 \
        bunx inngest-cli start \
        --sqlite-dir "$GC_DIR/inngest" \
        -u "$SOLOW_INNGEST_SDK_URL" \
        -p "$SOLOW_INNGEST_PORT" --host "$SOLOW_BIND_HOST" ${SOLOW_INNGEST_ARGS:-}
}
