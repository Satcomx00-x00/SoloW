# 0023 — Drive the container Executor through the `docker` CLI, one session container per Task

**Status:** Accepted, amended 2026-09-03 · **Date:** 2026-09-03 · **Deciders:** Architecture
**Builds on:** [0002](./0002-technology-stack.md), [0004](./0004-durable-orchestration-engine.md),
[0017](./0017-worktree-git-rpc.md) ·
**Enables:** [F07](../features/F07-execution-environments.md) FR-1, FR-5, FR-6

> **Amended 2026-09-03**, in issue #96's second round and before this record's own branch merged.
> Two parts of the decision below were superseded by review findings reproduced on live
> containers: **the mount set** — a Task no longer shares the parent repository with anything, and
> "two Tasks on a Repository share its parent" is no longer true — and **the bind-source guard**,
> which is now an allow-list rather than a refusal list. Both sections carry the original decision
> and its replacement, marked; nothing is removed. [F07](../features/F07-execution-environments.md)
> *The isolation that holds, and where it stops* describes the result.

## Context

[F07](../features/F07-execution-environments.md) promises four execution environments behind one
interface, and until issue #96 only one of them existed. `apps/orchestrator/src/executor/types.ts`
had been written for a second driver since issue #1 — `scripts/audit-executor-boundary.ts` holds
`local.ts` to being the only file in the orchestrator that may spawn a process or touch a file —
and issue #73 made the Executor Profile's `config` a discriminated union so a new runtime would be
a union member plus a driver rather than a migration. The Docker driver is the first thing to
actually test that claim.

Four facts about the code it has to satisfy decided almost everything below. None of them was
chosen for this feature; all of them were already true.

1. **`ProcessHandle` is a long-lived process, not a command.** It accepts operator input on stdin
   mid-run, its `stdout` and `stderr` are separate pipes that `acp-runner.ts` and
   `claude-code-runner.ts` parse independently, and it has to survive the TERM→KILL escalation in
   `packages/acp/src/session.ts` while `prepare-repository`, `provision-worktree`, `seed`,
   `agent-run-N`, `diff`, `commit` and `cleanup` run around it as separate durable steps.
2. **Absolute host paths are already in argv, everywhere.** `worktree/manager.ts` runs
   `git -C <repoPath> worktree prune`, `scm-ops.ts` and `worktree/status.ts` run `git -C <cwd> …`,
   and `setup-files.ts` runs `mkdir -p <abs>` and `cp -p <abs> <abs>`. Neither the interface nor
   the local driver jails or rewrites those paths, and the git plumbing writes more of them into
   files on disk.
3. **`SpawnOpts.env` *replaces* the child's environment and `ExecOpts.env`'s own comment forbids
   putting a credential where `ps` can read it** (Principle IV). Both are load-bearing for
   subscription billing integrity, and `local.test.ts` pins the replace semantics verbatim.
4. **Inngest suspends a run by leaving an unfulfilled step's promise permanently pending.** The
   handler body is therefore re-executed from the top at every step boundary and abandoned
   mid-flight, so anything expensive outside a `step.run` is paid for dozens of times per Task, and
   anything *inside* one is memoized and not re-done on a retry.

## Decision

**One long-lived container per Task, addressed entirely through the `docker` CLI by composing the
local Executor, with every host directory bind-mounted at its own path and every environment
delivered on the exec's own stdin.**

Five parts, each with a counterfactual worth stating.

### The `docker` CLI, not the daemon's socket API

`docker.ts` makes no `Bun.*` call and is not on the audit's allow-list. It takes a host `Executor`
as a constructor argument and issues `host.exec(["docker", …])` and `host.spawn(["docker", …])`,
so **"exactly one file touches the host" stays literally true with a second driver in the tree.**
An HTTP client on `/var/run/docker.sock` would be a second module opening a socket and streaming
from it — a second place the boundary has to be argued about, and the boundary is the thing that
makes #97 and #107 drivers rather than rewrites.

Two consequences fall out for free rather than being implemented. The CLI already resolves
`DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG` and the TLS material, so a remote or rootless
daemon is a deployment setting and not a code path; and `~/.docker/config.json` carries
private-registry authentication, which is why `dockerCliEnv()` names `HOME` among the seven
variables it passes through. (There is no registry-credential field in `dockerConfig`, and that gap
is named in the driver rather than papered over.)

The third consequence is the one that pays daily: the driver is unit-testable against a fake host
`Executor` that records argv, with **no daemon in CI**. A socket client would need either a daemon
or a mock HTTP server to assert the same things.

The cost is real and accepted: the driver parses text. `docker inspect -f`, `docker ps --format`,
and the daemon's stderr are its API, and a format string that names a field wrongly fails at run
time rather than at compile time. That happened once already and is recorded in the code — the
capability probe field is `.CPUCfsQuota`, not `.CpuCfsQuota`, and the wrong spelling does not
return `false`, it fails the whole template with `can't evaluate field CpuCfsQuota in type
system.dockerInfo`, turning a capability check into an unconditional failure.

### Bind mounts at identical paths on both sides

Every host directory the container needs is mounted at **the same absolute path inside the
container as outside it**. This is forced by fact (2), not chosen for simplicity.

A translated mount would require rewriting the absolute paths in argv, and translating arbitrary
argv is undecidable — `git -C <path>` is recognisable, but the path in a `--git-dir`, in a script
the agent writes, or in the seventeenth positional argument of a tool nobody has added yet is not.
Worse, git writes those paths down: a worktree's `.git` file contains `gitdir: <absolute host
path>`, so a parent repository mounted anywhere else is not a git repository at all from inside the
container. The identical-path rule is what lets `manager.ts`, `scm-ops.ts` and `setup-files.ts` run
unchanged through a container executor, which is the entire premise of the interface.

Three properties travel with it:

- **Absolute roots are a precondition, checked first.** `SOLOW_WORKTREE_ROOT` defaults to
  `.solow/worktrees`, and a relative root resolves against the orchestrator's cwd on the host and
  against the image's `WORKDIR` in the container. The preflight's first rung refuses it by name
  rather than letting the worktree silently not be where the agent looks.
- **`--mount`, never `-v`.** A missing bind source makes `--mount` refuse the run out loud
  (`bind source path does not exist`), where `-v` would silently create a root-owned directory and
  hand the agent an empty worktree with no explanation. Sources the orchestrator knows about are
  `mkdir -p`'d on the host first.
- **`--user <uid>:<gid>`, derived from the orchestrator's own uid.** Verified: without it every
  file the agent writes into the bind-mounted worktree is root-owned on the host, and
  `cleanupWorktree`'s `git worktree remove --force --force` then fails with permission denied and
  leaks the worktree silently — *after* the Task has been marked done. Numeric on both halves,
  because a username would be resolved against the image's `/etc/passwd` and the point of the flag
  is the ownership the host sees.

A bind source is also refused before it is ever built into a `docker run` line. `resolveRepoPath`
returns a `local_path` Repository's `location` verbatim — arbitrary Owner-supplied text — and
registering `/` or `$HOME` as a Repository must not turn the isolation the Owner asked for into a
view of the whole machine.

> **Amended 2026-09-03.** As first accepted, that refusal was a deny-list: `/` and the proper
> ancestors of the worktree root. A deny-list is a promise about every path nobody thought of, and
> this one did not hold — a deployment whose worktree root is anywhere outside the home directory
> makes `$HOME` no ancestor of it, so `$HOME` passed, and `~/.ssh`, `~/.aws` and
> `~/.docker/config.json` came with it; `/var/run/docker.sock` passed too, which is not a leak but
> an escape. `guardMountSource` is now an **allow-list**: the deployment's
> own two roots as the operator set them, paths strictly inside a short list of content areas, and
> the *work* half of a home directory — everything else refused, a relative source included.
> It also asks the question **twice**, of the path as written and of its realpath, because the
> daemon resolves the source's symlinks on the host before it mounts anything: a symlink to `/`
> placed under a world-writable content area passed every lexical rule and handed the container
> `/etc/shadow` and the daemon socket (reproduced on Docker 29.7.2). The cost is a guard that is
> not a pure function and a deployment keeping its repositories somewhere unrecognised failing at
> the preflight; the alternative cost was a host escape reachable from a field the API accepts any
> string in.

### One long-lived session container per Task

The container is created once, lazily, and every command is a `docker exec` into it.

Container-per-command is ruled out by fact (1) rather than by preference. A `ProcessHandle` that
outlives seven durable steps, takes stdin mid-run and answers a two-rung kill ladder *is* a
long-lived container; a per-command design would need one anyway, plus a second lifecycle to
manage the ephemeral ones. `dispose()` is the interface's only teardown verb, and it maps 1:1 onto
one container per Task.

Because fact (4) makes the handler body cheap to re-enter and expensive to do work in,
`createDockerExecutor` is **synchronous and does no I/O at all**. The container lives behind one
memoized promise, and everything slow — the daemon handshake, the image pull, the userland probe,
the prepare script — lives in one durable `step.run("executor-preflight")` placed after the driver
gate and *before* `prepare-repository` clones anything. That placement is what makes F07's "if a
Container cannot be provisioned, the Task fails before starting the Agent, with an actionable
message" true rather than aspirational.

Identity is deliberately split. The container's **name** is
`solow-<sha256(deployment:workspace:task)[0..12]>`, because `idSchema` is `z.string().min(1)` and a
task id is not guaranteed to match Docker's name grammar — sanitising Owner-reachable text into an
identifier is the failure `worktreePath` already refuses. It is deterministic so an Inngest replay
re-attaches instead of building a second container. The container's **identity** lives in labels,
where values have no charset restriction, and every lookup is by label filter. `solow.cfg`, a hash
of everything that cannot be changed after `docker run`, decides adoption: a container that is
running and still matches is adopted as-is (an Inngest retry or a second review round must not tear
down a live agent's workspace), and one that has stopped or whose profile has been edited is
removed and rebuilt.

Teardown is two mechanisms because one is not enough. `dispose()` runs in a plain `finally` around
the lifecycle body — not a `step.run`, which is memoized and would be replayed as already-done on
the very retry that has just built a fresh container. That is the fast path. The **net** is
`executor/reap.ts`, a third arm of the existing reconciliation sweep, because Inngest cancels
*between* steps and never re-enters the body at all. The reaper's entire safety story is the label
pair `solow.managed` + `solow.deployment`: the machine already runs unrelated containers, and a
reaper reasoning from names or images would eventually eat one, while a reaper without the
deployment label would eat a *different* orchestrator's live run when a dev instance and a real one
share a daemon. The containers are deliberately not `--rm`, so a crash leaves the reaper something
to find and an operator some evidence.

### The environment travels on the exec's own stdin

Not in argv, not in a file, and not anywhere `docker inspect` can read it. The variables arrive as
**one base64 line on the exec's own stdin, ahead of the agent's traffic**, decoded by a small shim
that `exec`s the real command.

Every alternative fails a requirement that already existed:

- **`-e KEY=VALUE`** puts the value in the docker CLI's argv *on the host*, where `ps` shows it —
  precisely what `ExecOpts.env`'s comment forbids — and it also lands in `docker inspect`'s
  `.Config.Env` for the life of the container.
- **`-e` and `--env-file` both merge over the image's `ENV`**, so neither can express
  `SpawnOpts.env`'s replace semantics. Verified: an image declaring `ENV IMAGE_LEAK=iamhere` leaks
  it straight through a plain `docker exec`, and only `env -i` clears it.
- **A file in the container's tmpfs** leaves the credential at rest inside the container, and
  forces `spawn` to await a write that its synchronous return type cannot absorb.

The shim's bootstrap `PATH` exists for exactly one reason — `base64` must resolve under `env -i` —
and the decoded blob's first line then either sets the caller's `PATH` or unsets it, so the child's
environment is exactly what the caller named. `printf`, `echo`, `shift` and `exec` are builtins and
need no `PATH`. The shell writes its own pid to a tmpfs file *before* `exec`, so the recorded pid
is the target process rather than a wrapper about to be replaced.

Three details are not decoration. `-i` is mandatory on every shimmed exec: verified that without it
the shim reads EOF, the environment silently vanishes, and the command exits 0 — and on the
`writeFile` path the same omission produces a **zero-byte file with exit 0**, which is data loss on
the exact path issue #52 uses to copy `.env` files into a worktree. `-t` is never passed, because a
TTY merges stdout and stderr and both runners depend on the split. And `base64` is on the required
utilities list the preflight probes, so a distroless or scratch image fails legibly instead of
producing an agent with an empty environment and no explanation; distroless images are, explicitly,
unsupported.

For `exec` — as opposed to `spawn` — "the executor's own environment" means **the container's,
never `process.env`**. Copying the host's environment in would leak host credentials into the
isolation the profile asked for, which is the opposite of what the driver is for. The same
principle put `baseEnv()` on the interface: `resolveAgentRunEnv` used to shape the agent's
environment from `process.env`, and handing a containerised agent the orchestrator's `PATH` and
`HOME` describes a machine it is not running on.

### The mount set: this Task's worktree and this Task's own clone

> **Amended 2026-09-03 (issue #96, round two), superseding the section as first accepted.** The
> original decision was that the container got `SOLOW_WORKTREE_ROOT`, `SOLOW_REPO_CACHE_ROOT` and
> any `local_path` Repository whole and read-write, and that the sharing which followed was a
> stated limitation. A review on live containers showed the limitation was materially larger than
> those words admitted, so the decision changed rather than the wording. Both are kept below,
> because the half of the original reasoning that is about `git worktree` is still why the design
> looks the way it does.

#### Originally decided, and superseded: mount the roots, and state the sharing

The container does not get one mount per worktree. It gets `SOLOW_WORKTREE_ROOT`,
`SOLOW_REPO_CACHE_ROOT` and any `local_path` Repository the Task is bound to — whole, read-write,
at their host paths.

This is forced by the same fact (2), one layer down. A worktree's `.git` is a file, not a
directory, and it points back into `<parent>/.git/worktrees/<name>`; `manager.ts` also runs
`git -C <repoPath> worktree prune` and `git -C <repoPath> worktree add` against the parent for
every provision. A container that mounted only its own worktree would hold a directory that is not
a git repository at all. Mounting the roots rather than enumerating directories is additionally
required by *when* the mount set has to be known: the container is described before
`prepare-repository` and `provision-worktree` have run, and both of those run **through** the
executor being described. Deriving the clone's cache path here would put a second copy of
`resolveRepoPath`'s arithmetic beside the original, and two derivations of one path is exactly how
a container ends up mounting a directory the clone did not land in.

So the isolation this driver buys is stated precisely, not generously. **Process, kernel-resource
and image isolation are complete**: an agent gets the profile's image, its own pid namespace,
`--pids-limit`, `no-new-privileges`, and the `--cpus` / `--memory` ceilings the profile asked for,
enforced by the kernel and refused up front by the preflight if this kernel cannot enforce them.
**Filesystem isolation from the rest of the host is complete** — nothing outside the two roots and
the named Repositories is visible. **Filesystem isolation between two Tasks on the same machine is
not**: they share the parent repository read-write, and, because the mount is the root rather than
the directory, each can see the other's worktree. Concurrency on the parent is git's ordinary
worktree locking, which is what the local Executor has always relied on. F07 records this as a
stated limitation rather than leaving the word "isolated" to imply more than holds.

#### What refuted it

"Each can see the other's worktree" understated what sharing a parent repository is. From Task A's
container, on live containers, a reviewer read Task B's committed **and** merely staged file
contents out of the shared parent, rewrote the branch B was about to be reviewed on, deregistered
B's worktree, and read B's worktree path out of `.git/worktrees`. Mounting the *roots* widened it
again: one deployment has one worktree root, so every container held every other Task's worktree
in the deployment — across Workspaces — and the `.env` that issue #52 seeds into one was readable
from another.

None of that is a Docker defect, and none of it is fixable in the mount set: a worktree needs its
parent mounted, so a Task that shares a parent shares everything in it. Accepting it meant a
container Executor whose one selling point over the local one — *this agent cannot reach that
work* — was false between exactly the Tasks most likely to run together, two Tasks on one
Repository. That is not a limitation worth documenting; it is the feature not working.

#### Decided instead: a repository of the Task's own, and a mount set derived from it

A Task that runs anywhere but the orchestrator's own host gets its **own clone** of every
Repository it is attached to, and the container is given nothing else.

- `ownClone` in `task-run.ts` is `executorProfile.config.kind !== "local"` — a property of where
  the Task runs, not a Docker flag, so #97 and #107 inherit it.
- `executorBindPaths` returns one pair per attachment: `worktreePath(worktreeRoot, taskId,
  attachmentId)` and `taskRepositoryPath(repoCacheRoot, taskId, attachmentId)`. Neither root is
  in it, and `repositoryHostPath` — the shared cache clone, or the `local_path` Repository itself
  — is reached from *this* expression only on its `local` branch, which is the claim that
  matters: `executorBindPaths` is the one place that decides what a container is given.
  `repositoryHostPath` is not unreachable in the file. `upstreamPathFor` (`task-run.ts:994`)
  calls it unconditionally and has to, because it answers a different question — where the
  Repository the *deployment* holds is, which is exactly what a Task with its own clone does not
  have. The setup-file seeding copies a git-ignored `.env` that exists only in the Owner's own
  working tree, and the approved branch has to be published back into that same Repository or
  F08's result branch names a directory `cleanupWorktree` deletes. Both go through `repoAdmin` —
  the host executor whenever `ownClone` holds — so the shared path is named on the host and never
  reaches the mount set.
- The driver's jailed `fs` is rooted at `worktreePath(root, taskId)`, this Task's directory rather
  than the root that holds every Task's. A tighter jail than the local driver's, which is still
  the worktree root.
- The clone is built with `git init` plus `git fetch`, never `git clone`: a clone from a local
  path hardlinks the object files, and the container owns them read-write — verified, a hardlinked
  object rewritten from inside a container changed the source repository's copy. A fetch transfers
  a pack, so no inode is shared. No `origin` is configured — which does not keep the shared
  repository's *name* out of the container: `git fetch <path>` writes `branch '<name>' of
  <absolute host path>` into the clone's own `.git/FETCH_HEAD`, and the clone is mounted. Naming
  is not reaching. That path is in no mount `executorBindPaths` derives, and a `git fetch` of the
  path read back out of `FETCH_HEAD` fails from inside the container with "does not appear to be
  a git repository" — both verified on Docker 29.7.2. The residual risk is that this holds for
  the *derived* mount set only: a profile `mounts` entry naming the repository cache root passes
  `guardMountSource`, whose allow-list includes the deployment's own roots, and would make the
  path in `FETCH_HEAD` a live one again. Nothing refuses that, and an operator who writes it has
  re-opened what this section closed.
- The operations that genuinely need the shared repository move **off** the Task's executor.
  `repoAdmin` in `task-run.ts` is a second executor built from `HOST_EXECUTOR_CONFIG` whenever
  `ownClone` holds — through the same `executorFor` factory, so this file still does not reach for
  the host itself — and the clone, `git worktree add`, the setup-file seeding, the publish and the
  removal run there. That split is what keeps the shared repository out of the mount set; without
  it the container would need it mounted to do its own bookkeeping. Everything about the Task's
  *content* — the agent, commit, discard, status, diff — stays on the Task's executor, so the
  driver gate stays honest.
- The approved branch is moved back afterwards. `WorktreeOps.publish` → `publishWorktreeBranch`
  fetches `+refs/heads/<branch>` out of the Task's clone into the Repository the Owner holds,
  before cleanup and on the host executor; it returns immediately when the two paths are the same,
  which is every local run. Without it the result branch F08 promises would name a directory
  `cleanupWorktree` deletes with the clone.
- A `local` Task keeps the shared parent, deliberately. Two local Tasks already run as one uid on
  one filesystem, so a private clone there would cost a copy of the repository per Task to buy an
  isolation the host does not provide anyway.

What survives from the original reasoning, unchanged: the parent has to be mounted at all, it has
to be at the identical absolute path, and the mount set has to be known before
`prepare-repository` and `provision-worktree` have run — which is why `executorBindPaths` derives
both paths from the ids with the very functions the provisioning calls, rather than discovering
them or re-deriving `resolveRepoPath`'s arithmetic. Only *which* repository is the parent changed.

One sentence of the original does not survive, and it is left standing above rather than quietly
removed: deriving the clone's cache path in the mount set was ruled out there because it would put
a second copy of `resolveRepoPath`'s arithmetic beside the original. That objection was right about
copying and wrong about deriving. `executorBindPaths` calls the same `worktreePath` and
`taskRepositoryPath` that `provisionWorktree` and `ensureTaskClone` call, so there is one
derivation rather than two, and the mount and the directory git writes into cannot disagree.

So the isolation this driver buys, restated precisely. **Process, kernel-resource and image
isolation are complete**: the profile's image, its own pid namespace, `--pids-limit`,
`no-new-privileges`, and the `--cpus` / `--memory` ceilings the profile asked for, enforced by the
kernel and refused up front by the preflight if this kernel cannot enforce them. **Filesystem
isolation from the rest of the host is complete** — nothing outside this Task's own directories
and the Profile's declared `mounts` is visible, each source having passed `guardMountSource`.
**Filesystem isolation between two Tasks on one machine now holds at the mount set**: no path
either container is given is, or contains, a path the other container is given, in either
direction. What is still shared whatever the kind is the machine and its kernel, the Docker daemon
the driver talks to, and any directory an operator names in two Profiles' `mounts`.

That last property is pinned rather than asserted: `task-run.test.ts` — *"gives a Task no path
belonging to another Task under the same roots (AC-2)"* — runs two Tasks attached to the **same**
two Repositories and compares the real mount sets in both directions, and
`scripts/smoke-docker-executor.sh` asks the same question of a live daemon with two containers.

## Considered options

- **A socket client (`dockerode`, or fetch over the unix socket).** Typed responses, real streams,
  no text parsing, and a genuine cancellation channel for a pull. Rejected because it puts a second
  module on the host boundary the whole interface exists to keep singular, adds a dependency, and
  reimplements context resolution, TLS and registry auth that the CLI already does — and because it
  would make the driver's tests need a daemon or an HTTP mock where they now need neither. Worth
  revisiting if the text parsing ever becomes a source of real defects rather than one caught
  format string.

- **A container per command, plus a long-lived one for the agent.** Rejected: the long-lived
  container is needed either way, so this is strictly more machinery, two lifecycles for the reaper
  to understand, and a per-command image start-up on every `git status`.

- **Translated mounts (`/workspace` inside, the real path outside).** The conventional container
  layout, and it cannot work here without rewriting absolute paths in arbitrary argv and inside
  git's own metadata. Rejected as undecidable, not as inconvenient.

- **One mount per worktree.** Tighter, and it does not survive contact with `git worktree`: the
  `.git` file points at the parent, and the mount set has to be fixed before the worktrees exist.

- **(2026-09-03 amendment) Keeping the shared parent and narrowing the mounts instead.** The
  obvious first answer once the sharing was reproduced, and it cannot work: a worktree's `.git`
  names its parent's `.git/worktrees/`, so any mount set that leaves `git worktree` working
  contains the parent, and the parent *is* the other Task's objects, refs and registrations. The
  lever was never the mount set — it was which repository the worktree is added onto. Narrowing
  the mounts is still done (one pair per attachment, no roots), but as the second half of the fix,
  not the whole of it.

- **(2026-09-03 amendment) A private clone for local Tasks too**, for one rule instead of two.
  Rejected: it would copy the repository per Task to buy nothing a local run does not already
  give away — one uid, one filesystem, one process table — and would make `publish` load-bearing
  on the path where it is currently a no-op.

- **`-e` / `--env-file` for the environment.** Rejected on Principle IV (host-visible argv,
  `docker inspect` for the life of the container) and on semantics (both merge; `SpawnOpts` replaces).

- **`--rm`, with disposal in a durable step.** Rejected twice over: an auto-removing container
  leaves the reaper nothing to find and an operator no evidence after a crash, and a memoized
  `step.run("executor-dispose")` is replayed as already-done on the retry that just rebuilt the
  container.

- **A user-defined network per Task.** Rejected: it buys isolation the product does not currently
  claim, and costs the reaper a second resource class to enumerate and clean up. The profile may
  still name a network.

## Consequences

- Positive: `scripts/audit-executor-boundary.ts` still passes unchanged, and its claim is still
  literally true with two drivers in the tree. #97 and #107 inherit the same shape.
- Positive: the driver's tests need no Docker daemon — a fake host `Executor` recording argv proves
  the run line, the absence of any credential in it, the transport-failure rule, the kill
  escalation and the jail. A shared contract suite (`executor/contract.ts`) runs the same
  assertions against every driver, which is what keeps two independently written implementations
  of the same interface from drifting in the half neither's own tests look at.
- Positive: a Task that cannot get its container fails **before** anything is cloned, with the
  daemon's own words on the board.
- Negative: **the driver parses text**, and a format string can be wrong without failing to
  compile. `.CPUCfsQuota` is the recorded instance.
- Negative: **the `docker` CLI must be on the orchestrator's `PATH`**, and its version now matters.
  `SOLOW_DOCKER_BIN` exists so a wrapper is a deployment setting rather than a fork.
- Negative: **teardown is best-effort plus a sweep, never a guarantee at the moment of finish.** A
  killed orchestrator leaves a container holding its memory and CPU reservation until the next
  sweep decides it is orphaned, and that decision deliberately errs towards leaving it alone.
- ~~Negative: **isolation between Tasks on one machine is partial**, as stated above. It is a
  limitation of the worktree model, not of the container, and it would not be fixed by any mount
  layout that keeps `git worktree` working.~~ **Amended 2026-09-03:** the observation was right
  and the resignation was not. No mount layout does fix it — so the fix was not a mount layout: a
  non-local Task is given a repository of its own (`ownClone`), and two Tasks on one Repository
  now share no path in either direction. What that costs is the two bullets below.
- Negative: **a non-local Task copies each attached Repository.** One directory per attachment
  under `<repo cache>/tasks/`, populated by a fetch rather than a hardlinking clone, and removed
  by `cleanupWorktree` with the worktree — so the time cost is one pack transfer per attachment
  per Task, and the disk cost is the Tasks currently running plus any whose cleanup never ran.
  Nothing sweeps an abandoned one: the reconciliation sweep reaps containers, not directories.
- Negative: **a containerised run drives two executors**, its own and a host one for the
  bookkeeping on the shared repository (`repoAdmin`). Whoever adds a repository-level operation
  has to decide which of the two it belongs on, and putting a shared-repository operation on the
  Task's executor would put the shared repository back in the mount set.
- Negative: the image must carry a POSIX userland (`sh`, `env`, `cat`, `find`, `mkdir`, `cp`,
  `test`, `df`, `base64`, `git`). Distroless and scratch images are unsupported by construction,
  and say so at preflight rather than at the first `fs` call.
- Neutral: `forward()` returns the container's own IP, which is reachable only from a host running
  a local daemon. It refuses rather than returning an unreachable URL when `DOCKER_HOST` is remote.
  Nothing consumes it yet (#35).

## Out of scope

- **SSH (#97) and Kubernetes/cloud (#107) drivers.** They are configurable ahead of their drivers
  and fail at the `hasDriver` gate; this record fixes the shape they will follow, not their
  content.
- **Registry credentials in the Executor Profile.** Today a private image authenticates through the
  orchestrator's own `~/.docker/config.json`. A per-profile credential is a decision of its own,
  with a `secret` row behind it.
- **Published ports and preview URLs.** Docker fixes port publishing at container creation while
  `forward()` is handed a port at call time; reconciling those is #35's problem.
- **Rootless and remote daemons.** Both work through the same CLI today and neither is tested here.
