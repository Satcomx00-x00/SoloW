#!/usr/bin/env sh
# Back up and restore the repo launcher's data folder ($SOLOW_HOME, default .solow/):
#   sh scripts/backup.sh backup [--out <dir>] [--no-engine]   (bun run backup, make backup)
#   sh scripts/backup.sh restore <backup>                     (bun run restore, make restore)
#   sh scripts/backup.sh list
# The work is packages/db/src/backup-cli.ts, the same code `npx solow backup` runs; this only says
# which folder. docs/operations/backup-and-restore.md has the details.
set -eu

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
# shellcheck disable=SC2034 # read by scripts/lib/data-dir.sh
LOG_TAG=backup
# Not `cd "$ROOT"`: a relative --out or backup path means relative to where it was typed.
# shellcheck source=/dev/null
. "$ROOT/scripts/lib/data-dir.sh"

# A restore replaces the database under anything running on it, so it takes the data folder's lock
# first: refused while a stack holds it, and held by the restore below until it exits, so that no
# launcher starts meanwhile. Bun cannot take a flock(2) itself; it inherits fd 9 and is told so.
# Without a backup named, `restore` only lists them, which is fine while SoloW runs.
if [ "${1:-}" = restore ] && [ $# -ge 2 ] && lock_data_dir; then
    export SOLOW_DATA_DIR_LOCKED=1
fi

exec bun run "$ROOT/packages/db/src/backup-cli.ts" "$@" --data-dir "$GC_DIR"
