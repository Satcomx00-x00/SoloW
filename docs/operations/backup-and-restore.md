# Backup and Restore

**Status:** Draft · **Owner:** Operator · **Last reviewed:** 2026-10-08

How SoloW keeps its state, how to back it up and restore it, and what an upgrade does to the
database first. Closes [FINDINGS F1](../FINDINGS.md); the requirements are
[F16 FR-20 to FR-24](../features/F16-platform-deployment.md).

## One data folder

Everything SoloW keeps lives in one folder:

| Launcher | Folder |
| --- | --- |
| `npx @satcomx00-x00/solow` | `~/.solow`, or `--data-dir`, or `$SOLOW_HOME` |
| A checkout (`bun run dev`, `bun run start`) | `.solow/` in the checkout, or `$SOLOW_HOME` |

| Inside it | What it is | In a backup |
| --- | --- | --- |
| `solow.db` | The database: Projects, Issues, Tasks, Sessions, transcripts, settings | yes, as a consistent copy |
| `secret.key` (npx) or `dev-secret.key` (checkout) | Encrypts the stored provider tokens. Without it they cannot be read | yes |
| `auth.secret`, `stream.secret` | Sign the session cookie and the stream tickets | yes |
| `orchestrator.secret`, `inngest-signing.key`, `inngest-event.key` | The trust between the web app, the orchestrator and the engine | yes |
| `inngest/` | The engine's state: queued events and runs in flight | yes, unless `--no-engine` |
| `worktrees/` | One working copy per Task | no |
| `repos/` | Clones of each Repository that the worktrees are made from | no |
| `skills/` | Repositories that imported Skills were fetched from | no |
| `backups/` | Backups, the automatic ones included | no |
| `solow.pid` | Present while the stack runs on this folder | no |

The checkout's launchers used to leave the last three roots to each service's own default, which
put imported Skills under `apps/web/.solow/skills`, outside the folder. They now set all three
inside it. An exported `SOLOW_WORKTREE_ROOT`, `SOLOW_REPO_CACHE_ROOT` or `SOLOW_SKILLS_ROOT` still
wins.

**Why worktrees and clones are left out.** They can be large, `node_modules` included, and the
repository clones can be fetched again. A worktree, though, holds a Task's work until that Task is
approved and pushed. To move SoloW to another machine without losing work in progress, approve or
finish the Tasks first, or copy `worktrees/` and `repos/` yourself with the stack stopped. A
restore on the same machine leaves both folders where they are.

## Back up

```sh
npx @satcomx00-x00/solow backup               # into ~/.solow/backups/<time>-manual
npx @satcomx00-x00/solow backup --out /mnt/usb
bun run backup                                # a checkout; or: make backup [OUT=/mnt/usb]
```

A backup is safe while SoloW runs. The database is copied with SQLite's `VACUUM INTO`, which
reads one consistent snapshot even while the web app and the orchestrator keep writing. Copying
the folder does not do this: the database runs in WAL mode, so a file copy can catch
`solow.db` and `solow.db-wal` at different moments. Each copy is integrity-checked before it is
kept.

Each database is consistent on its own, but the app database and the engine's are copied a moment
apart. For a backup in which the engine's runs in flight match the app database exactly, stop
SoloW first.

A backup is a plain directory with a `manifest.json`, written last. A directory without one is a
backup that did not finish, and `restore` never offers it. A backup inside the data folder lives
on the same disk: copy it somewhere else, or use `--out`.

## Restore

```sh
npx @satcomx00-x00/solow restore                           # lists the backups
npx @satcomx00-x00/solow restore 20261008T140402Z-manual   # by name, or a path
bun run restore 20261008T140402Z-manual                    # a checkout; or: make restore FROM=...
```

- **SoloW must be stopped.** Restore refuses while `solow.pid` names a live process. If SoloW is
  not running and the refusal persists, the file is stale; remove it.
- **A restore can be undone.** What was there before is backed up first, as `<time>-pre-restore`.
  Restoring that backup puts things back.
- The database, the keys and, when the backup has it, the engine's state are replaced. A backup
  with no engine state, such as a pre-upgrade copy, leaves the current engine state in place. A
  run the engine still holds may then resume against the restored database.

## Before an upgrade

Every start applies any new migrations. When at least one is pending, a copy of the database and
its keys is taken first, as `backups/<time>-pre-migrate`. If that copy cannot be taken, the
migration does not run. Nothing is copied when no migration is pending, so restarts do not push the
copy that matters out of the kept set.

The five newest pre-upgrade copies are kept, and the same for pre-restore copies. Change the
number with `SOLOW_BACKUP_KEEP`. Backups you make yourself are never removed.

To roll back an upgrade, stop SoloW, reinstall the previous version and restore its
`pre-migrate` copy. Restoring the copy and starting the new version again only repeats the
migration.

## Limits

- A backup made by the checkout names its key `dev-secret.key`. The npm package reads
  `secret.key`. To move data between the two, rename the file after restoring.
- Hosted deployments on Postgres are not covered. This is the local, SQLite deployment
  ([Decision 0008](../decisions/0008-data-store-strategy.md)).
