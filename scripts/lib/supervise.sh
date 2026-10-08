# shellcheck shell=sh
# Sourced by scripts/dev.sh and scripts/start.sh. Keeps each service up on its own (FINDINGS F2).
#
#   supervise <name> <command> [args...]   start <command> under a supervisor, in the background;
#                                          the supervisor's pid is appended to $SUPERVISORS
#   supervise_wait                         block until a supervisor gives up, then return 1
#   supervise_stop                         stop every supervisor and the service it runs
#
# A service that exits is started again after a backoff that doubles from 1s up to 30s, so one
# crash costs a second and a crash loop does not spin. The count resets once a run has lasted
# SOLOW_RESTART_STABLE_SECS, so a service that falls over once a day is restarted forever; one that
# fails SOLOW_RESTART_LIMIT times in a row is broken rather than unlucky, and its supervisor gives
# up. That is the one case that still takes the stack down, so that an outer supervisor (systemd,
# docs/operations/running-as-a-service.md) sees the failure instead of a stack that is half up.
#
# The other services are left alone while one restarts. Each of the three already survives the
# others going away: the web app's calls to the orchestrator fail and are retried by the person,
# the engine retries its calls into the orchestrator, and the orchestrator re-reads its state from
# the database on boot.

SUPERVISORS=""
SOLOW_RESTART_LIMIT="${SOLOW_RESTART_LIMIT:-5}"
SOLOW_RESTART_STABLE_SECS="${SOLOW_RESTART_STABLE_SECS:-60}"
SOLOW_RESTART_MAX_DELAY="${SOLOW_RESTART_MAX_DELAY:-30}"

supervise() {
    _sv_name="$1"
    shift
    (
        # A service's non-zero exit is this loop's input, not an error to stop on.
        set +e
        child=""
        stopping=0
        # TERM from supervise_stop. Forwarded to the service; the loop below then waits for it and
        # exits instead of restarting. `wait` returns early when a trapped signal arrives, which is
        # why every wait here is in a loop that checks whether the child is really gone.
        # A service that ignores TERM gets KILL ten seconds later, so a stop is bounded. The timer
        # is its own process with no output: a subshell here would keep the launcher's stdout open
        # for those ten seconds, and whatever reads it would wait for nothing.
        trap 'stopping=1; [ -n "$child" ] && kill -TERM "$child" 2> /dev/null && sh -c "sleep 10; kill -KILL $child" > /dev/null 2>&1 < /dev/null &' TERM
        trap '' INT
        failures=0
        while :; do
            started="$(date +%s)"
            "$@" &
            child=$!
            # A stop that landed between the fork and `child=$!` would have signalled nobody.
            [ "$stopping" = 1 ] && kill -TERM "$child" 2> /dev/null
            while :; do
                wait "$child"
                code=$?
                kill -0 "$child" 2> /dev/null || break
            done
            child=""
            [ "$stopping" = 1 ] && exit 0

            if [ $(($(date +%s) - started)) -ge "$SOLOW_RESTART_STABLE_SECS" ]; then
                failures=0
            fi
            failures=$((failures + 1))
            if [ "$failures" -gt "$SOLOW_RESTART_LIMIT" ]; then
                echo "[supervise] $_sv_name exited (status $code) $SOLOW_RESTART_LIMIT times in a row — giving up" >&2
                exit 1
            fi
            delay=1
            _sv_n=1
            while [ "$_sv_n" -lt "$failures" ] && [ "$delay" -lt "$SOLOW_RESTART_MAX_DELAY" ]; do
                delay=$((delay * 2))
                _sv_n=$((_sv_n + 1))
            done
            [ "$delay" -gt "$SOLOW_RESTART_MAX_DELAY" ] && delay="$SOLOW_RESTART_MAX_DELAY"
            echo "[supervise] $_sv_name exited (status $code) — restarting in ${delay}s (attempt $failures of $SOLOW_RESTART_LIMIT)" >&2
            # In the background so a stop does not wait out the backoff.
            sleep "$delay" &
            child=$!
            wait "$child" || :
            kill -TERM "$child" 2> /dev/null || :
            child=""
            [ "$stopping" = 1 ] && exit 0
        done
    ) &
    SUPERVISORS="$SUPERVISORS $!"
}

supervise_wait() {
    # `wait -n` is not POSIX, so the supervisors are polled; one second is far below any restart
    # delay and costs nothing.
    while :; do
        for _sv_pid in $SUPERVISORS; do
            if ! kill -0 "$_sv_pid" 2> /dev/null; then
                return 1
            fi
        done
        # In the background, so the launcher's own TERM/INT trap runs at once rather than after it.
        sleep 1 &
        wait $! || :
    done
}

supervise_stop() {
    for _sv_pid in $SUPERVISORS; do
        kill -TERM "$_sv_pid" 2> /dev/null || :
    done
    # Bounded by the supervisors' own KILL fallback. Waiting matters: a launcher run straight after
    # this one would otherwise find the ports still held.
    for _sv_pid in $SUPERVISORS; do
        wait "$_sv_pid" 2> /dev/null || :
    done
}
