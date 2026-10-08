# shellcheck shell=sh
# Sourced by scripts/dev.sh and scripts/start.sh (needs $GC_DIR and $SOLOW_INNGEST_PORT set).
#
# Secrets for the two trust boundaries around the run engine (FINDINGS B3, F6):
#   - SOLOW_ORCHESTRATOR_SECRET: the web app presents it on POST /events; without it anyone who
#     can reach the orchestrator's port can start a run.
#   - INNGEST_SIGNING_KEY / INNGEST_EVENT_KEY: `inngest start` only syncs and drives functions
#     with signed requests, and only accepts events that carry the event key.
# Generated once and kept 0600 under .solow/ (git-ignored), so a restart does not invalidate the
# engine's persisted state. An exported value wins, for a deployment that manages its own.

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
# The SDK treats any INNGEST_DEV as "talk to a Dev Server, skip signature checks", so it must be
# gone; INNGEST_BASE_URL is what points a non-dev SDK at a self-hosted server instead of Cloud.
unset INNGEST_DEV
INNGEST_BASE_URL="http://localhost:$SOLOW_INNGEST_PORT"
export SOLOW_ORCHESTRATOR_SECRET INNGEST_SIGNING_KEY INNGEST_EVENT_KEY INNGEST_BASE_URL
