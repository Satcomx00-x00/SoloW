# Walkthrough: the Run Engine and the Review Gate

**Status:** Draft · **Owner:** Engineering · **Last reviewed:** 2026-10-09

This is the one document under `docs/` written for someone about to change the code. It follows
one Task from the click that starts it to the branch an approval delivers, names the file and
function behind each step, and then lists the rules a change must not break, where their tests
live, and how to run those tests on a development machine without taking it down. It ends with
three small changes worth making in a first week.

It names files and functions, never line numbers, which go stale too fast to be worth printing.
When a name here no longer matches the code, the code is right and this page needs a fix.

## Before you start

Read these first. This page links to them rather than repeating them:

- The [Glossary](../glossary.md), for Task, Session, Harness, Harness Profile, Workflow Step and
  Gate. In the code, a *run* is one invocation of the durable `task-run` function. That is
  narrower than the Glossary's "Run".
- [0004 — Durable orchestration engine](../decisions/0004-durable-orchestration-engine.md) and
  [0030 — A review gate is a database state](../decisions/0030-review-gate-is-a-database-state.md).
  0030 describes the shape everything below follows: a run ends when it opens a gate, and a
  decision starts the next run.
- [Building Blocks](../architecture/05-building-blocks.md), for the containers this page moves
  between.

The repository's `CLAUDE.md` points to `specs/001-core-program/plan.md` for structure and
commands. That plan is the original design. Its run-engine section no longer matches the code:
it describes a `waitForEvent` gate, step names that have since been replaced, pnpm and vitest,
and paths without `src/`. Use the code and the ADRs, not the plan, for anything in this
walkthrough.

## The parts, and where they live

| Part | What it does | Where |
|---|---|---|
| Task page and board | The buttons that start a Task and decide a gate | `apps/web/src/components/features/task/task-workspace.tsx`, `task-footer.tsx`, `apps/web/src/components/features/board/board.tsx` |
| tRPC routers | The one path into `running`, and the decision | `apps/web/src/server/routers/task.ts` (`startTaskRun`), `apps/web/src/server/routers/review.ts` (`decide`) |
| Web DAL | Conditional writes on the Task row | `apps/web/src/server/dal/task.ts` (`claimTaskRun`, `claimTaskState`) |
| Orchestrator client | Hands events to the orchestrator | `apps/web/src/server/orchestrator-client.ts` |
| Concurrency cap | The single rule both apps use to claim a slot | `packages/db/src/task-claim.ts` (`claimTaskRunSlot`) |
| Event intake | `POST /events`, guarded by a bearer secret | `apps/orchestrator/src/inngest/events.ts` (`handleEventPost`) |
| Engine wiring | The function list and the streaming `/api/inngest` handler | `apps/orchestrator/src/inngest/serve.ts`, `client.ts` |
| Run engine | The durable Task lifecycle | `apps/orchestrator/src/inngest/functions/task-run.ts` plus its parts in `task-run/` |
| Workflow rules | Pure rules: does finishing a Step move the cursor, and does it need a person | `packages/core/src/workflow.ts` |
| Workflow transaction | Reads and writes the cursor under a lock | `packages/db/src/workflow-run.ts` (`advanceTaskWorkflow`, `loadTaskWorkflowRun`) |
| Executors | The only way to reach a host: local or Docker | `apps/orchestrator/src/executor/` |
| Harness runners | Start and drive Claude Code, or a harness over ACP | `apps/orchestrator/src/harness/runners.ts`, `claude-code-runner.ts`, `acp-runner.ts` |
| Delivery | Push the approved branch and open or refresh its request | `apps/orchestrator/src/delivery.ts`, `redelivery.ts` |
| Live stream | Pushes harness activity to the browser | `apps/orchestrator/src/ws/hub.ts`, `ws/replay.ts` |
| Sweeps | Find lost runs, stranded gates, idle parks and leaked containers | `apps/orchestrator/src/reconcile.ts`, `executor/reap.ts`, `retention.ts` |

The run engine's parts in `apps/orchestrator/src/inngest/functions/task-run/`:

| File | Holds |
|---|---|
| `types.ts` | The injected dependencies (`TaskRunDeps`), the loop's own state (`LoopState`, `createLoopState`) and the per-Step binding (`RunLeg`) |
| `scope.ts` | `createRunScope`: what every part shares, plus `announce` and `recordTransition` |
| `deps.ts` | `defaultDeps`: the production wiring |
| `prepare.ts` | `resolveEntry` and `prepareWorkspace`: refusals, the executor, repositories and worktrees |
| `brief.ts` | `harnessBrief`: what the harness is told |
| `round.ts` | `runHarnessRound`: one harness process, start to finish |
| `harness-events.ts` | Shaping and redacting what the harness emits |
| `budgets.ts` | `MAX_REVIEW_ROUNDS`, `MAX_AUTO_CONTINUE_ROUNDS`, and the two retries that do not cost the reviewer a round |
| `finish.ts` | `finishRound`: record the work, advance or open the gate |
| `advance.ts` | `reportStepFinished` and `takeAdvance`: moving through a Workflow |
| `decision.ts` | `applyDecision`: the first thing a run started by a decision does |
| `integration.ts` | `integrateApproval`: the only place the engine commits and ships |
| `terminal.ts` | `failRun`, `failRound`, `parkRound`: the ways a run stops short of a gate |

## One Task, end to end

### 1. A person starts the Task

The board card's launch control and the Task page's forward arrow call `trpc.task.launch`. A move
into Running (`task.move`) and Retry (`task.retry`) end up in the same function. Every start goes
through `startTaskRun` in `apps/web/src/server/routers/task.ts`:

1. A Task in `review` is refused with `AwaitingReview`. Only a decision moves a Task on from its
   gate.
2. The move into `running` is checked with `canTransitionTask` from `packages/core/src/task.ts`,
   and a Task with unfinished dependencies is refused by `requireUnblocked`.
3. `claimTaskRun` in `apps/web/src/server/dal/task.ts` takes the row with `claimTaskRunSlot`. The
   write succeeds only if the Task is still in the state it was read in and its Harness Profile
   is under its concurrency cap. See [The concurrency cap](#the-concurrency-cap-is-one-rule-in-one-place).
4. A Session is created and `orchestrator.enqueueTaskRun` sends `task.launch.requested` with
   `{ workspaceId, taskId, sessionId }`. If either step fails, the Task goes back to its old
   state and the Session is closed. That way no row reads `running` with no harness behind it.
5. `orchestrator.announceTask` tells other open boards that the Task changed.

### 2. The event reaches the engine

`emit` in `apps/web/src/server/orchestrator-client.ts` sends `{ name, data }` to the
orchestrator's `/events` route with `Authorization: Bearer` and the value of
`SOLOW_ORCHESTRATOR_SECRET`. In `apps/orchestrator/src/index.ts` the route goes to
`handleEventPost` (`apps/orchestrator/src/inngest/events.ts`), which:

- answers 503 to every request while the secret is unset or breaks the shared rule
  (`readOrchestratorSecret`), so an open `/events` cannot start runs,
- answers 401 to a wrong bearer, compared in constant time,
- checks only the envelope and passes it to `inngest.send`, then answers 202. The payload belongs
  to the run engine's own schema (`launchData` in `task-run.ts`).

The engine is Inngest. The SDK is pinned in `apps/orchestrator/package.json`, and the server is
`inngest start`, a signed, self-hosted server that keeps state in SQLite. It is launched by
`scripts/dev.sh` and `scripts/start.sh`, with keys from `scripts/lib/engine-env.sh`. The engine
calls back into the orchestrator at `/api/inngest`, served by `inngestServeHandler` in
`apps/orchestrator/src/inngest/serve.ts`. That handler streams, because a harness round lasts far
longer than one HTTP request. `INNGEST_FUNCTIONS` in the same file is the one list of functions
the engine knows about.

### 3. The `task-run` function

`taskRun` at the bottom of `task-run.ts` declares:

- the trigger `task.launch.requested`, used both for a launch and for a decision (step 9),
- `retries: TASK_RUN_RETRIES` (two, declared in `prepare.ts`),
- a concurrency limit of one per `event.data.taskId`: the engine's share of "one run per Task",
- `cancelOn` for `task.stop.requested` with the same `taskId`, which force-deleting an Issue uses.
  The engine cancels between steps, never during one.

The body is `runTaskLifecycle(defaultDeps(), args)`. Everything it uses comes in through
`TaskRunDeps`: the database, harness runners, executors, worktree operations, the hub and the
registry. That injection is how `task-run.test.ts` drives the whole lifecycle with a fake harness
and a fake `step`.

### 4. Load, take up the decision, prepare

In order, inside `runTaskLifecycle`:

1. **`load`**: `loadTaskRunContext` reads the Task, its Issue, Harness Profile, Executor Profile and
   Repositories.
2. **`decision-take-up`**: only for a run started by a decision (step 9).
3. **`resolveEntry`** (`prepare.ts`) works out the Workflow Step the run enters on
   (`workflow-resume`, `workflow-agents`) and builds the first `RunLeg`. It refuses, without
   cloning anything, a Workflow that is too long, a Step whose Harness Profile is gone, or an
   executor kind this build has no driver for. It then builds the Task's executor with
   `deps.executorFor`, plus a host executor (`repoAdmin`) for bookkeeping when the Task has a
   clone of its own.
4. **`prepareWorkspace`** (`prepare.ts`) runs `executor-preflight` and fails the Task if the host
   cannot be provided or no runner can drive the protocol. It then clones or locates each
   Repository (`prepare-repository`), creates worktrees the harness will not create itself
   (`provision-worktree`), and copies setup files into secondary worktrees
   (`seed-secondary-<attachment id>`).

A failure on any of these paths goes through `failRun` in `terminal.ts`. The state write and its
transition record are in the same durable step, so a retry cannot record the transition twice.

### 5. A round: one harness process

The loop in `runTaskLifecycle` counts `round` from 0 and calls `runHarnessRound` (`round.ts`) inside
`step.run("agent-run-<round>")`. A round:

- builds the harness environment: the executor's `baseEnv()`, a separate, app-owned home
  (`resolveHarnessConfigEnv`), the Profile's Harness Config, and the credential last, through
  `prepareHarnessEnv` (`apps/orchestrator/src/billing/guard.ts`),
- writes the brief with `harnessBrief` (`brief.ts`). On a resumed conversation it sends a short
  continuation instruction instead of the full brief,
- starts the harness with `loop.runner.start` and registers it with the harness registry so the
  Task page can send input and answer widgets,
- sends every harness event through `emit`, which redacts it (`redactPayload`), publishes it to the
  Task's live channel and appends it to the session log, in the same order,
- captures a diff at each turn boundary, records usage, and watches for the harness's
  `task_complete` declaration,
- returns `completed`, `failed`, `resume-lost` or `abandoned` (the Session was deleted while the
  harness ran).

Back in the loop, `compact-<round>` summarises a long log without rewriting it, and
`record-worktree-<round>` records the worktree the harness used. The result then decides the next
step:

| Round result | Handled by | What happens |
|---|---|---|
| `resume-lost` | `restartLostConversation` (`budgets.ts`) | One retry from the full brief. A second loss fails the run |
| `failed`, class `park` (quota) | `parkRound` (`terminal.ts`) | `park-<n>` sets `parked`, `park-wait-<n>` sleeps `PARK_SLEEP_MS` (five hours), `park-woke-<n>` checks the row is still `parked`, then `park-claim-<n>-<attempt>` takes a slot again |
| `failed`, any other class | `failRound` (`terminal.ts`) | `fail-<n>` sets `failed` and records the reason |
| cut short by the harness's budget | `continueTruncated` (`budgets.ts`) | `auto-continue-<n>`: carries on the conversation, up to `MAX_AUTO_CONTINUE_ROUNDS` |
| `completed` | `finishRound` (`finish.ts`) | Next section |

### 6. Finishing a round, and opening the gate

`finishRound` first runs `to-review-<round>`. It records the harness's declaration
(`changes_ready`, `nothing_to_do` or `blocked`), sets the Session to `awaiting_review`, and writes
one `diff` event per worktree. Then:

- **Under a Workflow**, a Step that advances on the harness's own signal reports itself finished
  (`reportStepFinished` in `advance.ts`). That calls `advanceTaskWorkflow` in
  `packages/db/src/workflow-run.ts`, which calls the pure rule `advanceWorkflowStep` in
  `packages/core/src/workflow.ts` inside a transaction. If the cursor moves, `takeAdvance` binds
  the next Step's harness and the loop carries on in the same worktree. Otherwise (the Step
  advances on review, or the rule held it), `open-gate-<round>` sets the Task to `review`. The
  exception is a harness that declared `blocked`: that run has nothing for a person to approve.
- **On no Workflow**, the run does not move the Task. It stays `running` with its completion
  recorded, and the person opens the gate with the Task's "Open review" control
  (`task.submitForReview`, gated by `canOpenReview` in `packages/core/src/task.ts`).

Either way the run returns `awaiting_review` and **ends**. The `finally` in `runTaskLifecycle`
disposes of the executor. That is a plain call, not a durable step, so a retry never replays a
teardown of a container it has just rebuilt.

### 7. The gate is a row

Nothing in the engine waits at a gate. The gate is the Task row in `review` and the Session in
`awaiting_review`. It has no timeout, survives any restart, and holds no executor.
[ADR 0030](../decisions/0030-review-gate-is-a-database-state.md) explains why. In short, a wait
inside the engine was lost whenever the engine restarted.

### 8. A person decides

The Task page footer (`task-footer.tsx`) calls `runDecision` in `task-workspace.tsx`, which calls
`trpc.review.decide`. The procedure in `apps/web/src/server/routers/review.ts`:

1. refuses anything not in `review` (`NotInReview`), and refuses `request_changes` on a blocked
   Task,
2. with no orchestrator configured, applies only `reject`. That decision changes state only, so
   it needs no run. The others are refused,
3. takes the gate in one conditional write, `review → running`. If the decision will run a harness
   (`request_changes`, or an approval under a Workflow), it uses `claimTaskRun`, so the decision
   needs a cap slot like any start. Otherwise it uses `claimTaskState`, so a reject or a plain
   approval is never held up by the cap. A second click or tab loses this write and is told,
4. sets the Session `active`, records the `review` row, and calls `orchestrator.applyReview`. That
   sends the same `task.launch.requested` event with a `review: { id, decision, feedback }` field.
   If the send fails, the row is forgotten (`forgetReview`) and the gate is put back as it was.

### 9. The run a decision starts

This is the same function with the same entry. After `load`, `decision-take-up` runs
`takeUpReviewDecision` (`apps/orchestrator/src/data.ts`), which sets `review.applied_at` only
where it is still null. A redelivered event finds the decision spent and returns
`decision_already_applied` without touching the Task. Preparation then runs again: preflight,
repositories, worktrees. This repeated setup is the price 0030 accepts. Then `applyDecision`
(`decision.ts`) runs before any round:

| Decision | Steps | Result |
|---|---|---|
| `request_changes` | `decision-blockers`, `decision-resume` | Feedback becomes the next round's brief, and the loop runs |
| `reject` | `decision-worktree`, `decision-reject`, `decision-reject-handoff` (Workflow) | Changes discarded, Task back to `ready`. The rejected summary is not handed to the next Step |
| `approve` with decisions settled at the gate | `decision-worktree`, `decision-apply` | One more round on the same Step, so the harness applies the answers before anything moves |
| `approve` under a Workflow, not the last Step | `decision-worktree`, `decision-advance` | `takeAdvance` binds the next Step, and the loop runs |
| `approve` that ends the Task | `decision-worktree`, `decision-advance` (Workflow only), `decision-approve` | Integration (next section) |

### 10. Integration and delivery

`integrateApproval` (`integration.ts`) runs as the single step `decision-approve`. It is the only
path in the engine that integrates, and it is reachable only from an `approve`. For each worktree
the gate showed, it commits (when there are changes), publishes the branch into the Repository the
deployment holds (`repoAdmin.publish`), and records it as the attachment's result branch. It then
ships it with `shipAttachment` in `apps/orchestrator/src/delivery.ts`: push, then open or refresh
the pull request, for a Repository imported through an Integration. Each worktree is integrated in
its own `try`, so a retry does not commit twice to branches that already took. The outcomes:

- everything landed: the Task is `done`, and the Session is `resumable` for the retention window,
- a commit failed: `failed` with `PARTIAL_INTEGRATION_REASON`, and a notice names what landed,
- committed but not shipped: `failed` with `DELIVERY_FAILED_REASON`. Ship again (`task.redeliver`)
  sends `task.redeliver.requested` to `taskRedeliver`
  (`apps/orchestrator/src/inngest/functions/task-redeliver.ts`), which calls `redeliverTask` in
  `apps/orchestrator/src/redelivery.ts` and pushes without running a harness. Keep local
  (`keepUndeliveredLocal` in the web DAL) accepts the local commit as the result.

### 11. The safety nets

`reconcileSweep` in `apps/orchestrator/src/index.ts` runs every minute. It does not apply
decisions or integrate. It finds runs that went missing:

- `reclaimOrphanedRuns` (`reconcile.ts`): a `running` Task that is not in the harness registry and
  has been silent past `RECLAIM_STALE_MS`. It is relaunched, up to `MAX_AUTOMATIC_RECOVERIES`
  times per Session, and filed otherwise. A finished Task on no Workflow, whose Session is `awaiting_review`,
  is skipped,
- `reportStrandedReviews`: a gate with a decision recorded and no run applying it,
- `reportStrandedParks`: a parked run that did not wake,
- then `reapOrphanedContainers` (`apps/orchestrator/src/executor/reap.ts`), which reads the
  verdicts the others wrote.

`retentionSweep` (`apps/orchestrator/src/retention.ts`) removes worktrees and old transcripts
hourly ([0025](../decisions/0025-history-retention.md)).

### The step ids one Task produces

The run engine's tests pin this sequence exactly. It is a Task on no Workflow that runs once,
reaches its gate and is approved (`task-run.test.ts`, "a Task on no Workflow"):

| Run | Step ids |
|---|---|
| Launch | `load` · `executor-preflight` · `prepare-repository` · `agent-run-0` · `compact-0` · `record-worktree-0` · `to-review-0` |
| *(gate: the run has ended, and a person approves)* | |
| Decision | `load` · `decision-take-up` · `executor-preflight` · `prepare-repository` · `decision-worktree` · `decision-approve` |

## Invariants a change must not break

### Step ids are stable

Inngest memoizes each `step.run` and `step.sleepUntil` by its id. After a restart or a retry it
replays the function from the top, returns the stored result for every id it has already seen,
and runs only what is new. So:

- **Do not rename, remove or reorder an existing step id.** A run in flight during the upgrade
  would replay against a journal that does not match. The ids in use when a release goes out
  belong to whatever is in flight at that moment. Since 0030, that means runs in progress
  (launches and decisions) and parked runs: sleeps of up to five hours, and the slot-claim
  retries that follow them. It does not include gates, because a run ends before its gate
  opens.
- **Ids in the loop carry the round**, as `agent-run-<round>`, `to-review-<round>` and
  `park-<round>` do. The round counter grows across Step boundaries and there is no nested Step
  loop. A nested loop would reset the counter, and the next Step would replay the previous Step's
  memoized `agent-run-0` (see `LoopState.leg` in `types.ts`).
- **Anything that decides how many iterations the loop runs is read from a memoized step**, such
  as `stepCount` from `workflow-resume`. A live read could walk a different number of rounds on
  replay and reach ids the journal does not hold.
- **Side effects go inside a step.** A state write and its `recordTransition` share one step. A
  write outside every step runs again on every replay.
- **A new step needs a new, unique id**, with the round in it when it is inside the loop. Add it
  to the pinned sequences deliberately. `task-run.test.ts` asserts them exactly, because an id
  that moved breaks a memo just as an added one does.

Tests: "a Task on no Workflow" (the exact sequences) and "re-walks a memoized journal without
re-running the harness or advancing twice" (a replay with a memo map), both in
`apps/orchestrator/src/inngest/functions/task-run.test.ts`.

### One run per Task

Two runs on one Task share its worktree, Session and conversation, and neither can tell the other
is there. Four layers stop that, and a change has to keep all of them:

1. Every start claims the row from the state it was read in (`startTaskRun` → `claimTaskRun`).
   `review.decide` claims `review → running` in the same way.
2. A Task in `review` cannot be started, only decided (`AwaitingReview`).
3. A decision is applied once (`decision-take-up`).
4. The engine allows one run at a time per `taskId` (`concurrency` on `taskRun`). A run that
   waited its turn finds out from the database that it has nothing left to do.

A parked run that wakes to find its Task moved stands down (`standDown` in `terminal.ts`) and
does not carry on beside the new owner.

Tests: `apps/web/src/server/routers/review.decide.test.ts`, `task.start.test.ts`, and the
`decision_already_applied` case in `task-run.test.ts`.

### The concurrency cap is one rule in one place

A Harness Profile's cap is the main guard against draining a subscription. `claimTaskRunSlot`
(`packages/db/src/task-claim.ts`) is the only implementation. It is a single conditional `UPDATE`
whose `WHERE` holds both the expected state and "running Tasks of this Profile < cap", inside a
`BEGIN IMMEDIATE` transaction. A slot is a Task row reading `running`, not a counter, so every way
out of `running` returns the slot by being that write. A parked Task holds no slot and takes one
back on waking (`claimWokenSlot` in `terminal.ts`). If there is no room it stays parked and retries
with a back-off (`slotRetryDelayMs`).

Do not count running Tasks somewhere else and compare in JavaScript. That gap is how
simultaneous starts all passed the cap before (FINDINGS F5). Tests:
`apps/web/src/server/routers/task.concurrency.test.ts`, which fires N simultaneous starts at a real
SQLite database, and the park-and-wake cases in `task-run.test.ts`.

### Nothing integrates without a recorded human decision

`integrateApproval` is reached only through `applyDecision` with an `approve`. In
`advanceWorkflowStep`, the branch for the last Step ignores the gate setting altogether, so a
Workflow of all-`auto` Steps still cannot complete without an approval. An approval is spent by the
move it caused (`consumedApproval`), so one click cannot open every gate that remains. Tests:
`packages/core/src/workflow.test.ts`, `packages/db/src/workflow-run.test.ts`, and the "approve
ships (A1)" and Workflow cases in `task-run.test.ts`.

### The executor boundary

Only `apps/orchestrator/src/executor/local.ts` may touch the host directly: spawning processes,
reading and writing files, the Bun shell. Only `apps/orchestrator/src/executor/` may talk to
Docker. Everything else goes through the `Executor` interface (`executor/types.ts`), which is why
the lifecycle calls `worktreeOps.commit(...)` and never calls git. `make audit-executor-boundary`
(`scripts/audit-executor-boundary.ts`) enforces this, and `scripts/audit-executor-boundary.test.ts`
tests the audit itself. Wrap new host access in the executor. Do not add an exemption to the
audit.

### Secrets stay out of the agent's reach

A harness gets the one credential its run needs, and nothing that would unlock the rest:

- the local executor's `baseEnv()` drops SoloW's own secrets (`isOrchestratorSecret`: any
  `SOLOW_`, `INNGEST_` or `BETTER_AUTH_` variable that names a key, token, password or the
  database). A container never inherits the orchestrator's environment, and its mounts refuse the
  state directories (`protectedPaths`),
- `prepareHarnessEnv` decrypts the credential and applies it last, by authentication mode, so a
  subscription run cannot carry the metered variable and an Executor Profile cannot override the
  credential,
- every event the harness emits is redacted against that run's own secrets (`secretNeedles`,
  `redactPayload`) before it is published or stored,
- step results are stored in the engine's own database. `load` stores only ciphertext there, and a
  Step's credential is read inside the round that uses it (see the comment at the top of
  `runHarnessRound`). Never return a decrypted secret from a `step.run`.

Tests: `apps/orchestrator/src/executor/local.test.ts`, `executor/docker.test.ts`,
`billing/guard.test.ts`, `packages/core/src/billing.test.ts`, and "redacts a credential the
harness printed" in `task-run.test.ts`.

## Running the tests here

[CONVENTIONS](../CONVENTIONS.md#contribution-and-release-rules) sets the rule: main is always
green, and a red main is fixed or reverted before anything else merges.

- **One file or one area.** For packages and the orchestrator, `bun test <file>` from the package
  directory, with `-t "<describe name>"` to narrow it. For example, `bun test
  src/inngest/functions/task-run.test.ts -t "a Task on no Workflow"` in `apps/orchestrator`.
- **The web app's tests, never as one process.** A single `bun test` over all of `apps/web` has
  been killed for running out of memory. One file is fine (`bun test
  src/server/routers/review.decide.test.ts` in `apps/web`). For more than that, use the batches:
  `bun run scripts/test-batches.ts apps/web --only src/server/routers`, with `--list` to see the
  plan, or `make test-web` for all of them. `task-workspace.test.tsx` and
  `harness-profiles-section.test.tsx` always run alone (`ISOLATED` in `scripts/test-batches.ts`).
- **Everything, as CI runs it.** `make test` runs every package through Turborepo (the web app
  through the batches) and then `bun test scripts`.
- **The loop's building blocks without a stack.** `make smoke` (`scripts/smoke.ts`) loads a Task,
  provisions and commits a worktree, and streams from a fake harness, against an in-memory
  database and a temporary git repository. It does not run the engine. `task-run.test.ts` is
  where the whole lifecycle is driven.
- **The control check.** `make control-check` walks the product's main line in a browser: a
  Workflow drawn on the canvas, a Task launched through it, approval onto a branch, cleanup. The
  harness is the fixture harness and everything else is real. It is slow
  (`.github/workflows/verify.yml` puts it at 8 to 25 minutes) and must run in the foreground. It
  boots its own servers on their own ports and build directory, so it can run beside a
  development stack. CI runs it on every push to main, and a red result blocks the release. Run it
  before you merge a change that touches the loop. `CONTROL_SPEC=e2e/control/<name>.spec.ts` runs
  one spec.
- **Before a commit.** The hooks in `.pre-commit-config.yaml` run biome, gitleaks and the
  commit-message check on commit, and the typecheck on push. Install them once per clone with
  `bun run hooks:install`.

## Three safe first changes

### 1. Reword what the Session log says about a Workflow advance

`describeWorkflowDecision` in `packages/core/src/workflow.ts` turns a `workflow_decision` event
into the line a person reads in the terminal pane. It is pure: no step ids, no state and no
database. The catch is that the sentence is asserted in three packages. Search for it in
`apps`, `packages` and `e2e` before you change it. "Advanced to" appears in
`packages/core/src/workflow.test.ts`, `apps/orchestrator/src/ws/replay.test.ts` and
`apps/orchestrator/src/inngest/functions/task-run.test.ts`. Run those three files.

### 2. Leave a note when a redelivered decision is dropped

When `decision-take-up` loses, `runTaskLifecycle` returns `decision_already_applied` and leaves
no trace in the Session. Adding a notice there is a contained change to the run engine:

- the write goes inside a new `step.run` with a new id (for example
  `decision-already-applied`). Do not reuse an existing id,
- it runs only on the losing duplicate's path, so the pinned sequences in "a Task on no Workflow"
  should not change. If they do, the step is in the wrong place,
- extend the existing `decision_already_applied` test in `task-run.test.ts` to assert the notice,
  then run that whole file. The change touches the run engine, so run `make control-check` before
  it merges.

### 3. Pin down what a finished Task on no Workflow does to the cap

A Task on no Workflow whose harness has finished stays `running` until someone opens its review
(step 6), and `claimTaskRunSlot` counts `running` rows. As written, then, that Task holds a slot
while it waits for a person. Add a case to
`apps/web/src/server/routers/task.concurrency.test.ts` that pins down today's behaviour, and name
it for the rule it states. Do not commit a failing test to show that the rule is wrong: main stays
green. If the rule looks wrong, raise it as a product question and change the behaviour in a
separate change. Run the file on its own, then
`bun run scripts/test-batches.ts apps/web --only src/server/routers`.
