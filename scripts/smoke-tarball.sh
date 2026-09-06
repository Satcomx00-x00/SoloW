#!/usr/bin/env sh
# Install the packed tarball the way a user does, and run it.
#
# Every gate before this one reads the *source tree*. The tarball is a different artifact, and
# twice now it has been broken in ways nothing here could see:
#
#   - `npm pack` silently drops symlinks, so the traced Next.js build shipped without its
#     dependencies and `npx solow` died on "Cannot find package 'next'".
#   - the Inngest binary shipped as a 1224-byte Node stub rather than the executable, so the
#     stack came up and then failed with "inngest cli binary not found".
#
# Both passed `npm pack --dry-run`, because listing what is in a tarball is not the same question
# as whether what is in it runs. This installs it into an empty directory and boots the whole
# stack, which is the only form of the question that has ever caught either.
#
# `--ignore-scripts` is deliberate and is the stricter test: npm blocks install scripts by
# default now, and the airgapped install SoloW promises has no postinstall to fall back on. If a
# binary only arrives via a lifecycle script, it does not really ship.
set -eu

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"

# High ports, so a developer running this locally does not collide with `make dev` on 5000/5001/8288.
WEB_PORT="${SMOKE_WEB_PORT:-15000}"
WS_PORT="${SMOKE_WS_PORT:-15001}"
INNGEST_PORT="${SMOKE_INNGEST_PORT:-18288}"
BOOT_TIMEOUT="${SMOKE_BOOT_TIMEOUT:-120}"

WORK="$(mktemp -d)"
SOLOW_PID=""

cleanup() {
    status=$?
    if [ -n "$SOLOW_PID" ]; then
        # The CLI's children (web, orchestrator, inngest) are in its process group, and killing
        # only the parent would leave three servers holding ports on a CI runner.
        kill -TERM "-$SOLOW_PID" 2> /dev/null || kill -TERM "$SOLOW_PID" 2> /dev/null || true
        wait "$SOLOW_PID" 2> /dev/null || true
    fi
    if [ "$status" -ne 0 ] && [ -f "$WORK/solow.log" ]; then
        echo
        echo "--- solow output ---"
        cat "$WORK/solow.log"
    fi
    rm -rf "$WORK"
    exit "$status"
}
trap cleanup EXIT INT TERM

echo "==> packing"
cd "$ROOT/packages/cli"
# Packed into the scratch directory rather than the repo: this runs on a developer's checkout as
# well as CI, and a gate that leaves a 100MB tarball lying in the source tree is a gate people
# stop running. `npm pack` prints the filename on stdout; everything else goes to stderr.
TARBALL="$WORK/$(npm pack --silent --pack-destination "$WORK")"
echo "    $TARBALL"

echo "==> installing into a clean directory (no install scripts)"
cd "$WORK"
npm init -y > /dev/null 2>&1
npm install --ignore-scripts --no-audit --no-fund "$TARBALL" > "$WORK/install.log" 2>&1 || {
    cat "$WORK/install.log"
    echo "smoke-tarball: the tarball would not install." >&2
    exit 1
}

BIN="$WORK/node_modules/.bin/solow"
[ -x "$BIN" ] || {
    echo "smoke-tarball: no executable at node_modules/.bin/solow after install." >&2
    exit 1
}

# Cheap first: a bin that cannot even print its version is not worth booting.
echo "==> solow --version"
"$BIN" --version

# Boot the installed CLI and wait for its own "up" line. Called twice below, so the stack is a
# function: once the way a user runs it, once with sign-in switched on. `$@` is the environment
# for the run, the way `env` takes it, so a caller can say what differs and nothing else.
boot_stack() {
    echo "==> booting the stack (web $WEB_PORT, orchestrator $WS_PORT, inngest $INNGEST_PORT)$BOOT_NOTE"
    : > "$WORK/solow.log"
    setsid env "$@" "$BIN" \
        --no-open \
        --port "$WEB_PORT" \
        --ws-port "$WS_PORT" \
        --inngest-port "$INNGEST_PORT" \
        --data-dir "$WORK/data" \
        > "$WORK/solow.log" 2>&1 &
    SOLOW_PID=$!

    waited=0
    while [ "$waited" -lt "$BOOT_TIMEOUT" ]; do
        if ! kill -0 "$SOLOW_PID" 2> /dev/null; then
            echo "smoke-tarball: the stack exited during startup." >&2
            exit 1
        fi
        if grep -q "SoloW is up" "$WORK/solow.log" 2> /dev/null; then
            break
        fi
        sleep 1
        waited=$((waited + 1))
    done
    [ "$waited" -lt "$BOOT_TIMEOUT" ] || {
        echo "smoke-tarball: the stack did not come up within ${BOOT_TIMEOUT}s." >&2
        exit 1
    }
}

# Stop it and wait for the ports to be free again, so the second boot does not race the first
# one's teardown for :15000. The `wait` on a process started in the same shell is what says the
# group is gone; `SOLOW_PID` is cleared so `cleanup` does not kill a pid the kernel may reuse.
stop_stack() {
    kill -TERM "-$SOLOW_PID" 2> /dev/null || kill -TERM "$SOLOW_PID" 2> /dev/null || true
    wait "$SOLOW_PID" 2> /dev/null || true
    SOLOW_PID=""
}

BOOT_NOTE=""
boot_stack

echo "==> web responds"
curl -fsS --max-time 20 "http://localhost:$WEB_PORT/" > /dev/null || {
    echo "smoke-tarball: the web app did not serve a page." >&2
    exit 1
}

# And that the page it serves is the one a new install actually lands on (issue #17: "a smoke test
# that runs the launcher in a clean container and reaches the sign-in page"). Serving *something*
# on `/` is the weaker question, and this stack has answered it while being unusable: a 200 that
# is a Next error boundary, or a redirect chain that never terminates, both pass the check above.
#
# What a new install lands on is *the app*, not a sign-in form: the launcher runs as a
# single-user local install (`SOLOW_DEV_OWNER=on` in `bin/solow.mjs`), which binds the person at
# the machine to the local Workspace instead of asking them to invent an account. So the first
# check asserts the shell — its breadcrumb is server-rendered and appears on no other page — and
# the sign-in form is exercised separately, below, with that switch off. The assertion on the
# markup rather than the status code is what "a person can start using it" means.
echo "==> the local owner lands on the app"
LANDING="$(curl -fsSL --max-time 20 "http://localhost:$WEB_PORT/" || true)"
case "$LANDING" in
    *'aria-label="Breadcrumb"'*) ;;
    *)
        echo "smoke-tarball: / did not render the app shell for the local owner — a new install" >&2
        echo "  lands on nothing usable, whatever the status code on / said." >&2
        exit 1
        ;;
esac

echo "==> orchestrator responds"
# `/api/inngest` is the introspection route the Dev Server itself polls, so a 200 here means the
# orchestrator is not merely listening but has its functions registered.
curl -fsS --max-time 20 "http://localhost:$WS_PORT/api/inngest" > /dev/null || {
    echo "smoke-tarball: the orchestrator did not answer on /api/inngest." >&2
    exit 1
}

echo "==> inngest responds"
curl -fsS --max-time 20 "http://localhost:$INNGEST_PORT/" > /dev/null || {
    echo "smoke-tarball: the Inngest Dev Server is not serving — is the binary a real executable?" >&2
    exit 1
}

# The other way in. A deployment that is not one person at one machine turns the local-owner
# stand-in off, and then a fresh data directory has no Owner yet: `/sign-in` is the one-time
# setup form — the path the deployment view says exists instead of printed credentials. Same
# tarball, same data directory, one switch, so what is asserted is the packaged auth path and
# nothing else.
#
# `id="auth-password"` rather than a `name=` attribute: the field is a controlled React input with
# no `name`, so that is the stable handle in the markup. It is server-rendered even though the
# form is a client component, which is what makes it visible to curl at all.
stop_stack
BOOT_NOTE=" — sign-in on"
boot_stack SOLOW_DEV_OWNER=off

echo "==> the sign-in page renders its form"
SIGNIN="$(curl -fsSL --max-time 20 "http://localhost:$WEB_PORT/sign-in" || true)"
case "$SIGNIN" in
    *'id="auth-password"'*) ;;
    *)
        echo "smoke-tarball: /sign-in did not render its password field — an install with sign-in" >&2
        echo "  on cannot be signed into, whatever the status code on / said." >&2
        exit 1
        ;;
esac

echo
echo "smoke-tarball OK — the published artifact installs and runs."
