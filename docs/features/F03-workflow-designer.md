# F03 — Visual Workflow Designer & Monitor

**Status:** Draft · **Owner:** Product · **Maturity:** Core / Edge · **Last reviewed:** 2026-08-17

## Summary

A Workflow is a repeatable, multi-step process that chains Harnesses and human decisions
together. SoloW presents Workflows as a **visual node graph**: users design a
Workflow by arranging and connecting Steps on a canvas, and watch a live Run's progress
overlaid on that same graph. This makes complex, multi-harness processes understandable and
steerable without reading logs.

## Jobs served

- **J3 — Design a repeatable process.**
- **J4 — Watch a process unfold.**
- **J8 — Resume and recover.**

## User stories

- As a Team Lead, I want to design a process where one harness plans, another implements, and
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
- **FR-2** Step types include at minimum: a **Harness Step** (a Harness performs an action),
  a **Gate** (waits for a human decision), a **Condition** (branches on a rule), and a
  **Fork/Join** (runs branches in parallel and recombines them).
- **FR-3** Each Harness Step references a Harness Profile and the instruction or role it plays.
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

## What a Workflow graph cannot be (FR-5)

The designer does not validate a drawing against a rule book; most invalid shapes cannot be
expressed at all, because the graph is derived from the Step list rather than stored beside it.
Each impossibility below is either *structural* (there is no data that could hold it), *refused*
(the API returns the named error), or *flagged* (the canvas says so on the node, and
`workflow.attachTask` refuses). The single source is `stepExits` / `validateWorkflowGraph` in
`@solow/core`; the canvas (`stepEdges`) and the attach guard both read it.

| Impossibility | Kind | Why, and where it is held |
| --- | --- | --- |
| **Two starts.** | structural | The start *is* the first Step in rank order (`resumeWorkflowCursor(steps, null)`). It is not a node the operator places — the `Start` pill draws that fact. To change the start, reorder, or use the `+` on the Start edge to put a Step before the first (`afterStepId: null`). |
| **Two ends.** | structural | The end *is* a null target. Every Step without a branch whose rank successor does not exist, and every branch exit set to "End of pipeline", lands on the same `End`. There is one `END_NODE_ID` and no row behind it. |
| **An edge drawn by hand, or a dangling one.** | structural | Edges are not stored. A Step has exactly one exit (its rank successor, or the end) or exactly two (`Yes`/`No`). The only connect gesture is dragging a branch's `Yes`/`No` exit onto a Step or the end, and it *re-points that exit* (`branchRetarget` → `updateStep`) — it cannot create an edge the model has no row for. The plain exit and the start are not draggable; dragging a node is a *reorder*, never a link. |
| **A Step with no exit.** | structural | See above: the last Step exits to the end. Nothing can be dead-ended by construction — only trapped (below). |
| **Three exits, or parallel branches (Fork/Join).** | structural | A branch has one condition and two targets. FR-2's Fork/Join stays Later. |
| **A node position of its own.** | structural | Positions are laid out from rank on every render (`placeSteps`). A drop is turned into a `reorderStep` and the node snaps back. |
| **A branch to the Step it hangs off.** | refused | `WORKFLOW_BRANCH_TARGET_IS_SELF` — the cursor would not move, so the `StaleCursor` replay guard would be blind. |
| **A branch to another Workflow's Step, or to a deleted one.** | refused | `WORKFLOW_STEP_NOT_IN_WORKFLOW`, on write. At run time a target deleted since is the same code, never a silent restart. |
| **Deleting a Step another Step branches to.** | refused | `WORKFLOW_STEP_BRANCHED_TO` — nulling the reference would silently turn "go to X" into "the pipeline ends here". |
| **Deleting a Step a Task sits on / a Workflow a Task follows.** | refused | `WORKFLOW_STEP_IN_USE` / `WORKFLOW_IN_USE`. |
| **Attaching a Workflow with no Steps.** | refused | `WORKFLOW_EMPTY` — there is no start. |
| **A Step nothing leads to.** | flagged | `validateWorkflowGraph` → `unreachable`. Said on the node ("Unreachable — no step leads here, so it never runs."); `attachTask` refuses with `WORKFLOW_GRAPH_INVALID`. Not refused at edit time, because building a loop passes through this shape. |
| **A loop with no way to the end.** | flagged | `validateWorkflowGraph` → `no-exit`, on every Step trapped in it ("No way out — from here the pipeline can never end."); `attachTask` refuses with `WORKFLOW_GRAPH_INVALID`. A loop that *can* end — review sends the Task back, or ends it — is a pipeline, not a fault. |
| **Finishing without a human's approval.** | refused | Principle I. Whatever the graph, the terminal rule in `advanceWorkflowStep` completes nothing without a recorded, unspent approval. |

Not an impossibility, and deliberately so: a branch whose two exits name the same Step. It is
what a branch is born with (both on the rank successor, so switching it on changes nothing), and
it is how an operator gets from one shape to the next.

## Edge cases & failure handling

- If a Step fails, the Run pauses at that Step and surfaces the reason; the user can retry
  the Step, skip it (if allowed), or cancel the Run.
- If a Gate is never resolved, the Run remains paused and is clearly shown as waiting on a
  human, and can be reassigned or cancelled.
- If a Harness Step exhausts a subscription quota, the Step parks and the Run waits, matching
  Task Parked behaviour in [F06](./F06-authentication-billing.md).

## Out of scope

- The internal engine that guarantees durability and resumption (an architecture concern;
  see [Decision 0004](../decisions/0004-durable-orchestration-engine.md)).
- The specific visual styling of the canvas (owned by Design).

## What ships in v1

- **Launch asks which Workflow.** Pressing *Launch* on a Ready Task (board or Task page) opens a
  choice — *No workflow* (one harness run) or any pipeline of the Workspace, preselected to what the
  Task is bound to — writes the binding, then launches. With no Workflow in the Workspace, or the
  flag off, the launch goes straight through as before.
- **Built through the SoloW MCP too** — the `workflow.*` authoring procedures (create, add /
  update / reorder / delete Steps, attach and detach a Task) are exposed as MCP tools, with
  `workflow.authoringGuide` returning the rules and the tool sequence so an AI holding a token
  can design a pipeline. `workflow.advanceTask` and `workflow.acknowledgeDrift` stay withheld:
  the gates are a person's to open. The two library *lists* are exposed so a Step can name items
  by id; library writes stay signed-in.
- **A node is a form only when you are close enough to fill one.** Below 0.72 zoom every Step
  card collapses to what a pipeline is *read* for — ordinal, name, harness, gate and advance rule,
  a branch mark, a problem count — and the fields come back on the way in (React Flow's contextual
  zoom). Six nodes each drawing three selects, a prompt, two library pickers and a branch form was
  a wall of controls with the pipeline somewhere behind it, at a zoom where none of them could be
  read anyway. The two acts that are *about* a Step rather than fields of it — removing it, and
  making it branch — moved off the card onto a `NodeToolbar` revealed by pointing at the node, so
  the trash is no longer a permanent invitation beside a text field and a compact node is still
  operable. Handles stay pinned at fixed offsets from the card's top in both modes, so the
  pipeline's main line is a line whatever a node is showing. A `MiniMap` appears past three Steps,
  each Step in its own dot colour, pannable and zoomable. (FR-4)
- **One axis, from the start pill to the end pill.** A node's position names its left edge and its
  vertical *middle* (React Flow's `nodeOrigin`), so every node is strung on one horizontal line
  however tall it happens to be. It used to be a fixed 112px measured down from each card's top,
  with every card top-aligned: that kept the *line* straight but hung the nodes off it — an edge
  entered a tall card near its top and a short one near its bottom, and the 24px pills sat
  wherever that offset happened to fall. The handles moved with it, from pixel offsets to the
  card's own middle, and the two edge lanes that route around the row (`yes` over, `no` under)
  now measure both sides of it. The alternative — subtracting half of each card's measured height
  — works, but makes the layout depend on a measurement that arrives a frame after the render
  needing it; telling React Flow what a position *means* is the same statement made once, and its
  own `fitView`, minimap and bounds arithmetic account for it.
- **A branch exit is named at both ends.** The `yes`/`no` chip moved off the inside of the card —
  where 6px from the right border put it on top of the handle dot, on top of the branch form's
  full-width selects, and, for `yes`, on top of the `+` in the gap, since the exit, its badge and
  the insert button all sat on the main line — out onto the stub of the edge it names, lifted
  clear of the line so the dash runs underneath it. The badge on an edge routed around the row
  moved from the middle of its run to the end it *arrives* at (`laneLabelX`): the middle of a run
  spanning four cards is above whichever card is halfway along it and says nothing about either
  end, while the leaving end is already named by the chip. A `yes` that loops back to *Implement*
  now reads `yes` where it leaves and `yes` where it lands, and can be traced from either.
- **A pipeline can come from the store.** *Browse the store* under *New workflow* in the sidebar
  opens a curated catalog in `@solow/core` (`WORKFLOW_STORE`, the `MCP_STORE` idea applied to
  Workflows): everyday shapes — plan/build/test/review, review-then-fix, two independent
  reviewers, a security review, refactor safely, simplify a module, migrate callers, hotfix, a
  flaky-test hunt, red/green/refactor, raise test coverage, a performance pass, a dependency
  upgrade, document a module, onboard a codebase — and three **methods as pipelines**: GitHub's
  **Spec Kit** (specify → clarify → plan → tasks → analyze → implement → verify, a Remediate loop
  behind the analysis), **Superpowers** (brainstorm → plan → execute test-first → verify → review
  → finish the branch, plus its systematic-debugging loop) and **OpenSpec** (explore → propose →
  apply → verify → archive). An entry is a recipe: its Steps with their gates, branches and
  permission postures, and the **names** of the Skills those Steps read.
  `workflow.installFromStore` takes the entry and the Harness Profile every Step runs on, adds
  each Skill to the library **only where the library has nothing of that name** — switched off,
  loaded by the Steps that name it — and then imports the entry as a document, so the same
  name-suffixing and the same rules apply. The three pipelines a fresh Workspace is seeded with
  are store entries marked `seed`, so the seed and the store cannot disagree, and a deleted
  default can be taken back from the store. `workflow.store` lists the catalog.
- **The Skills' text is the owners', fetched at build time — never typed into the repository.**
  `WORKFLOW_STORE_SOURCES` (`@solow/core`) is the reviewed manifest: for each source, the
  repository and ref on GitHub and the files that become Skills — Spec Kit's
  `templates/commands/*.md` (turned into Skills the way `specify init` turns them into commands),
  Superpowers' and OpenSpec's `skills/*/SKILL.md` under their own names — plus SoloW's own three
  (`packages/core/src/workflow-store/skills/*.md`: the security and refactoring checklists, and
  `speckit-verify`, the one Spec Kit phase upstream has no command for).
  `scripts/sync-workflow-store.ts` fetches each file at the commit the ref resolves to, validates
  it (a library name, a description, a body that is markdown and not a stub or an error page),
  and writes `vendored.generated.json` with the commit of every source and a hash of every body;
  the catalog reads that file. **CI fetches before it builds** (`make store-sync` in Verify and in
  Publish), so a release carries the upstream text of the day, and a source that cannot be
  fetched or fails validation fails the build — a stale copy is never shipped silently.
  `make store-check` is the offline gate, in `make verify` and in CI: the generated file exists,
  matches the manifest, holds every Skill the catalog names, and has not been edited by hand. The
  generated file is committed as the baseline a checkout builds from offline, and a scheduled
  workflow (`refresh-workflow-store.yml`, daily) re-syncs and commits it when upstream moved, so
  nobody refreshes it by hand. A Skill that reaches for a sibling file of its upstream directory
  (Superpowers' `code-reviewer.md`, for one) still reads best from a directory import of the
  whole plugin, which the name rule above then binds to.
- **A pipeline is a file you can share** (FR-7). `workflow.export` returns the Workflow as a
  portable JSON document and `workflow.import` writes one back, with the Export button in the
  Workflow inspector and *Import from file* under *New workflow* in the sidebar. The document
  carries **no ids**: the Harness Profile a Step runs on, and the MCP servers and Skills it loads,
  travel **by name**, and a branch's targets travel as **indices** into the document's own step
  list — so the same file means the same pipeline in another Workspace or another instance, and
  reads well enough to edit by hand and check into a repository. Resolution on the way in is lossy
  by construction and says which way it failed: an unmatched Skill or MCP server is **dropped**
  (a Step runs without it), an unmatched Harness Profile **falls back** to one that exists (a Step
  without a harness is not a Step), and every substitution comes back in the reply for the
  operator to re-point on the canvas. A name the Workspace already uses is suffixed — *Ship (2)* —
  rather than refused, so the same document imports twice. The imported Workflow starts at version
  1: it has been edited zero times.
- **Three pipelines by default** — *Implement & review* (a reviewer harness decides whether another
  pass is needed), *Plan, then build* (a plan you approve, then the build), *Bug fix* (reproduce,
  fix, verify, looping while the bug still reproduces). Seeded once the Workspace has its first
  Harness Profile and only while it has no Workflow of its own, so a pipeline you delete stays deleted. (issue #5)

The model, its seam and the designing canvas ship; the monitor does not. Concretely:

- **Designing is a node graph of a linear pipeline.** `workflow` + `workflow_step` tables,
  Workspace-scoped (Principle V), drawn at `/workflows` on a React Flow canvas
  ([Decision 0007](../decisions/0007-reactflow-workflow-visualisation.md)): one node per Step,
  left to right in rank order, each node carrying its own form — Harness Profile, gate, advance
  rule, prompt — and a `+` beside it that adds the next Step on the first Harness Profile in the
  catalog, renamed in place. Edges follow the order and are not drawn by hand: a linear pipeline
  has exactly one edge between consecutive Steps, and the one connect gesture — dragging a
  branch's `Yes`/`No` exit onto a Step or the end — re-points an exit that already exists rather
  than adding an edge (FR-1 without its branching; FR-4's panning and zooming). Dragging a node past a neighbour is a reorder — the drop
  is turned into the neighbour pair `workflow.reorderStep` takes and the node snaps back to its
  laid-out place, so the canvas never stores a position the run loop could disagree with.
  Parallel Steps and non-harness nodes (Gate, Fork/Join — FR-2) stay Later.
- **A Step names what it loads from the harness libraries** ([F24](./F24-harness-libraries.md)):
  `workflow_step.mcp_server_ids` / `skill_ids`, chosen on the node under *Loads*, additively —
  the Workspace-wide items are checked and locked there, the rest are the Step's own. Every id is
  checked against the Workspace's libraries before it is written (`WORKFLOW_TOOL_NOT_IN_WORKSPACE`),
  and an item a Step names cannot be deleted from its library.
- **A Step sets its own permission posture** (spec F05's `permissionMode`, on the Step).
  `workflow_step.permission_mode`, chosen on the node under *Launches with*, beside the MCP
  servers and Skills that Step loads — because **a Step is a harness launch**: a Task under a
  Workflow starts a fresh session at every Step with that Step's Profile, that Step's servers and
  Skills and that Step's brief, and how much that harness may do without asking is a launch
  parameter exactly like those. Wanting a *plan* Step and a *build* Step on one Harness Profile is
  the ordinary shape of a pipeline; before this it took two Profiles differing in a single enum,
  each with its own credential binding and concurrency cap. **Null is the default and means
  "whatever the Profile says"** — so the column changed no existing pipeline, and a Step with no
  opinion keeps following its Profile when the Profile is re-postured. The Profile keeps the field
  and keeps deciding for the run that has no Step at all — a Task following no Workflow — which is
  why moving it onto the node could not mean removing it from Settings; what changed there is that
  it now says it is the fallback. The posture travels in an exported document as itself rather
  than as a name to resolve: it is one of three fixed values and means the same in any Workspace.
- **A Step can branch on a condition** (FR-2's *Condition*, in the shape this pipeline can
  answer). It is a property of a Harness Step rather than a Step kind of its own — a Condition node
  would be a row with no harness, no prompt and no gate, and every rule that reads a Step would have
  to learn to skip it. `workflow_step.branch` holds a condition and two targets: when the
  condition holds, the Task goes to `thenStepId`, otherwise to `elseStepId`. Either target may be
  null, meaning *the pipeline ends here*, and either may name an **earlier** Step — "changes
  requested, go back and implement" is the branch most worth having. Three conditions exist, and
  none fetches evidence the advance transaction does not already hold, so a Condition never
  becomes a second rules engine. **`agent-decides` is the one the feature is for: the harness
  answers the question.** The operator phrases it ("Does the implementation need another pass?");
  `buildStepBrief` appends it to the Step's brief under *Decision to make*, with where to answer
  and what each answer leads to; the harness — the party that has just read the code — answers in
  the `decision` field of its `task_complete` widget (`"yes"` / `"no"`), which is read first, or
  on a `DECISION: yes` / `DECISION: no` line at the end of its final message. Either way the
  answer travels in the handoff as that line, and the advance reads the last one off it
  (`readHarnessDecision`). The handoff is the widget's summary; an answer the harness gave in the
  widget's field or wrote in its message but not in that summary is carried into it by the run
  loop (`carryHarnessDecision`), because the first live run did exactly that and the answer would
  otherwise have been lost. No answer is not an affirmation and counts as `no`, and the brief
  says so. `produced-changes` is the second: the same corroborated fact `auto-unless-changes`
  reads. `outcome` is the third: how the harness declared its run ended (`changes_ready`,
  `nothing_to_do`, `blocked`), read off the same `task_complete` widget — so a Step whose harness
  stopped because it could not go on can be routed to a person or an escalation Step rather than
  arriving at the review gate looking like finished work. A harness that declared nothing
  matches no outcome. **Every advance writes a `workflow_decision` record into the Session log**
  — which Step reported in, on which signal, what its gate asked, how its condition evaluated
  and where the cursor went — produced by the same evaluation that moved the cursor, so a Task
  held at a gate or sent back down a branch explains itself in its own transcript instead of
  looking like a run that stopped. A Step without a branch still goes to its rank successor, so every
  pipeline written before branches existed walks exactly as it did. A null target lands in the
  same terminal rule as running off the last Step — Principle I holds however a Task reaches the
  end. The canvas draws a branching Step with a `yes` and a `no` exit; an edge that skips or goes
  back is routed around the row, and a null target is an edge to the `End` node.
- **Step order is a lexicographic rank string**, not a position. Inserting a Step in the middle
  writes exactly one row and renumbers nothing; a reorder names the two Steps the moved one lands
  between, and is refused as stale if those two are no longer adjacent.
- **Every Step names a Harness Profile** from the catalog of [F05](./F05-harness-executor-profiles.md)
  (issue #10). There is no second way of naming a harness, which is what makes "a single Task uses
  different harnesses across Steps" a difference between two rows.
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
  the signal once a human has decided no longer has the harness's words.
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
  an MCP token is the harness whose work the gates exist to hold, and `workflow.advanceTask` is the
  call that opens them. Driving a pipeline from MCP is issue #86, and it needs the run loop that
  produces one Session per Step so a completion report can be attributed to the Step it came from.
- **Automations are a Step property.** `workflow_step.on_enter` is reserved for the automations of
  row 08, so an automation is a field on a Step rather than a second rules engine.

## The run loop (issue #5, AC-2/AC-3/AC-5)

The orchestrator walks the Steps. `runTaskLifecycle` in
`apps/orchestrator/src/inngest/functions/task-run.ts` is the one place it happens, and the shape
it took is worth stating because it is not the obvious one.

- **One monotonic round counter, and no nested Step loop.** A Step boundary is a round at which
  the harness binding and the brief change; the existing review-round loop already does everything a
  Step loop would. A nested loop that reset `round` per Step would replay `agent-run-0` and
  `approve-0` on Step 2, and Inngest would hand back Step 1's memoized results — silently skipping
  Step 2's harness run and replaying Step 1's review decision. Because no durable step id contains a
  Step ordinal, **a definition edit cannot corrupt a live run's journal**, which is why there is no
  drift refusal on this side. `MAX_REVIEW_ROUNDS` is per Step; a Workflow may have at most
  `MAX_WORKFLOW_STEPS` (20) Steps and a longer one is refused by name rather than truncated.
- **The cursor is read once, at the top, in `workflow-resume`.** It is read-only: the resolved
  cursor is not written back, because `taskHasBegunWorkflow` reads exactly those columns to refuse
  a re-attach. A cursor naming a Step the Workflow no longer contains fails the Task with
  `workflow_unresumable` — never a silent restart at Step one.
- **Every Step's harness is resolved before anything is cloned.** The executor preflight probes every
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
  that Task ignore its cursor entirely: it runs the Task's own Harness Profile from the top and
  integrates on the first approval, as if the pipeline were not there. The cursor is not cleared,
  so turning the flag back on resumes where it was — but the work done in between was done outside
  the pipeline. Turn the flag off for a Workspace with Tasks in flight only deliberately.
- **One Session for the whole Workflow run.** `sessionId` is a run-scoped constant threaded
  through the lifecycle and matched by `review.decided`. So `latestDecisionForTask` stays
  *Task*-scoped, and "which Step was this review about" is answerable only from the state
  transition events. Two approvals recorded inside one Step's review round leave the newer one
  unspent and available to the next gate. Per-Step review linkage needs one Session per Step
  (#26/#61).
- **An extra approval in one state.** If the harness's signal reaches the last Step while an
  approval is already unspent, the agent-signal path reports `completed` and marks that approval
  spent without integrating. The review that follows then finds nothing to spend and the run stops
  with a notice asking for the decision again. Stricter than required; never looser.
- **`producedChanges` has no per-Step baseline.** It is computed over the Task's worktrees, which
  accumulate across Steps, so an `auto-unless-changes` gate placed after any code-writing Step will
  always see changes and always behave as `human`. A per-Step diff baseline needs a commit or a
  marker at each boundary, which is the thing an intermediate advance must not do.
- **A backward branch is a loop, and the loop is bounded by the round budget, not by design.**
  `maxRounds` is `MAX_REVIEW_ROUNDS × stepCount`, and every advance resets the per-Step budget, so
  a review that keeps sending the Task back to implement runs until that global budget is spent
  and the run stops without a Task-level reason that names the loop. A branch may not target its
  own Step (`WORKFLOW_BRANCH_TARGET_IS_SELF`), because the cursor would not move and the
  `StaleCursor` replay guard relies on it moving. A Step another Step branches to cannot be
  deleted (`WORKFLOW_STEP_BRANCHED_TO`): nulling the reference would silently turn "go to X" into
  "the pipeline ends here".
- **Concurrency caps are still checked against the Task's Profile only.** `withinConcurrencyCap` in
  `apps/web/src/server/dal/task.ts` reads `task.agentProfileId`, so a Workflow walking onto a Step
  whose Harness Profile is already at its cap is not checked at all. This issue opens that hole; it
  closes when the cap check learns about the cursor.

Later, in the order they unblock things: the Monitor strip of FR-9, one Session per Step (#26/#61)
and the per-Step review linkage it unlocks, copy-on-write versioning so a Run really is pinned to
the definition it started on, non-harness Step kinds (Gate, Fork/Join — FR-2; Condition ships as a Step property, above), validity
checking (FR-5), import/export (FR-7), and per-Step run history.

The /workflows UI keeps its WIP badge (`Section.wip` in `apps/web/src/lib/navigation.ts`) while the
Monitor and per-Step history are outstanding, so a user finds a clearly-marked in-progress surface
rather than one that looks broken.

## Related

- [F02 — Kanban Task Administration](./F02-kanban-task-administration.md)
- [F04 — Multi-Harness Orchestration](./F04-harness-orchestration.md)
- [F10 — Review & Approval](./F10-review-approval.md)
- [Decision 0007 — ReactFlow for Workflow visualisation](../decisions/0007-reactflow-workflow-visualisation.md)
- [Decision 0004 — Durable orchestration engine](../decisions/0004-durable-orchestration-engine.md)
