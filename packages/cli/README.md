# SoloW

**Solo Workflow** — a self-hostable control plane for orchestrating AI coding harnesses in
parallel, under human review.

```sh
npx @satcomx00-x00/solow
```

That is the whole install. It brings up the stack on <http://localhost:5000> and opens it.

## What it does

SoloW gives a single developer a board where AI coding harnesses work issues in parallel, each in
its own git worktree, and nothing merges without you approving the diff.

- **Issues and projects mirrored from GitHub or GitLab.** SoloW never creates anything on your
  provider — it mirrors what is already there, and you decide what gets worked.
- **A task per harness, a worktree per task.** Harnesses run isolated; concurrent tasks cannot see or
  clobber each other's working tree.
- **A review gate on every run.** A run pauses and waits for you. Approve it or send it back with
  changes; the harness resumes from where it stopped, not from a cold prompt.
- **Durable runs.** The workflow engine persists queued events and in-flight runs, so a run
  parked at the review gate survives a restart.

Everything runs on your machine. The database is a local SQLite file, harness credentials are
encrypted at rest, and nothing is sent anywhere you did not configure.

## Signing in and network access

A fresh install asks you to create the Owner account on your first visit, and every service
listens on this machine only (`127.0.0.1`). Both are defaults you have to change on purpose:

| Variable | Default | Effect |
| --- | --- | --- |
| `SOLOW_BIND_HOST` | `127.0.0.1` | Interface the web app, orchestrator and Inngest listen on. `0.0.0.0` makes SoloW reachable from the network and prints a warning; put it behind TLS. |
| `SOLOW_DEV_OWNER` | `off` | `on` skips sign-in and treats every visitor as the Owner. Development only; it is refused together with a non-loopback `SOLOW_BIND_HOST`. |

The same two variables apply to `bun run dev` and `bun run start` in a source checkout.

## Requirements

- **Node.js 20+** — to run `npx`.
- To actually run harnesses you will want the [Claude Code](https://claude.com/claude-code) CLI on
  your `PATH`; SoloW launches it per task. Or, with Docker, the isolated container below.

## Airgapped and npm-only installs

**Everything SoloW runs comes from npm. Nothing is downloaded when you start it.**

The two native binaries it needs — the Bun runtime and the Inngest Dev Server — both arrive
inside npm packages, selected by platform:

| Binary | Package | Published by |
| ------ | ------- | ------------ |
| Bun | `@oven/bun-<platform>` | Bun |
| Inngest Dev Server | `@satcomx00-x00/solow-inngest-<platform>` | this project |

Each is an optional dependency constrained by `os`/`cpu`, so npm installs exactly one — yours —
and skips the rest. There is no postinstall hook to run and nothing is fetched from GitHub or any
CDN, which is what makes this work behind an airgap or against an internal registry mirror.

The Inngest packages exist because `inngest-cli` itself ships only a placeholder and downloads
the real binary in a postinstall hook — unusable when install scripts are blocked (npm 12 blocks
them by default) or when there is no route to the internet. The binary is Inngest's, redistributed
unmodified under the Server Side Public License; see `LICENSE.md` inside those packages.

If a binary is somehow absent, SoloW says so and stops rather than downloading anything. An
`inngest` or `bun` already on your `PATH` is preferred over the bundled copy. To let SoloW fetch
a missing binary itself, opt in explicitly:

```sh
SOLOW_FETCH_BINARIES=1 npx @satcomx00-x00/solow
```

## Usage

```
npx @satcomx00-x00/solow [options]
npx @satcomx00-x00/solow backup  [--out <dir>] [--no-engine] [--data-dir <path>]
npx @satcomx00-x00/solow restore [<backup>] [--data-dir <path>]
npx @satcomx00-x00/solow executor-image [--tag <name>]

  -p, --port <n>          Port for the web UI            (default 5000)
      --ws-port <n>       Port for the orchestrator      (default 5001)
      --inngest-port <n>  Port for the workflow engine   (default 8288)
      --data-dir <path>   Where state lives              (default ~/.solow)
      --no-open           Do not open a browser on start
  -h, --help              Show help
  -v, --version           Print the version
```

## Where your data lives

Everything is under `~/.solow` (override with `--data-dir` or `$SOLOW_HOME`):

| Path                  | What it holds                                          |
| --------------------- | ------------------------------------------------------ |
| `solow.db`            | The SQLite database — issues, tasks, runs, transcripts  |
| `secret.key`          | Encryption key for stored provider tokens               |
| `auth.secret`         | Signs the session cookie                                |
| `stream.secret`       | Signs stream subscription tickets                       |
| `orchestrator.secret` | Authenticates the web app to the orchestrator           |
| `inngest-*.key`       | Signing and event keys for the workflow engine          |
| `inngest/`            | The workflow engine's queue and runs in flight          |
| `worktrees/`          | One git worktree per running task                       |
| `repos/`              | Cache of cloned repositories                            |
| `skills/`             | Repositories imported Skills were fetched from          |
| `backups/`            | Backups, including the automatic ones before upgrades   |

The key files are generated on first run and written `0600`. An exported variable of the same
name (`SOLOW_SECRET_KEY`, `SOLOW_AUTH_SECRET`, …) wins over the file. The database encrypts stored
secrets with `secret.key`, so a backup without it is not a backup.

To start completely fresh, stop SoloW and delete the directory.

## Backup and restore

```sh
npx @satcomx00-x00/solow backup                  # into ~/.solow/backups, safe while running
npx @satcomx00-x00/solow backup --out /mnt/usb
npx @satcomx00-x00/solow restore                 # lists the backups
npx @satcomx00-x00/solow restore <name or path>  # SoloW must be stopped
```

Copying the folder while SoloW runs is not a reliable backup, because the database is mid-write.
`backup` takes a consistent copy of the database, the keys and the engine's state; worktrees and
clones are not included. `restore` keeps what it replaces as a backup, so it can be undone.
Details: [Backup and Restore](https://github.com/Satcomx00-x00/SoloW/blob/main/docs/operations/backup-and-restore.md).

## Running agents in an isolated container

Without it, an agent runs as you, on this machine, and can read, change or send anything you can.
If Docker is installed, build the container image once:

```
npx @satcomx00-x00/solow executor-image
```

It builds `solow-executor:local` with Claude Code and opencode inside, then checks that both run
as your user. From then on the guided setup's "Connect Claude" runs Claude in a container that
sees only the repository it works on (connect again if you already had). The image holds no
credentials; the one a task needs is handed in when it runs. Details:
[Execution Environments](https://github.com/Satcomx00-x00/SoloW/blob/main/docs/features/F07-execution-environments.md#the-executor-image).

## Upgrading

```sh
npx @satcomx00-x00/solow@latest
```

Migrations run on every start, so an existing database is brought up to date automatically. When
one is pending, a copy of the database and its keys is taken into `backups/` first; the five
newest are kept (`SOLOW_BACKUP_KEEP`). To roll back, reinstall the previous version and restore
its `pre-migrate` copy.

## Staying up

A service that crashes is restarted after 1 s, 2 s, 4 s… while the other two keep running. One
that fails five times in a row stops SoloW with an error, for a service manager to act on. For a
long-running install, see
[Running as a Service](https://github.com/Satcomx00-x00/SoloW/blob/main/docs/operations/running-as-a-service.md),
which includes a systemd unit.

## Source and issues

<https://github.com/Satcomx00-x00/SoloW>

## Licence

Apache-2.0. The full text is in `LICENSE`; `NOTICE` carries the copyright and ships with it.

One caveat worth knowing before you build on this. The package declares a platform-specific
optional dependency, `@satcomx00-x00/solow-inngest-<platform>`, carrying the Inngest Dev Server
binary. That binary is Inngest's own work, redistributed unmodified under the **Server Side Public
License**, with upstream's `LICENSE.md` shipped beside it. SoloW starts it as a separate process
and neither links against nor modifies it, so those terms apply to that binary alone — but "SoloW
is Apache-2.0" is not the same statement as "everything `npx` installs is Apache-2.0".
