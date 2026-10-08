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

exec bun run "$ROOT/packages/db/src/backup-cli.ts" "$@" --data-dir "$GC_DIR"
