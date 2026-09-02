#!/usr/bin/env sh
# A local Chrome with the DevTools protocol open, for the chrome-devtools MCP server.
#
# The MCP server drives a browser it does not own, over CDP. `.mcp.json` ships pointing at a
# Chrome on the LAN, which is right when you are looking at the app from your own desktop — and
# wrong on this machine, where that browser's "localhost" is the desktop and not the box the
# stack is running on. This starts one *here*, so http://localhost:5000 means the app.
#
# No new dependency: Playwright is already a devDependency and has downloaded a Chrome for
# Testing build. The path is asked of Playwright rather than written down, because a hardcoded
# `chromium-1234` becomes wrong the next time that package is updated.
#
#   sh scripts/chrome-debug.sh          # start it (idempotent — a running one is reused)
#   sh scripts/chrome-debug.sh --stop   # stop it
set -eu

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

PORT="${SOLOW_CDP_PORT:-9222}"
# Under .solow/ so it is gitignored and survives restarts — a profile in /tmp means a fresh
# browser on every reboot, which loses nothing important but re-does first-run setup each time.
PROFILE="$ROOT/.solow/chrome-debug-profile"

endpoint="http://127.0.0.1:$PORT"

if [ "${1:-}" = "--stop" ]; then
    # Matched on the profile directory rather than on "chrome": this must never take down a
    # browser somebody else on this machine is using.
    pkill -f -- "--user-data-dir=$PROFILE" 2> /dev/null || true
    echo "[chrome] stopped anything using $PROFILE"
    exit 0
fi

# Already up is success, not a conflict. Re-running this to make sure it is running is the
# common case, and a second Chrome on the same port would just fail to bind and log it somewhere
# nobody reads.
if curl -fsS -m 2 "$endpoint/json/version" > /dev/null 2>&1; then
    echo "[chrome] already listening on $endpoint"
    exit 0
fi

BIN="$(bun -e 'import {chromium} from "@playwright/test"; console.log(chromium.executablePath());' 2> /dev/null | tail -1)"
if [ -z "$BIN" ] || [ ! -x "$BIN" ]; then
    echo "[chrome] Playwright has no Chromium downloaded yet — fetching it" >&2
    bunx playwright install chromium
    BIN="$(bun -e 'import {chromium} from "@playwright/test"; console.log(chromium.executablePath());' 2> /dev/null | tail -1)"
fi
[ -x "$BIN" ] || {
    echo "[chrome] could not resolve a Chromium binary" >&2
    exit 1
}

mkdir -p "$PROFILE"
LOG="$ROOT/.solow/chrome-debug.log"

# `setsid` so it outlives this shell: the MCP server connects to it across sessions, and a
# browser that died with the terminal that started it would be a tool that works once.
#
# Bound to 127.0.0.1 explicitly. An open CDP port is remote code execution on this account —
# it can read any page, any cookie, and any file the browser can open — so it must not be
# reachable from the LAN even on a trusted one.
setsid nohup "$BIN" \
    --headless=new \
    --remote-debugging-port="$PORT" \
    --remote-debugging-address=127.0.0.1 \
    --user-data-dir="$PROFILE" \
    --no-first-run \
    --no-default-browser-check \
    --disable-gpu \
    about:blank > "$LOG" 2>&1 < /dev/null &

# Wait for the port rather than sleeping a guess: a caller that returns before CDP answers hands
# the MCP server a connection refusal.
i=0
while [ "$i" -lt 40 ]; do
    if curl -fsS -m 2 "$endpoint/json/version" > /dev/null 2>&1; then
        echo "[chrome] $("$BIN" --version) on $endpoint"
        echo "[chrome] profile: $PROFILE   log: $LOG"
        exit 0
    fi
    i=$((i + 1))
    sleep 0.25
done

echo "[chrome] did not come up on $endpoint — see $LOG" >&2
exit 1
