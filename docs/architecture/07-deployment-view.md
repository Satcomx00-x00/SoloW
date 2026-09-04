# 7. Deployment View

**Status:** Draft · **Owner:** Architecture / Operator · **Last reviewed:** 2026-09-04

SoloW runs in two deployment modes from one product. This section describes both at a
business-readable level. See [F16](../features/F16-platform-deployment.md) for the
requirements and [Decision 0008](../decisions/0008-data-store-strategy.md) for the data
store choice.

## Local deployment (single user)

- The Interactive Application, the Orchestration Component, and the State Store all run on
  one machine.
- The State Store is a lightweight embedded store; work and working copies are kept locally.
- Agents run in local, container, or remote Executors as configured.
- Nothing is required from any external service, and no telemetry is sent.

> **Local shape:** one machine hosts the application, the orchestrator, and the embedded
> store; agents run in the chosen Executors; the user works entirely on their own hardware.

> **Implementation note (2026-08-20):** the durable-execution engine [Decision 0004](../decisions/0004-durable-orchestration-engine.md)
> chose (Inngest) runs locally as its own Dev Server process, polled by and forwarding runs
> into the Orchestration Component's `/api/inngest` endpoint. It is an implementation detail
> of that component, not a fourth deployable unit in this model — hosted deployments point the
> same client at Inngest Cloud instead.

## Starting a local deployment

One command, on a machine with nothing installed but Node and git:

```
npx @satcomx00-x00/solow
```

There is no repository checkout, no build step and no configuration file to write first. The
launcher is the published `bin` of the npm package; it resolves a Bun runtime, brings up the three
local processes named above, and prints the URL to open.

**Everything it creates lives in one directory** — `~/.solow` by default, `$SOLOW_HOME` or
`--data-dir` otherwise. That is the embedded database, the worktrees and repository clones agents
work in, and the three generated keys (data encryption, session signing, stream signing). Deleting
that directory is a full uninstall; copying it is a full backup. Nothing is written outside it and
nothing leaves the machine.

**Restarting is safe and is the upgrade path.** Migrations run on every start rather than only the
first — already-applied ones are skipped, so it is cheap, and without it an upgraded launcher would
open an old database and fail on tables that do not exist yet. Workspace bootstrap is idempotent
for the same reason: an install upgraded from a build that had no agent catalog gets one, instead
of a Settings page with an empty picker. Seeding is first-run only, so a restart never disturbs
existing work.

**No credentials are ever printed or logged.** The first person to open the URL creates the single
Owner account themselves at the sign-in page, and the application refuses a second one. So there is
no generated password to display once, to leak into a terminal scrollback, or to keep out of a log
sink — the property is structural rather than something the launcher has to be careful about.

**Preconditions fail at the start, with the remedy.** A missing Bun runtime, a missing Inngest Dev
Server, a `git` that cannot run, and each of the three ports already being in use are all checked
before anything starts, and each names both the cause and the command that fixes it. `git` is
checked by running it rather than by looking it up, because a broken shim or an unsatisfied
dynamic link passes a lookup and then fails on the first clone — long after the web UI has come up
and the person has stopped suspecting their installation.

Ctrl-C, or any termination signal, takes the whole stack down with it.

> **Implementation note (2026-09-04):** ports default to 5000 (application), 5001 (orchestrator)
> and 8288 (Inngest Dev Server), and each moves independently — `--port`, `--ws-port` and
> `--inngest-port`. Package managers — Homebrew, Scoop, a global npm install — are wrappers around
> this same entry point rather than separate builds.

## Hosted deployment (multi-user)

- The Interactive Application and the Orchestration Component run as a shared service;
  multiple users connect to it.
- The State Store is a shared database supporting many users and Workspaces.
- Work is isolated per Workspace, which is the tenancy and access boundary.
- Agents run in container, remote, or cloud Executors; Executors can scale independently of
  the application.

> **Hosted shape:** a shared application and orchestrator back a shared database; many users
> across many Workspaces connect; Executors run agents on separate compute.

## What stays the same across modes

- The features, the domain model, the review-first lifecycle, and the user experience are
  identical.
- Profiles, Integrations, and secrets remain Workspace-scoped.
- The only differences are configuration: which store is used, whether multiple users and
  access control are present, and where Executors run.

## Operator responsibilities in hosted mode

- Managing members and their access to Workspaces (F16).
- Providing and rotating secrets safely (F17).
- Ensuring Executors are available and appropriately scaled (F07).
- Keeping the shared database and orchestrator healthy (product NFR-1, NFR-2).
