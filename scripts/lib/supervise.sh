# shellcheck shell=sh
# Sourced by scripts/dev.sh and scripts/start.sh. Keeps each service up on its own (FINDINGS F2).
#
#   supervise <name> <command> [args...]   start <command> under a supervisor, in the background;
#                                          the supervisor's pid is appended to $SUPERVISORS.
#                                          <command> must be a program, not a shell function
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
#
# A service is a process group, not a process. None of the three listens in the process started
# here: `bun run dev` starts `next dev`, which starts the server, and `bunx inngest-cli` starts the
# engine binary. Signalling only the process the supervisor started left the listener running as an
# orphan when that process died, and every restart after it failed on EADDRINUSE. So each service
# runs under setsid(1), in a group of its own, and every signal goes to the whole group; once its
# first process has exited, whatever is left of the group is stopped before the next start. Where
# there is no setsid(1) (macOS) the service shares the launcher's group and only its first process
# is signalled, which is the old behaviour.
#
# Every helper here closes fd 9 (`9>&-`): it carries the data folder's lock (scripts/lib/data-dir.sh),
# and a sleep that outlived a stop would keep the folder locked after the stack is down.

SUPERVISORS=""
SOLOW_RESTART_LIMIT="${SOLOW_RESTART_LIMIT:-5}"
SOLOW_RESTART_STABLE_SECS="${SOLOW_RESTART_STABLE_SECS:-60}"
SOLOW_RESTART_MAX_DELAY="${SOLOW_RESTART_MAX_DELAY:-30}"
# How long a service has to stop after TERM before it gets KILL, so that a stop is bounded.
SOLOW_STOP_GRACE="${SOLOW_STOP_GRACE:-10}"
if command -v setsid > /dev/null 2>&1; then
    _SV_SETSID=setsid
else
    _SV_SETSID=""
fi

supervise() {
    _sv_name="$1"
    shift
    (
        # A service's non-zero exit is this loop's input, not an error to stop on.
        set +e
        # The process being waited for, while it has not been reaped: a service's first process,
        # or the backoff's sleep. A pid that has not been reaped cannot be handed to anyone else,
        # which is what makes signalling it safe.
        child=""
        # The service's process group, for as long as anything in it may be running. Its id is
        # not reused while any member is alive.
        group=""
        # 1 from the service's start until the last of its group is gone: what the KILL timer is for.
        serving=0
        timer=""
        stopping=0

        # $1: the signal. A group that does not exist yet means the child has not reached setsid;
        # the child itself is still there to be signalled.
        signal_service() {
            if [ -n "$group" ] && kill "-$1" "-$group" 2> /dev/null; then
                return 0
            fi
            [ -n "$child" ] && kill "-$1" "$child" 2> /dev/null
        }

        # TERM from supervise_stop. Forwarded to the service; the loop below then waits for it and
        # exits instead of restarting. `wait` returns early when a trapped signal arrives, which is
        # why every wait here is in a loop that checks whether the child is really gone.
        #
        # A service that ignores TERM gets KILL after the grace period. The timer does not send it:
        # a timer that signalled a pid on its own would fire whether or not that service had long
        # since exited and its pid been reused. It sends USR1 to this supervisor instead, which
        # knows whether the service is still unreaped, and the timer is stopped as soon as the
        # service is gone. Its output goes nowhere: a helper holding the launcher's stdout would
        # make whatever reads it wait for nothing. The backoff's sleep needs no timer.
        stop_service() {
            stopping=1
            [ -n "$child" ] || [ -n "$group" ] || return 0
            signal_service TERM
            if [ "$serving" = 1 ] && [ -z "$timer" ]; then
                # In a group of its own, so that cancel_timer can take its sleep down with it.
                # shellcheck disable=SC2016 # expanded by the timer's own shell
                $_SV_SETSID sh -c 'sleep "$1" && kill -USR1 "$PPID"' sh "$SOLOW_STOP_GRACE" \
                    > /dev/null 2>&1 < /dev/null 9>&- &
                timer=$!
            fi
        }
        # KILL rather than TERM: a TERM that lands before the timer's shell has started is caught
        # by the trap it inherited from this one and lost, and the stop then waits out the grace.
        cancel_timer() {
            [ -n "$timer" ] || return 0
            kill -KILL "-$timer" 2> /dev/null || kill -KILL "$timer" 2> /dev/null
            wait "$timer" 2> /dev/null
            timer=""
        }
        trap stop_service TERM
        trap 'signal_service KILL' USR1
        trap '' INT

        # What is left of the group after its first process has gone: TERM, then KILL after the
        # grace period. Polled once a second, since a group cannot be waited for.
        drain_group() {
            kill -TERM "-$group" 2> /dev/null || return 0
            _sv_waited=0
            while kill -0 "-$group" 2> /dev/null; do
                if [ "$_sv_waited" -ge "$SOLOW_STOP_GRACE" ]; then
                    kill -KILL "-$group" 2> /dev/null
                    return 0
                fi
                sleep 1 9>&- &
                wait $! || :
                _sv_waited=$((_sv_waited + 1))
            done
        }

        failures=0
        while :; do
            started="$(date +%s)"
            serving=1
            if [ -n "$_SV_SETSID" ]; then
                # This subshell's children share the launcher's group and so are never a group's
                # leader, which means setsid(1) does not fork: $! is the service, and its group.
                "$_SV_SETSID" "$@" &
                child=$!
                group=$child
            else
                "$@" &
                child=$!
            fi
            # A stop that landed between the fork and `child=$!` would have signalled nobody.
            [ "$stopping" = 1 ] && stop_service
            while :; do
                wait "$child"
                code=$?
                kill -0 "$child" 2> /dev/null || break
            done
            child=""
            [ -n "$group" ] && drain_group
            group=""
            serving=0
            if [ "$stopping" = 1 ]; then
                cancel_timer
                exit 0
            fi

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
            # In the background so a stop does not wait out the backoff: stop_service signals it.
            sleep "$delay" 9>&- &
            child=$!
            wait "$child" || :
            child=""
            if [ "$stopping" = 1 ]; then
                cancel_timer
                exit 0
            fi
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
        sleep 1 9>&- &
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
