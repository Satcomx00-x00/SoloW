# Domain Model

**Status:** Draft · **Owner:** Product · **Last reviewed:** 2026-08-17

This document describes the business concepts of GateControl and how they relate. It is
the conceptual model, not a database design. All terms are defined in the
[Glossary](../glossary.md).

## The organising idea

Work enters as an **Issue**. An Issue is broken into **Tasks**, which are administered on a
**Kanban Board**. Each Task is executed by an **Agent** running in an **Executor**, inside
an isolated **Worktree**, optionally following a **Workflow**. The person reviews the
resulting **Diff** and decides what ships.

## Concepts and relationships

- A **Workspace** contains everything else and is the boundary of ownership and (when
  hosted) access.
- A **Workspace** connects many **Repositories**.
- A **Workspace** holds many **Issues**.
- An **Issue** contains many **Tasks**. A Task always belongs to exactly one Issue.
- A **Board** presents Tasks; it can be scoped to one Issue or span many Issues within a
  Workspace.
- A **Task** references one **Agent Profile**, one **Executor Profile**, one or more
  **Repositories**, and creates one **Worktree** per Repository it touches.
- A **Task** may execute a **Workflow**; if it does, the Workflow's **Steps** drive the
  Task's progress.
- A **Task** produces one or more **Sessions**; each Session produces a **Conversation**, a
  stream of events, and a **Diff**.
- A **Diff** is subject to **Review**, whose outcome (accept, reject, request changes)
  advances or returns the Task.
- A **Workflow** is composed of ordered and branching **Steps**; a **Gate** is a Step that
  waits for a human.
- A **Run** is one execution of a **Workflow**; its progress is shown on the Workflow's
  visual graph.
- A **Task** or Conversation can be exported as a **Snapshot**.

## Lifecycle states

### Issue lifecycle
Open → In Progress → Resolved → Closed. An Issue is In Progress while any of its Tasks are
active, and Resolved when its Tasks are complete and their changes accepted.

### Task lifecycle
The default Kanban columns represent these states:

- **Backlog** — created, not yet ready to run.
- **Ready** — fully configured (Agent, Executor, Repositories) and eligible to run.
- **Running** — an Agent is actively working.
- **Review** — changes are proposed and awaiting human decision.
- **Parked** — paused because a subscription quota is exhausted or an agent credential
  expired; resumes automatically or on user action (see [F06](../features/F06-authentication-billing.md)).
- **Done** — changes accepted and integrated.
- **Failed** — ended in an unrecoverable error; can be retried.

### Workflow Run lifecycle
Pending → Running → (Waiting at a Gate ↔ Running) → Completed, or Failed, or Cancelled.
A Run that is interrupted resumes from its last completed Step rather than restarting.

### Session lifecycle
Active → Awaiting Review → Resumable → Closed. A Session can be resumed to continue an
Agent's work with its prior context.

## Ownership and boundaries

- Everything is scoped to a **Workspace**.
- **Profiles**, **Workflows**, **Repositories**, **Integrations**, and secrets are defined
  at the Workspace level and reused across Issues and Tasks.
- In hosted deployments, access is granted per Workspace.

## Relationship summary

> Workspace → (Repositories, Issues, Boards, Profiles, Workflows, Integrations)
> Issue → Tasks
> Task → (Agent Profile, Executor Profile, Repositories → Worktrees, optional Workflow) → Sessions → Diff → Review
> Workflow → Steps (including Gates); a Run executes a Workflow
