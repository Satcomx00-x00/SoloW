# SoloW

**Solo Workflow** — a self-hostable control plane for orchestrating AI coding agents in
parallel, under human review.

```sh
npx @satcomx00-x00/solow
```

That is the whole install. It brings up the stack on <http://localhost:5000> and opens it.

## What it does

SoloW gives a single developer a board where AI coding agents work issues in parallel, each in
its own git worktree, and nothing merges without you approving the diff.

- **Issues and projects mirrored from GitHub or GitLab.** SoloW never creates anything on your
  provider — it mirrors what is already there, and you decide what gets worked.
- **A task per agent, a worktree per task.** Agents run isolated; concurrent tasks cannot see or
  clobber each other's working tree.
- **A review gate on every run.** A run pauses and waits for you. Approve it or send it back with
  changes; the agent resumes from where it stopped, not from a cold prompt.
- **Durable runs.** The workflow engine persists queued events and in-flight runs, so a run
  parked at the review gate survives a restart.

Everything runs on your machine. The database is a local SQLite file, agent credentials are
encrypted at rest, and nothing is sent anywhere you did not configure.

## Requirements

- **Node.js 20+** — to run `npx`.
- Nothing else. The Bun runtime the services need is installed as a dependency.
- To actually run agents you will want the [Claude Code](https://claude.com/claude-code) CLI on
  your `PATH`; SoloW launches it per task.

## Usage

```
npx @satcomx00-x00/solow [options]

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

| Path            | What it holds                                            |
| --------------- | -------------------------------------------------------- |
| `solow.db`      | The SQLite database — issues, tasks, runs, transcripts    |
| `secret.key`    | Encryption key for stored provider tokens                 |
| `auth.secret`   | Signs the session cookie                                  |
| `stream.secret` | Signs stream subscription tickets                         |
| `worktrees/`    | One git worktree per running task                         |
| `repos/`        | Cache of cloned repositories                              |

The three key files are generated on first run and written `0600`. **Back them up** — the
database encrypts stored secrets with `secret.key`, so losing it makes those unrecoverable.

To start completely fresh, stop SoloW and delete the directory.

## Upgrading

```sh
npx @satcomx00-x00/solow@latest
```

Migrations run on every start, so an existing database is brought up to date automatically.

## Source and issues

<https://github.com/Satcomx00-x00/SoloW> — AGPL-3.0-only.
