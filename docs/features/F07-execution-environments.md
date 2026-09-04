# F07 — Execution Environments

**Status:** Draft · **Owner:** Product · **Maturity:** Core · **Last reviewed:** 2026-09-03

## Summary

An Executor is where an Agent actually runs. SoloW supports several execution
environments so users can run agents locally for convenience or offload heavy work to
containers, remote machines, or the cloud — all managed from the same control plane.

## The `Executor` interface (issue #1)

Before a second Executor kind existed, SoloW adopted one interface every kind implements —
`apps/orchestrator/src/executor/types.ts`:

```ts
interface Executor {
  spawn(cmd: string[], opts: SpawnOpts): ProcessHandle; // long-lived agent process
  exec(cmd: string[], opts?: ExecOpts): Promise<ExecResult>; // one-shot: git, du, version probes
  baseEnv(): Promise<Record<string, string>>; // what a command here would otherwise inherit
  fs: ExecutorFs; // list, read, write, copy — root-jailed
  forward(port: number): Promise<ForwardHandle>; // dev-server preview
  metrics(): Promise<ExecutorMetrics>; // cpu, mem, disk, load
  dispose(): Promise<void>;
}
```

`apps/orchestrator/src/executor/local.ts` — the Local Executor — is the default, and the one
module in the orchestrator allowed to call `Bun.spawn`, the Bun shell, or touch the host
filesystem directly (`scripts/audit-executor-boundary.ts` enforces the boundary). The Container
Executor (`apps/orchestrator/src/executor/docker.ts`, #96) is the second implementation, and it
does **not** widen that boundary: it composes a host Executor and issues `docker` commands
through it, so exactly one file still touches the host. Everything that reaches into the place an
agent runs goes through the interface instead of a call of its own:

- The **agent runner** (`apps/orchestrator/src/agent/claude-code-runner.ts`) launches the
  `claude` CLI via `executor.spawn` — `packages/claude-code`'s `startClaudeSession` never spawns
  a process itself, it takes a `SpawnFn` the caller supplies.
- The **worktree manager and diff reader** (`apps/orchestrator/src/worktree/manager.ts`) run
  every `git` invocation via `executor.exec` instead of a `Bun.spawn`/shell call of its own.

Three properties every implementation must hold:

- **`fs` is root-jailed.** Path resolution happens once, in the executor, and every consumer
  inherits it — the highest path-traversal risk surface in the product (#33 file tree, #52
  `.env` copy).
- **`spawn` takes the environment verbatim.** It replaces the child's environment rather than
  merging it with the executor's own, so the one credential the billing guard shaped is all an
  agent process ever sees (Principle IV).
- **`baseEnv()` names what a command here would otherwise inherit** — the host's environment for
  the local driver, the image's for a container one. Because `spawn` replaces rather than merges,
  the caller has to shape the agent's environment from the right base: handing a containerised
  agent the orchestrator's own `PATH` and `HOME` describes a machine it is not running on, and it
  then fails for reasons that have nothing to do with the Task.

The bet the interface was written on — that a second Executor kind is **one new file**
implementing it, a driver rather than a second copy of "how do I reach the place the agent runs" —
has now been tested once, by the Container Executor (#96). It held: the call sites that run git,
copy setup files and launch the agent were not rewritten for it, and `baseEnv()` above is the only
member the interface gained. Remote SSH (#97) and Cloud (#107) follow the same shape.

## The Container Executor (issue #96)

`docker.ts` runs **one long-lived container per Task, with every command a `docker exec` into
it**, addressed entirely through the `docker` CLI. The mechanics and the reasoning behind them are
recorded in [ADR 0023](../decisions/0023-docker-executor-cli.md); what F07 needs to state is what
a user gets.

- **The Task's own Profile decides where it runs.** The executor is built per run from the Task's
  Executor Profile, not once per process, and the agent runner and every worktree operation are
  bound to it. Each `git` invocation, each setup-file copy and the agent itself therefore run
  where the Task was told to run — which is what makes the driver gate below a real guarantee
  rather than a check nothing downstream honours.
- **Provisioning is proved before anything is cloned** (FR-5). One preflight step, placed after
  the driver gate and before the repository is prepared, asks the cheapest and most fundamental
  question first — is there a `docker` at all, is the daemon reachable, are the worktree roots
  absolute, can this kernel enforce the limits this Profile asks for, can the image be obtained,
  is every bind source safe to mount, did the container stay up, does the image carry the
  utilities the driver needs, did the Profile's prepare script succeed.
- **Resource limits are the Profile's, enforced by the kernel or refused.** `cpus` and `memoryMb`
  became part of the Docker configuration with this driver, and a host whose kernel cannot enforce
  them fails the Task with that as the reason. Reporting an isolation the user did not get is the
  same class of failure the driver gate exists to prevent.
- **Credentials never enter the container's argv, its image, or `docker inspect` output.** The
  environment a command runs under is delivered on that command's own stdin (Principle IV,
  [F17](./F17-security-secrets.md)), because `-e` would put it in a host-visible command line and
  in the container's inspectable configuration for as long as it exists.
- **Health is the container's own, never the host's proxied.** CPU and memory come from the
  container's cgroup; no load average is reported at all, because `/proc/loadavg` inside a
  container is the *host's* figure and publishing it as the Task's would be a wrong number rather
  than a rough one.
- **Teardown is a sweep, not a hope.** A completed or failed run disposes of its container
  immediately, and the reconciliation sweep removes containers a crashed orchestrator left behind
  — identified by their labels, and only once the Task and the agent registry both agree no run
  still holds them.

### The isolation that holds, and where it stops

A container executor gives a Task **its own process namespace, its own image and userland, and
kernel-enforced CPU, memory and pid ceilings**, and it keeps the host's filesystem out of reach:
the only host directories inside the container are the ones *this Task* works in, plus whatever
the Profile's own `mounts` name — and every one of those sources is measured against a guard that
admits the deployment's own roots, the areas a Unix host keeps site content in, and the work half
of a home directory, and refuses the host's own directories outright.

**A Task that runs anywhere but the orchestrator's host gets a repository of its own.** That is
`ownClone` in `task-run.ts` — true for every non-`local` kind — and the container's mount set is
derived from it rather than discovered: one pair per attached Repository, this Task's worktree
and this Task's clone of that Repository (`executorBindPaths`, `taskRepositoryPath`). Neither
worktree root nor cache root nor the Repository the deployment holds appears in it, and the
container driver's jailed `fs` API is rooted at this Task's own worktree directory rather than at
the root that holds every Task's — a tighter jail than the local driver's, which is per-process and
still the worktree root.

The design is forced, and by git rather than by Docker. A worktree's `.git` is a *file*
containing `gitdir:` and an absolute path into its parent repository's `.git/worktrees/`, and
`git worktree add`, `prune` and `remove` all operate on that parent — so a container holding only
its own worktree directory holds something that is not a git repository at all. The parent has to
be mounted, and **at the same absolute path on both sides**: absolute host paths travel in argv
(`git -C <path>`, the setup-file copy) where neither the interface nor a driver jails or
translates them, and that `gitdir:` pointer is an absolute host path too. Mounting the *shared*
Repository as that parent is what the first cut did, and it handed every container on that
Repository a read-write view of every other Task's objects — committed and merely staged — its
result branch, its worktree registrations and its host paths. So the parent that gets mounted is
a clone belonging to this Task and to nothing else.

Three details make that clone an actual boundary rather than a second name for the same files.
It is built with `git init` plus `git fetch`, never `git clone`, because a clone from a local path
hardlinks the object files — the Task's objects and the shared repository's would be the same
inodes, and the container owns them; a fetch transfers a pack, so no inode is shared. It has no
`origin`, so nothing inside the container can name the shared repository, let alone reach it. And
administration of the shared repository — the cache clone, `git worktree add`, seeding the
setup-file allowlist, the removal at the end — runs on the *orchestrator's* executor, not the
Task's, which is what keeps the shared repository out of the mount set in the first place. What
stays on the Task's own executor is everything about the Task's content: the agent, commit,
discard, status and diff.

**The approved branch is moved back afterwards.** A Task with its own clone commits into a
directory that is deleted with that clone at the end of the run, so on approval the `publish` step
(`WorktreeOps.publish` → `publishWorktreeBranch`) fetches that one branch out of the Task's clone
and into the Repository the Owner actually has — before the cleanup, and on the orchestrator's
executor rather than the Task's. It is a no-op when the two paths are the same, which is every
local run; without it the result branch F08 promises would name a directory the next cleanup
deletes.

**A `local` Task keeps the shared repository, deliberately.** Its worktree is added to the
Repository the deployment holds, and two local Tasks on one Repository share that parent with
git's own locking, exactly as before. A private clone there would cost a copy of the repository
per Task to buy nothing: a local agent runs as the orchestrator's uid on the orchestrator's
filesystem, so it can walk to another Task's worktree whether or not the two share a parent.

Stated precisely, the guarantee differs by Executor kind:

- **Local** — no isolation from the host, by construction, and none between concurrent Tasks
  beyond the Worktree's: one directory and one branch each, on a parent repository they share.
- **Container** — isolation from the host holds (only this Task's directories and the Profile's
  declared mounts are visible), isolation of resources holds (kernel-enforced or the Task fails),
  and isolation between concurrent Tasks holds at the mount set: no path either container is
  given is, or contains, a path the other container is given, in either direction.

What remains shared whatever the kind: the machine itself — its kernel, and on a Container
Executor the Docker daemon the driver talks to — and any directory an operator names explicitly in
a Profile's `mounts`, since a source two Profiles both name is a directory every Task using them
shares.

Where the proof lives, because a property this load-bearing should not rest on this prose:

- `apps/orchestrator/src/inngest/functions/task-run.test.ts` — *"gives a Task no path belonging to
  another Task under the same roots (AC-2)"*: two Tasks attached to the **same** two Repositories,
  the real mount set each run built, and every path of one checked against every path of the other
  in both directions. It is written as a comparison of two runs because that is the shape the
  defect had — the roots are a plausible-looking answer for one Task considered alone, and a
  single-Task assertion did not catch it.
- `scripts/smoke-docker-executor.sh` — the same property against a live daemon: two containers, a
  real read attempted across them, and a `..` traversal refused by the jail.
- `apps/orchestrator/src/worktree/manager.test.ts` — the clone built in place with init and fetch,
  the worktree added to it, one branch published into the shared repository, nothing published when
  the Task worked in that repository directly, and the copy removed with the worktree.

## Executor Profile configuration (issue #73)

An Executor Profile answers *where* an agent runs; its `config` column answers *how*. The column
holds one typed payload per kind, validated by a **discriminated union** in
`packages/contracts/src/executor-config.ts`:

```ts
executorConfigSchema = z.discriminatedUnion("kind", [
  { kind: "local",  prepareScript?, env },
  { kind: "docker", image, mounts, network?, cpus?, memoryMb?, prepareScript?, env },
  { kind: "ssh",    host, port, user, keySecretId, prepareScript?, env },
  { kind: "cloud",  provider, region?, size, credentialSecretId, prepareScript?, env },
])
```

**One table, N shapes.** The alternative — a column per kind, or a table per kind — makes every
new runtime a migration plus a DAL change plus a form rewrite. Here a new runtime is a union
member plus a driver, which is what makes the executor matrix (#96 Docker, #97 SSH, #107
Kubernetes) additive rather than schema-breaking.

Four properties hold, each enforced by something other than review:

- **The kind lives inside the configuration.** `executor_profile.kind` is a denormalised copy the
  DAL derives on write, kept only so the kind is queryable. A separate input field could disagree
  with `config.kind`, and there would be no principled answer to which one a driver should
  believe.
- **Credentials are references, never values** (Principle IV). No member has a field for a key or
  a token — only an id pointing at the encrypted `secret` table, and `secret.kind` gained
  `ssh_key` and `cloud_credential` so those credentials have somewhere to live. Members are
  `.strict()`, so a config carrying `privateKey` is *rejected* at the API boundary rather than
  silently stripped and forgotten about.
- **A profile's environment is for the runtime, not for the agent's credential.** The variables
  the billing guard owns (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`) cannot be named in a
  profile at all, and `resolveAgentRunEnv` applies profile variables *under* the credential
  shaping — so even a row written outside the API cannot become a route to metered billing.
- **A configurable kind is not a runnable one.** `apps/orchestrator/src/executor/drivers.ts`
  lists the kinds a driver exists for — `local` and `docker` today, with SSH (#97) and Cloud
  (#107) configurable ahead of theirs — and the lifecycle fails a Task pointed at any other kind
  before anything is cloned. Without that check a Task on such a profile would run on the
  orchestrator's own host and report success — the user asked for isolation and would not have
  got it. `docker` joined that list **last** in #96, after the lifecycle actually built each
  Task's executor from its own Profile: widening the list first would have reproduced exactly the
  failure it exists to prevent, because until then nothing downstream read the kind.

The settings form renders from the selected kind: a kind `Select`, then the fields that kind's
schema declares, then the shared prepare script and environment repeater.

## Jobs served

- **J7 — Offload heavy work.**

## User stories

- As a Solo Power User, I want agents to run on my own machine by default, so setup is
  trivial.
- As a user, I want to run a resource-heavy Task in a container, so it does not slow my
  machine.
- As an Operator, I want agents to run on a designated remote host, so compute is where it
  should be.

## Functional requirements

- **FR-1** SoloW supports these Executor types: **Local** (a process on the host),
  **Container** (an isolated container), **Remote** (an SSH-connected host), and **Cloud**
  (a cloud runner).
- **FR-2** A user configures an Executor as an Executor Profile (see [F05](./F05-agent-executor-profiles.md))
  and selects it per Task.
- **FR-3** Each Executor type runs the same Agents and produces the same Session behaviour,
  so the choice of Executor does not change how a Task is used or reviewed.
- **FR-4** Subscription and API-key credentials are made available to Agents in every
  Executor type without exposing them to Agent-run code (see [F06](./F06-authentication-billing.md),
  [F17](./F17-security-secrets.md)).
- **FR-5** SoloW reports Executor health and availability, and prevents launching a
  Task on an unavailable Executor with a clear reason. For a Container Executor the check runs
  before anything is cloned, and the reason names the condition in the operator's terms — a
  missing `docker`, an unreachable daemon, worktree roots that are not absolute, limits this
  kernel cannot enforce, an image that cannot be obtained, a mount source that would expose the
  host, a container that exited immediately, an image missing utilities the executor needs, or a
  prepare script that failed — quoting the daemon's own words where it said something useful.
  An Executor that becomes unavailable *mid*-run is distinguished from a command that merely
  failed, so the step is retried instead of the Task being failed on a misread exit code.
- **FR-6** A Worktree is provisioned inside the chosen Executor so file isolation holds
  regardless of environment (see [F08](./F08-workspaces-repositories.md)), and **how strong that
  isolation is depends on the Executor kind**. On a Local Executor it is the Worktree's alone: the
  worktree is added to the Repository the deployment holds, and two Tasks on that Repository share
  the parent they were added to. On every other kind — a Container Executor today — the Task is
  also given its own clone of each Repository it is attached to, so its container is handed no
  directory belonging to another Task, and the approved branch is published back into the Owner's
  Repository when the review is approved. See *The isolation that holds, and where it stops*.

## Non-functional requirements

- **NFR-1** Adding or removing an Executor does not affect Tasks running on other Executors.
- **NFR-2** Remote and container Executors are usable without a human logging in interactively
  on the target machine.
- **NFR-3** Cloud execution is optional and never required for the product to function
  (see product [NFR-14](../product/03-product-requirements.md)).

## States & rules

- Executor availability is monitored; a Task queues or fails clearly if its Executor is
  unavailable.
- The Executor type is transparent to review: the same diff, terminal, and preview
  experience applies everywhere.

## Edge cases & failure handling

- If a Remote host becomes unreachable mid-run, the affected Session fails with a clear
  reason and can be retried, without affecting other Executors.
- If a Container cannot be provisioned, the Task fails before starting the Agent, with an
  actionable message — the check runs before the repository is prepared, so nothing has been
  cloned by the time it reports.
- If the orchestrator dies while a container is running, nothing disposes of it at the time. The
  reconciliation sweep removes it once no run holds it, so a crash costs the container's CPU and
  memory reservation until the next sweep rather than for the life of the process.

## Out of scope

- The internal mechanics of container, SSH, and cloud provisioning (architecture concerns —
  the container's are recorded in [0023](../decisions/0023-docker-executor-cli.md)).
- Cost of third-party cloud compute (owned by the provider).

## Related

- [F05 — Agent & Executor Profiles](./F05-agent-executor-profiles.md)
- [F06 — Authentication & Billing Modes](./F06-authentication-billing.md)
- [F08 — Worktrees & Repositories](./F08-workspaces-repositories.md)
- [0023 — Drive the container Executor through the `docker` CLI](../decisions/0023-docker-executor-cli.md)
