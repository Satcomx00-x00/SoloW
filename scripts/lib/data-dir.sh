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

# The folder holds the master key and a database with every session token in it, so nobody else
# on the machine may read any of it. The umask comes first, before anything is created, and it is
# inherited: the services create the database's -wal and -shm, the engine's files and backups
# themselves, long after this script has stopped writing anything. A key file written with
# `umask 077` in one place and a database created 0664 by a service is how the folder ended up
# group-readable in the first place.
umask 077

GC_DIR="${SOLOW_HOME:-$ROOT/.solow}"
# No `-m 700`: with -p it would cover only the last directory, and the umask already makes every
# directory this creates 0700.
mkdir -p "$GC_DIR"
GC_DIR="$(CDPATH='' cd -- "$GC_DIR" && pwd)"

# A folder an earlier version made is tightened on every start, which also undoes a stray
# `chmod`. Only what SoloW put there: the folder, its keys, its database and the engine's state and
# backups (which hold copies of both). Anything else someone keeps in it keeps the mode they gave
# it. Not fatal: a SOLOW_HOME on a filesystem without Unix modes is still a place to run from.
chmod 700 "$GC_DIR" 2> /dev/null || echo "[$LOG_TAG] WARNING: could not make $GC_DIR private (chmod 700)" >&2
for _dd_file in "$GC_DIR"/*.key "$GC_DIR"/*.secret "$GC_DIR"/solow.db "$GC_DIR"/solow.db-*; do
    [ -f "$_dd_file" ] && chmod 600 "$_dd_file" 2> /dev/null || :
done
for _dd_tree in "$GC_DIR/inngest" "$GC_DIR/backups"; do
    [ -d "$_dd_tree" ] && chmod -R go= "$_dd_tree" 2> /dev/null || :
done
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
