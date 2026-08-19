# Feature Specification: Core Program — End-to-End Task Loop

**Feature slug**: `core-program`
**Feature flag**: `ff-core-program` (default: OFF)
**Feature branch**: `001-core-program`
**Created**: 2026-08-17
**Status**: Draft
**RFC PR**: [link — must be merged before implementation PR is opened]

**Input**: User description: "create the core program"

Scope note: "the core program" is the **thin end-to-end vertical slice** that makes GateControl
work — not the full F01–F18 surface. It is the single-Task loop on a local, single-user
deployment: create an Issue, break it into a Task on a Kanban board, run one agent in an
isolated working copy, watch it live, review the proposed changes, and approve. Breadth
(Workflows, multi-repo, remote/cloud executors, integrations, hosted multi-user, analytics,
notifications, guided onboarding) is deliberately deferred.

---

## Clarifications

### Session 2026-08-17

- Q: How many agent tools must the core slice support in v1? → A: One agent — Claude Code —
  driven through the standard agent protocol; other agents are added later by configuration.
- Q: How is a Repository provided to a Task in v1? → A: Both — an existing local clone (a path
  on the machine) or a remote URL that GateControl clones.
- Q: On approval, what happens to the accepted changes? → A: Commit them onto a new local
  branch (no push, no pull request).
- Q: What is the default subscription concurrency cap (per Agent Profile)? → A: 3.

---

## User Stories *(mandatory)*

### Story 1 — Take an Issue to an accepted change with an agent (P1)

**As** the Workspace Owner (a solo user on a local deployment),
**I want** to create an Issue, run an agent on a Task under it, review the proposed changes,
and approve them,
**so that** I can get real work done by an agent without any change landing that I did not
review.

**Why P1**: This is the whole reason the product exists — the smallest slice that proves the
review-first loop end to end. Nothing else has value without it.

**Primary path**:
1. Create an Issue with a title and description.
2. Create a Task under the Issue, selecting an Agent Profile and the local Executor Profile
   and one Repository.
3. Launch the Task; the agent starts in an isolated working copy and its activity streams
   live.
4. The agent proposes changes; the Task enters Review and the changes are shown as a diff.
5. Approve the changes; the Task moves to Done and the changes are integrated onto a branch.

**Alternate paths**:
- Reject the proposed changes: the Task returns from Review and the working copy changes are
  discarded.
- Request changes with feedback: the agent's session resumes with the feedback in context.

**Acceptance criteria** (EARS — each verifiable yes/no):
- [ ] AC-001: WHEN the Owner creates an Issue with a title, THE SYSTEM SHALL persist it in the
      Workspace and show it as Open.
- [ ] AC-002: WHEN the Owner creates a Task under an Issue with an Agent Profile, the local
      Executor Profile, and a Repository, THE SYSTEM SHALL place the Task in the Ready state.
- [ ] AC-003: WHEN the Owner launches a Ready Task, THE SYSTEM SHALL provision an isolated
      working copy, start the agent, move the Task to Running, and stream the agent's activity
      live.
- [ ] AC-004: WHEN the agent proposes changes, THE SYSTEM SHALL move the Task to Review and
      present the changes as a reviewable diff.
- [ ] AC-005: WHEN the Owner approves the changes in Review, THE SYSTEM SHALL commit them onto
      a new local branch (no push or pull request), move the Task to Done, and record who
      approved and when.
- [ ] AC-006: WHEN the Owner rejects the changes, THE SYSTEM SHALL discard the working-copy
      changes and record the rejection.
- [ ] AC-007: IF the Owner requests changes with feedback, THEN THE SYSTEM SHALL resume the
      agent's session with that feedback in context rather than starting a new one.
- [ ] AC-008: IF an agent run fails (crash, tool error, or unreachable agent), THEN THE SYSTEM
      SHALL move the Task to Failed with the reason attached and preserve its working copy for
      inspection.
- [ ] AC-009: THE SYSTEM SHALL NOT integrate any agent-proposed change without a recorded human
      approval.

---

### Story 2 — Choose how the agent is billed and authenticated (P2)

**As** the Owner,
**I want** to configure whether an agent runs on my subscription or an API key, with a
concurrency cap,
**so that** I control cost and never get an unexpected metered bill.

**Acceptance criteria** (EARS):
- [ ] AC-010: WHEN the Owner creates an Agent Profile, THE SYSTEM SHALL let them choose an
      Authentication Mode of Subscription or API Key.
- [ ] AC-011: WHILE an Agent Profile is in Subscription mode, THE SYSTEM SHALL run its agents
      using the stored subscription credential and SHALL NOT run them in a way that causes
      metered API billing.
- [ ] AC-012: IF a Subscription-mode agent exhausts its quota window during a run, THEN THE
      SYSTEM SHALL move the Task to Parked, preserve its work, and resume it when the quota
      window resets.
- [ ] AC-013: IF a subscription credential is expired or revoked, THEN THE SYSTEM SHALL pause
      dependent Tasks in a distinct credential-expired state with instructions to renew it.
- [ ] AC-014: THE SYSTEM SHALL enforce the Agent Profile's concurrency cap so that no more than
      the configured number of that profile's agents run at once.
- [ ] AC-015: IF the Owner queues more parallel Subscription-mode Tasks than the cap allows,
      THEN THE SYSTEM SHALL warn them before queuing.

---

### Story 3 — Administer the Task on a Kanban board (P2)

**As** the Owner,
**I want** to see and move my Tasks on a board organised under their Issue,
**so that** I always know what is in flight and where it stands.

**Acceptance criteria** (EARS):
- [ ] AC-016: THE SYSTEM SHALL present Tasks in columns representing the lifecycle states
      (Backlog, Ready, Running, Review, Parked, Done, Failed).
- [ ] AC-017: WHILE a Task is Running, THE SYSTEM SHALL reflect its live status on the board in
      near real time.
- [ ] AC-018: WHEN the Owner moves a Task to a new state by direct manipulation, THE SYSTEM
      SHALL apply the change only if the transition is allowed, and otherwise explain why it is
      not.
- [ ] AC-019: IF the Owner moves a Running Task backward, THEN THE SYSTEM SHALL require
      confirmation and interrupt the agent's session.

---

### Story 4 — Recover from a failed Task (P3)

**As** the Owner,
**I want** to retry a Task that failed,
**so that** a transient problem does not cost me the Task.

**Acceptance criteria** (EARS):
- [ ] AC-020: WHEN the Owner retries a Failed Task, THE SYSTEM SHALL start a new agent session
      for it and move it to Running.
- [ ] AC-021: IF a Task has failed, THEN THE SYSTEM SHALL keep its prior session and reason
      viewable after the retry.

---

## Non-Goals *(mandatory)*

- Visual Workflows and agent chaining (F03) — deferred.
- Multi-repository Tasks — v1 is single-Repository per Task.
- Docker, SSH, and cloud Executors — v1 is the local Executor only.
- External integrations: issue-tracker sync and pull/merge request creation to a remote host
  (F12) — v1 integrates accepted changes onto a local branch only.
- Hosted, multi-user deployment and access control (F16) — v1 is local single-user.
- Analytics and reporting (F14), notifications (F15), and the guided onboarding Setup Workflow
  (F18) — separate features.
- Sharing/snapshots (F13).

---

## Edge Cases *(mandatory)*

- Empty state: what happens when the Workspace has no Issues, or an Issue has no Tasks? (Show
  an empty board with a clear call to action.)
- Missing prerequisites: what happens when the selected agent tool is not installed or not
  authenticated in the local Executor? (Prevent launch with an actionable reason.)
- Unreachable Repository: what happens when the Repository's local path is invalid or its
  remote URL cannot be cloned at launch? (Fail before starting the agent, with a clear reason.)
- Concurrent runs: what happens when two Tasks run at once? (Each runs in its own working copy;
  neither sees the other's files.)
- Quota exhaustion: what happens when a Subscription-mode agent hits its quota mid-run? (Task
  Parked, work preserved, resumes on reset.)
- Interrupted mid-run: what happens when the run is interrupted (process restart)? (The Task's
  state is preserved and it can resume or be retried without corrupting other Tasks.)
- Credential revoked mid-run: what happens when the credential is revoked? (Task pauses in a
  credential-expired state.)
- Unicode / large diffs: what happens with non-ASCII content or a very large diff? (Content is
  handled without truncation; the review remains usable.)

---

## RBAC Roles Affected

> This is a user-scoped, local single-user slice: the acting user is the Owner of their
> Workspace. The broader role set (Owner, Member, Reviewer, Operator) exists in the product but
> only Owner is exercised in v1; access is owner-vs-other-user, enforced by Workspace scoping
> per the constitution.

| Role | Can do what |
|---|---|
| Owner | Everything in this slice: create Issues and Tasks, configure Profiles and billing mode, launch/interrupt/retry agents, review and approve/reject/request-changes, integrate accepted changes |
| Other user (hosted, future) | No access to this Workspace's Issues, Tasks, or Sessions |
| Unauthenticated | No access |

---

## Key Entities

Every entity carries a non-nullable `workspaceId` (the tenant key) per the constitution, even
in local single-user mode (one Workspace).

- **Workspace**: The container and ownership boundary; holds Issues, Repositories, Profiles,
  and secrets.
- **Issue**: A unit of work with title, description, and status (Open → In Progress →
  Resolved → Closed); contains Tasks.
- **Task**: The executable unit under an Issue; references an Agent Profile, the local Executor
  Profile, and a Repository; moves through Backlog → Ready → Running → Review → Parked → Done /
  Failed.
- **Agent Profile**: Reusable agent configuration including Authentication Mode (Subscription /
  API Key) and concurrency cap.
- **Executor Profile**: Reusable runtime configuration; v1 supports the local type only.
- **Repository**: A connected Git repository a Task operates on, provided either as an
  existing local clone (a path on the machine) or as a remote URL that GateControl clones.
- **Worktree**: The isolated working copy created for a Task.
- **Session**: One run of an agent against a Task; records the conversation, events, and the
  proposed diff.
- **Review**: The recorded human decision (approve / reject / request-changes) on a Session's
  diff.
- **Secret**: An encrypted credential (subscription token or API key); write-only after entry.

---

## Functional Requirements

Written in EARS syntax:

- **FR-001**: WHERE `ff-core-program` is OFF, THE SYSTEM SHALL NOT expose any of this feature's
  surfaces.
- **FR-002**: THE SYSTEM SHALL let the Owner create, view, and search Issues within a Workspace.
- **FR-003**: THE SYSTEM SHALL let the Owner create a Task under an Issue, bound to one Agent
  Profile, the local Executor Profile, and one Repository.
- **FR-004**: WHEN a Task is launched, THE SYSTEM SHALL provision an isolated working copy on
  its own branch for the Task's Repository.
- **FR-005**: THE SYSTEM SHALL run concurrent Tasks in separate working copies such that no
  Task can read or modify another Task's working files.
- **FR-006**: WHILE an agent runs, THE SYSTEM SHALL stream its activity to the Owner and let the
  Owner send input and stop the agent.
- **FR-007**: WHEN an agent proposes changes, THE SYSTEM SHALL present them as a reviewable diff
  and move the Task to Review.
- **FR-008**: THE SYSTEM SHALL let the Owner approve, reject, or request changes on a diff, and
  SHALL record each decision with actor, timestamp, and any feedback.
- **FR-009**: THE SYSTEM SHALL commit an approved Task's changes onto a new local branch (no
  push or pull request) and move the Task to Done.
- **FR-010**: IF changes are rejected, THEN THE SYSTEM SHALL discard the working-copy changes.
- **FR-011**: IF changes are requested, THEN THE SYSTEM SHALL resume the agent's session with
  the feedback in context.
- **FR-012**: THE SYSTEM SHALL let the Owner define an Agent Profile's Authentication Mode as
  Subscription or API Key and its concurrency cap.
- **FR-013**: WHILE running a Subscription-mode agent, THE SYSTEM SHALL exclude any conflicting
  credential from that agent's run environment so metered billing cannot occur.
- **FR-014**: THE SYSTEM SHALL store all secrets encrypted and SHALL NOT display a secret after
  it is entered.
- **FR-015**: THE SYSTEM SHALL NOT expose any raw credential to the code an agent runs.
- **FR-016**: IF a Subscription-mode agent exhausts its quota window, THEN THE SYSTEM SHALL move
  the Task to Parked, preserve its work, and resume it when the window resets.
- **FR-017**: THE SYSTEM SHALL enforce each Agent Profile's concurrency cap, queuing Tasks that
  exceed it.
- **FR-018**: IF an agent run fails, THEN THE SYSTEM SHALL move the Task to Failed with the
  reason, preserve its working copy, and allow retry.
- **FR-019**: THE SYSTEM SHALL resume or fail cleanly after an interruption without corrupting
  any other Task's working copy.
- **FR-020**: THE SYSTEM SHALL scope every Issue, Task, Profile, Session, and Secret to its
  Workspace and filter every read by the Workspace.
- **FR-021**: THE SYSTEM SHALL let the Owner connect a Repository either as an existing local
  clone path or as a remote URL that GateControl clones, and SHALL create the Task's isolated
  working copy from it.
- **FR-022**: THE SYSTEM SHALL support running the Claude Code agent through the standard agent
  protocol in v1, with the design allowing other protocol-compliant agents to be added later by
  configuration.

---

## Success Metrics *(mandatory)*

| Metric | Target | Measurement |
|---|---|---|
| Core-loop completion | ≥ 90% of launched Tasks reach a terminal state (Done or Failed) without manual cleanup | Task lifecycle records |
| Reviewed-and-accepted rate | ≥ 70% of completed Tasks reach Done via a recorded human approval | Review decision records |
| Isolation correctness | 100% — no concurrent Task ever observes another Task's working files | Isolation test outcomes |
| Billing integrity | 0 unintended metered charges for Subscription-mode agents | Billing-mode audit |
| Time to first review | Owner reaches a reviewable diff within one launched run, no extra steps | Loop walkthrough |
| Recovery | 100% of interrupted runs resume or fail cleanly without corrupting other Tasks | Interruption test outcomes |

---

## Rollback Thresholds

Revert `ff-core-program` to OFF if, over a 15-minute window:

- Task-run failure rate > 20% (excluding user-cancelled runs).
- Any occurrence of a Task observing another Task's working files (isolation breach) — zero
  tolerance.
- Any occurrence of unintended metered billing for a Subscription-mode agent — zero tolerance.

Flag OFF restores prior behavior without a deployment.

---

## Marginal Cost Estimate

| Resource | Per operation (one Task run) | Notes |
|---|---|---|
| Local database rows | + a small, bounded set (Task, Session, events, review) | Local storage only |
| Working copies | + one isolated copy per Task, cleaned up on completion/discard | Local disk |
| Agent model usage | Charged to the Owner's subscription or API key | External to GateControl; bounded by concurrency cap |
| External services | None required | Local-first, no telemetry |

---

## GDPR / Privacy Classification

| Data field | Classification | Retention | Basis |
|---|---|---|---|
| Repository content in working copies | Non-personal (the Owner's own code) | Until Task completion/discard | Owner's own data |
| Agent conversations / session records | Non-personal, may incidentally contain code | Until the Owner deletes the Task/Workspace | Owner's own data |
| Credentials (subscription token, API key) | Sensitive (secret) | Until replaced or deleted; encrypted at rest, never displayed | Necessary to run agents |
| Owner account identity | Personal (local account) | Until the Owner deletes it | Contract |

Data minimization: the slice collects only what is needed to run and review agent Tasks.
Deletion: deleting a Task removes its working copy and session; deleting the Workspace removes
all of the above. No third-party personal data is processed.

---

## Assumptions

- Local, single-user deployment; one Workspace (default — confirm before implementation).
- One Repository per Task (provided as an existing local clone path or a remote URL that
  GateControl clones); the local Executor only (default — confirm before implementation).
- v1 supports a single agent, Claude Code, driven through the standard agent protocol; the
  agent tool is installed and available locally, and the Owner has provided either a
  subscription credential or an API key (clarified 2026-08-17).
- Success is the full review loop, not raw parallelism (default — confirm before
  implementation).
- Both Subscription and API-key billing modes are supported in v1, with a default subscription
  concurrency cap of 3 per Agent Profile (clarified 2026-08-17).
- The feature ships behind `ff-core-program`, default OFF, enabled for the local Owner first
  (default — confirm before implementation).
- Data & privacy handling is minimal with secrets encrypted; no sensitive-data retention
  controls in v1 (default — confirm before implementation).

---

## Open Questions

*None — the two prior open questions (supported v1 agent tool, default subscription concurrency
cap) were resolved in the Clarifications section on 2026-08-17.*
