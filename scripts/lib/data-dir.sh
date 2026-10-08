# shellcheck shell=sh
# Sourced by scripts/dev.sh, scripts/start.sh and scripts/backup.sh (needs $ROOT; $LOG_TAG names
# the caller in messages).
#
# One data folder holds all of SoloW's state (FINDINGS F1): the database, the keys that read it,
# the engine's queue and in-flight runs, the Task worktrees, the repository cache and imported
# Skills. `$SOLOW_HOME` moves it, the same variable `npx solow` reads; the default is the
# checkout's own `.solow/`.
#
# The three roots used to be left to each service's relative default, which put them wherever that
# service happened to run: the web app runs from `apps/web`, so imported Skills landed in
# `apps/web/.solow/skills`, outside the folder a backup or a `rm -rf .solow` reset was looking at.
# Exported here, absolute, they are where the folder is. An exported value still wins.

GC_DIR="${SOLOW_HOME:-$ROOT/.solow}"
mkdir -p "$GC_DIR"
GC_DIR="$(CDPATH='' cd -- "$GC_DIR" && pwd)"
SOLOW_HOME="$GC_DIR"
SOLOW_WORKTREE_ROOT="${SOLOW_WORKTREE_ROOT:-$GC_DIR/worktrees}"
SOLOW_REPO_CACHE_ROOT="${SOLOW_REPO_CACHE_ROOT:-$GC_DIR/repos}"
SOLOW_SKILLS_ROOT="${SOLOW_SKILLS_ROOT:-$GC_DIR/skills}"
export SOLOW_HOME SOLOW_WORKTREE_ROOT SOLOW_REPO_CACHE_ROOT SOLOW_SKILLS_ROOT

SOLOW_PID_FILE="$GC_DIR/solow.pid"

# Marks the folder as in use for as long as this launcher runs. `restore` refuses while it names a
# live process, and a second launcher on the same folder refuses to start: two stacks on one SQLite
# file and one engine directory would each run the other's Tasks.
claim_data_dir() {
    if [ -s "$SOLOW_PID_FILE" ]; then
        _dd_pid="$(cat "$SOLOW_PID_FILE")"
        if [ "$_dd_pid" != "$$" ] && kill -0 "$_dd_pid" 2> /dev/null; then
            echo "[$LOG_TAG] SoloW is already running on $GC_DIR (pid $_dd_pid) — stop it first." >&2
            echo "[$LOG_TAG]   If nothing is running, the pid file is stale: rm $SOLOW_PID_FILE" >&2
            exit 1
        fi
    fi
    echo "$$" > "$SOLOW_PID_FILE"
}

release_data_dir() {
    if [ "$(cat "$SOLOW_PID_FILE" 2> /dev/null)" = "$$" ]; then
        rm -f "$SOLOW_PID_FILE"
    fi
}
