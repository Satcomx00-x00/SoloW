# F03 — Visual Workflow Designer & Monitor

**Status:** Draft · **Owner:** Product · **Maturity:** Core / Edge · **Last reviewed:** 2026-08-17

## Summary

A Workflow is a repeatable, multi-step process that chains Agents and human decisions
together. SoloW presents Workflows as a **visual node graph**: users design a
Workflow by arranging and connecting Steps on a canvas, and watch a live Run's progress
overlaid on that same graph. This makes complex, multi-agent processes understandable and
steerable without reading logs.

## Jobs served

- **J3 — Design a repeatable process.**
- **J4 — Watch a process unfold.**
- **J8 — Resume and recover.**

## User stories

- As a Team Lead, I want to design a process where one agent plans, another implements, and
  a third reviews, so my team runs it the same way every time.
- As a user, I want to see, as a graph, where a running Workflow currently is, so I
  understand its state instantly.
- As a Reviewer, I want a Workflow to pause at a defined point for my approval, so nothing
  proceeds without a human decision.
- As a user, I want a Workflow that was interrupted to resume from where it stopped, so I do
  not repeat completed steps or waste quota.

## Functional requirements

### Designing
- **FR-1** A user can create a Workflow as a graph of Steps on a visual canvas, adding
  Steps as nodes and connecting them with directed edges that represent transitions.
- **FR-2** Step types include at minimum: an **Agent Step** (an Agent performs an action),
  a **Gate** (waits for a human decision), a **Condition** (branches on a rule), and a
  **Fork/Join** (runs branches in parallel and recombines them).
- **FR-3** Each Agent Step references an Agent Profile and the instruction or role it plays.
- **FR-4** A user can arrange, connect, disconnect, and delete Steps directly on the canvas,
  and the canvas supports panning, zooming, and readable layout of large graphs.
- **FR-5** The designer prevents invalid graphs (for example, a Join without a matching
  Fork, or an unreachable Step) and explains why.
- **FR-6** A user can save a Workflow, version it, and reuse it across Tasks and Issues.
- **FR-7** A user can import and export a Workflow as a shareable definition.

### Running & monitoring
- **FR-8** A Task can execute a Workflow; the Workflow's Steps then drive the Task's
  progress.
- **FR-9** A Run's live status is overlaid on the Workflow graph: each Step shows whether it
  is pending, running, waiting at a Gate, completed, failed, or skipped.
- **FR-10** When a Run reaches a Gate, it pauses and requests the required human decision;
  the Run continues only after the decision is recorded.
- **FR-11** A user can inspect any Step of a Run to see its Session, Conversation, and any
  produced Diff.
- **FR-12** A user can cancel a Run, and can retry a failed Step.
- **FR-13** An interrupted Run resumes from its last completed Step rather than restarting
  (see [NFR-1 in Product Requirements](../product/03-product-requirements.md)).

## Non-functional requirements

- **NFR-1** The live graph reflects Run progress in near real time.
- **NFR-2** Large Workflows (many Steps and branches) remain legible and navigable.
- **NFR-3** A Run's progress and decisions are durably recorded so the Run can resume after
  an interruption and its history can be reconstructed.

## States & rules

- Run states and transitions are defined in [Domain Model](../product/04-domain-model.md).
- A Gate blocks all downstream Steps until resolved; parallel branches not downstream of the
  Gate may continue.
- A Condition evaluates a defined rule and selects exactly one outgoing branch.
- Editing a Workflow bumps its version, and a Task records the version it attached at, so an
  edit underneath a live Run is **detectable**. It is not immutable for that Run: the run loop
  keeps reading the Step list it resolved when it started, and `workflow.acknowledgeDrift`
  records that a person saw the edit rather than pinning the Run to a snapshot. Immutability
  needs copy-on-write versioning, which has no producer yet — see *What ships in v1*.

## Edge cases & failure handling

- If a Step fails, the Run pauses at that Step and surfaces the reason; the user can retry
  the Step, skip it (if allowed), or cancel the Run.
- If a Gate is never resolved, the Run remains paused and is clearly shown as waiting on a
  human, and can be reassigned or cancelled.
- If an Agent Step exhausts a subscription quota, the Step parks and the Run waits, matching
  Task Parked behaviour in [F06](./F06-authentication-billing.md).

## Out of scope

- The internal engine that guarantees durability and resumption (an architecture concern;
  see [Decision 0004](../decisions/0004-durable-orchestration-engine.md)).
- The specific visual styling of the canvas (owned by Design).

## What ships in v1 (issue #5)

The model and its seam ship; the canvas does not. Concretely:

- **Designing is an ordered Step list, not a node graph.** `workflow` + `workflow_step` tables,
  Workspace-scoped (Principle V), edited at `/workflows`: a Step Card per row with an Agent
  Profile select, a prompt template, a gate, an advance rule, and Move up / Move down. FR-1 and
  FR-4 (the canvas, panning, zooming) and [Decision 0007](../decisions/0007-reactflow-workflow-visualisation.md)
  move to Later — the pipeline the product needs first is linear, and a graph editor for a linear
  pipeline is a layout engine to maintain rather than an affordance anyone uses.
- **Step order is a lexicographic rank string**, not a position. Inserting a Step in the middle
  writes exactly one row and renumbers nothing; a reorder names the two Steps the moved one lands
  between, and is refused as stale if those two are no longer adjacent.
- **Every Step names an Agent Profile** from the catalog of [F05](./F05-agent-executor-profiles.md)
  (issue #10). There is no second way of naming an agent, which is what makes "a single Task uses
  different agents across Steps" a difference between two rows.
- **Gates.** A Step's gate is `human`, `auto`, or `auto-unless-changes`; its advance rule is
  `agent-signal` or `review`. A gate decides whether an *intermediate* Step waits for a person.
- **The human decision before integration is unconditional, and it is an approval.** The last Step
  of a Workflow reports `completed` only once an `approve` review is recorded for the Task,
  whatever every Step's gate says; the gate value is not consulted on that branch at all
  (Principle I, FR-10). `reject` and `request_changes` are decisions *not* to integrate, and open
  nothing. The newest decision is the one that counts, so an approval that has since been
  withdrawn stops releasing gates.
- **An approval releases one gate, not the pipeline behind it.** A Task records which `review` row
  it spent (`task.workflow_decision_id`), so approving the plan does not silently authorise the
  implementation and the final integration. A Workflow of three `human` Steps costs three
  decisions; a Workflow of `auto` Steps spends nothing until the last one, which costs one.
- **`producedChanges` is corroborated, not believed.** The `auto-unless-changes` gate exists to
  catch a Step that wrote something, and the party reporting the Step finished is the party the
  gate is for. The claim is OR-ed with the server's own record — a `diff` event in the Session log
  naming at least one file — so it can only ever close a gate, never open one.
- **The cursor is durable, and advancing it is replay-safe.** A Task carries `workflow_step_id`,
  written in the same transaction as the decision that moved it, so an interrupted run resumes on
  the Step it was on (FR-13, Principle III). A cursor whose Step has been deleted is an error,
  never a silent restart at Step one. `workflow.advanceTask` names the Step the caller believes it
  is finishing, so a redelivered call from a durable step that re-ran is refused with
  `WORKFLOW_STALE_CURSOR` rather than skipping a Step.
- **A Step's handoff survives a closed gate.** The summary a Step reports is held in
  `task.workflow_pending_handoff` until the cursor actually moves, because the caller that replays
  the signal once a human has decided no longer has the agent's words.
- **Attaching and detaching are symmetric.** Both are refused once the Task has left
  `backlog`/`ready`; attaching is refused once a Task has begun a pipeline at all, so re-attaching
  cannot silently rewind a cursor, and detaching is refused for a Task that follows nothing — which
  is also what stops detach-then-delete from walking around the Step-in-use guard.
- **Versioning is bump-and-detect, not copy-on-write.** A Step write that changes something
  increments `workflow.version`; a Task records the version it attached at and reports
  `definitionDrifted` when the two differ, and `workflow.acknowledgeDrift` lowers the flag without
  moving the cursor. A no-op edit bumps nothing — a warning that cannot be cleared, raised by an
  edit that did not happen, is one an operator learns to ignore. The immutable-version-per-Run rule
  under *States & rules* is still the target; a snapshot table with no producer would be a table
  nothing writes.
- **The Workflow namespace is withheld from the external MCP surface** (issue #16). The holder of
  an MCP token is the agent whose work the gates exist to hold, and `workflow.advanceTask` is the
  call that opens them. Driving a pipeline from MCP is issue #86, and it needs the run loop that
  produces one Session per Step so a completion report can be attributed to the Step it came from.
- **Automations are a Step property.** `workflow_step.on_enter` is reserved for the automations of
  row 08, so an automation is a field on a Step rather than a second rules engine.

## The run loop (issue #5, AC-2/AC-3/AC-5)

The orchestrator walks the Steps. `runTaskLifecycle` in
`apps/orchestrator/src/inngest/functions/task-run.ts` is the one place it happens, and the shape
it took is worth stating because it is not the obvious one.

- **One monotonic round counter, and no nested Step loop.** A Step boundary is a round at which
  the agent binding and the brief change; the existing review-round loop already does everything a
  Step loop would. A nested loop that reset `round` per Step would replay `agent-run-0` and
  `approve-0` on Step 2, and Inngest would hand back Step 1's memoized results — silently skipping
  Step 2's agent run and replaying Step 1's review decision. Because no durable step id contains a
  Step ordinal, **a definition edit cannot corrupt a live run's journal**, which is why there is no
  drift refusal on this side. `MAX_REVIEW_ROUNDS` is per Step; a Workflow may have at most
  `MAX_WORKFLOW_STEPS` (20) Steps and a longer one is refused by name rather than truncated.
- **The cursor is read once, at the top, in `workflow-resume`.** It is read-only: the resolved
  cursor is not written back, because `taskHasBegunWorkflow` reads exactly those columns to refuse
  a re-attach. A cursor naming a Step the Workflow no longer contains fails the Task with
  `workflow_unresumable` — never a silent restart at Step one.
- **Every Step's agent is resolved before anything is cloned.** The executor preflight probes every
  binary the pipeline can spawn and the runner gate refuses a pipeline naming a protocol this build
  cannot drive, both before `prepare-repository`. The resolved set deliberately carries **no
  credential**: `step.run` memoizes its return value durably, so each Step's ciphertext is read at
  the point of use instead.
- **An advance keeps the worktrees.** "Advance to the next Step without starting a new Task" is
  physically one Task row whose cursor moved: no commit, no publish, no result branch, no `done`,
  no cleanup. The next Step continues in the same worktrees and therefore sees the previous Step's
  uncommitted work. Ending the run and re-launching would have destroyed exactly that.
- **Integration has one home.** It is inside `approve-${round}`, reachable only from a
  `review.decided` carrying `approve`. The agent-signal path can report `completed` and still does
  not integrate — it falls through to the review gate, which costs one extra approval in a rare
  state and is stricter than Principle I requires, never looser.
- **The approve branch sends the Step's own advance rule, not the literal `review`.** A Step that
  advances on `agent-signal` behind a `human` gate is ordinary; sending `review` to it returns
  `held`, moves nothing, spends nothing, and stalls the pipeline with no error anywhere.
- **A rejection clears the Step's parked summary.** The cursor does not move — a rejection is not a
  completion — but the refused attempt's summary is dropped, or the work a human explicitly
  declined would become the next Step's inbound context.
- **`WORKFLOW_STALE_CURSOR` is not a failure.** It means the transaction committed and Inngest
  retried the step body; the run re-reads the cursor and carries on from where the transaction left
  it. Treating it as an error would turn every retried approve into a failed Task.

### Board columns (AC-6)

Columns are data, not the lifecycle enum. `taskStateSchema` survives untouched — it is load-bearing
outside the board — and the board gains two modes chosen by one control, never inferred:

- **Lifecycle mode** is the default and the only mode reachable with `ff-workflows` off. It is
  today's seven columns, today's order, today's drag and drop.
- **Workflow mode** shows one column per Step of *one* selected Workflow, in rank order, then a
  `Done` column, then an `Other work` lane holding everything on another Workflow or on none.
  Nothing is hidden; a Workspace mid-migration has most of its Tasks on no Workflow at all.

Step columns are **not drop targets**, and that is a Principle I decision rather than a
convenience one: a drop that wrote `workflow_step_id` would skip the gate, spend no approval,
promote no handoff and record no decision. Routing such a drop through `workflow.advanceTask`
instead was rejected too — it is gate-evaluated, so a drop onto a human-gated Step returns
`awaiting-decision`, does nothing, and snaps the card back with no signal a user can tell from a
bug. A Task's lifecycle state stays on the card as its badge: the column says *where in the
pipeline*, the badge says *what is happening to it*.

### What this costs, stated rather than discovered

- **The kill switch is a footgun.** Turning `ff-workflows` off mid-pipeline makes the next run of
  that Task ignore its cursor entirely: it runs the Task's own Agent Profile from the top and
  integrates on the first approval, as if the pipeline were not there. The cursor is not cleared,
  so turning the flag back on resumes where it was — but the work done in between was done outside
  the pipeline. Turn the flag off for a Workspace with Tasks in flight only deliberately.
- **One Session for the whole Workflow run.** `sessionId` is a run-scoped constant threaded
  through the lifecycle and matched by `review.decided`. So `latestDecisionForTask` stays
  *Task*-scoped, and "which Step was this review about" is answerable only from the state
  transition events. Two approvals recorded inside one Step's review round leave the newer one
  unspent and available to the next gate. Per-Step review linkage needs one Session per Step
  (#26/#61).
- **An extra approval in one state.** If the agent's signal reaches the last Step while an
  approval is already unspent, the agent-signal path reports `completed` and marks that approval
  spent without integrating. The review that follows then finds nothing to spend and the run stops
  with a notice asking for the decision again. Stricter than required; never looser.
- **`producedChanges` has no per-Step baseline.** It is computed over the Task's worktrees, which
  accumulate across Steps, so an `auto-unless-changes` gate placed after any code-writing Step will
  always see changes and always behave as `human`. A per-Step diff baseline needs a commit or a
  marker at each boundary, which is the thing an intermediate advance must not do.
- **Concurrency caps are still checked against the Task's Profile only.** `withinConcurrencyCap` in
  `apps/web/src/server/dal/task.ts` reads `task.agentProfileId`, so a Workflow walking onto a Step
  whose Agent Profile is already at its cap is not checked at all. This issue opens that hole; it
  closes when the cap check learns about the cursor.

Later, in the order they unblock things: the Monitor strip of FR-9, one Session per Step (#26/#61)
and the per-Step review linkage it unlocks, copy-on-write versioning so a Run really is pinned to
the definition it started on, non-agent Step kinds (Gate, Condition, Fork/Join — FR-2), validity
checking (FR-5), import/export (FR-7), and per-Step run history.

The /workflows UI keeps its WIP badge (`Section.wip` in `apps/web/src/lib/navigation.ts`) while the
Monitor and per-Step history are outstanding, so a user finds a clearly-marked in-progress surface
rather than one that looks broken.

## Related

- [F02 — Kanban Task Administration](./F02-kanban-task-administration.md)
- [F04 — Multi-Agent Orchestration](./F04-agent-orchestration.md)
- [F10 — Review & Approval](./F10-review-approval.md)
- [Decision 0007 — ReactFlow for Workflow visualisation](../decisions/0007-reactflow-workflow-visualisation.md)
- [Decision 0004 — Durable orchestration engine](../decisions/0004-durable-orchestration-engine.md)
