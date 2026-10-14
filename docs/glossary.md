# Glossary — Ubiquitous Language

**Status:** Reviewed · **Owner:** Product · **Last reviewed:** 2026-10-09

Every word SoloW's interface uses for one of its own ideas, defined once and in the words the
interface uses. Terms are capitalised throughout the docs when they refer to these concepts.
A first run needs only four of them: **Project**, **Issue**, **Task** and **Review**; everything
else has a default you can leave alone.

Words only people working on SoloW's code need are kept apart, under
[For contributors](#for-contributors) at the end.

## Where work lives

- **Workspace** — Everything you set up in SoloW: your Projects, Issues, Repositories,
  Harnesses, Workflows and Secrets. On your own machine there is one.

- **Project** — A body of work and the screens to run it: Planning, Board and Issues. A
  Project is either *adopted* — mirrored from a project on GitHub or GitLab — or *local*, made
  in SoloW when your tracker has nothing to mirror. SoloW never creates a project on your
  provider.

- **Planning** — A Project's own page: its Issues as a table, with the columns and saved views
  you choose.

- **Board** — A Project's Kanban: its Tasks as cards in columns, one per Task state. Drag a
  card to move a Task between states. A board showing a Workflow has one column per Step
  instead, and those columns cannot be dragged to: a Task moves along them by itself or when
  you approve a review.

- **Issue** — A problem, request or feature to work on: written in SoloW, or imported from
  GitHub, GitLab or Gitea. You start Tasks from an Issue.

- **Unassigned** — Issues that belong to no Project, for example ones imported before the
  Project that holds them was adopted.

- **Repository** — A code repository a harness is allowed to work in: a clone on this
  machine, or a remote Git URL.

- **Integration** — A connected GitHub, GitLab or Gitea account, set up with a personal access
  token. It is how SoloW imports Issues and Repositories and opens pull requests.

- **Provider** — The service your code and Issues live on: GitHub, GitLab or Gitea.

## Tasks

- **Task** — One piece of work on an Issue, done by a harness in its own copy of the code.
  A Task is created, launched, reviewed and then shipped or set aside.

- **Task states** — Where a Task is, shown as its column on the Board:
  - **Backlog** — not started.
  - **Ready** — waiting to be launched.
  - **Running** — a harness is working on it.
  - **Review** — the harness stopped and the Task waits for your decision.
  - **Parked** — the harness hit its usage limit. SoloW waits a fixed five hours, then resumes
    the run by itself; Retry starts it now.
  - **Failed** — the run stopped on an error. The Task says why; Retry starts a new run.
  - **Done** — finished, normally because you approved it.

- **Launch** — Start a Task: SoloW asks whether to run it through a Workflow or on its own,
  and starts the harness.

- **Run** — One go of a harness at a Task, from launch until it stops for review, fails or is
  parked. A run that fails or is stuck **needs attention**.

- **Retry** — Start a new run of a Failed or Parked Task.

- **Worktree** — The Task's own copy of the repository. The harness works only there, so two
  Tasks never change each other's files.

- **Blocked by** — Tasks that must be finished before this one can start.

- **Sub-task** — A Task split off from another, keeping its Issue, Harness, Repositories and
  Workflow.

## On the Task page

- **Steps** — The Task's main view: the Task's Steps side by side, and under each one what
  the harness did and asked while it was there. A Task with no Workflow has a single Step.
  (Not the Board: that is the Project's Kanban.)

- **Plan**, **Todos** — The harness's plan for a Step and its checklist, as it publishes them.

- **Decision** — A choice the harness made on its own while working. You confirm or overturn
  it at the review.

- **Question** — Something the harness asks you and waits for an answer to.

- **Permission request** — The harness asks before an action it may not take on its own.

- **Needs you** — Everything on the Task waiting on you right now: questions, permission
  requests, and decisions to confirm.

- **Follow live** — Keep the view on the newest activity while the harness works. Moving the
  view yourself turns it off.

- **Force review** — Make one Step of this Task wait for your review, whatever its Workflow
  says.

- **Brief** — What the harness was asked to do: the Issue and its acceptance criteria. The
  Brief tab lines each criterion up with what the harness says it did and the evidence for it,
  so you can tick it off.

- **Changes** — The files the harness changed, as a diff you read before you decide.

- **Terminal** — A shell in the Task's worktree, or the harness's own conversation, beside the
  Steps.

- **Session log** — The full record of a run: everything the harness said and did, and what
  SoloW did around it.

## Review and shipping

- **Review** — The point where a run stops and nothing goes further until you decide. Also
  called the **review gate**. Every Task ends at one, whatever its Workflow says.

- **Approve** — Accept the work. SoloW commits it and ships it.

- **Request changes** — Send the work back to the harness with your notes; it starts the next
  round.

- **Reject** — Turn the work down. Nothing is committed and the changes are left behind.

- **Round** — One pass of the harness between two reviews. Request changes starts the next
  one; the review shows which round you are deciding on.

- **Ship** — What Approve does after committing: push the branch and open a pull request (a
  merge request on GitLab). A Repository with no remote keeps the work as a local commit.
  **Shipped**, on Outcomes, counts the Tasks that got this far.

- **Pull request** — The request, on your provider, to merge the Task's branch. SoloW opens it,
  or updates the one already open.

- **Not shipped** — Approved and committed, but the push or the pull request failed. **Ship
  again** retries just that, without running anything again; **Keep local** finishes the Task
  with the work as a local commit.

- **Partly committed** — The work was committed in some of the Task's Repositories but not in
  others. The session log names which.

## Workflows

- **Workflow** — A reusable recipe for a Task in several Steps, for example *implement*, then
  *review*, then *verify*. Optional: a Task launched without one runs as a single Step. A new
  Workspace comes with three.

- **Step** — One stage of a Workflow: which harness runs it, what it is told to do, and how it
  ends.

- **Review gate options** — What happens when a Step's harness finishes, chosen per Step under
  *Review*:
  - **Wait for review** — the next Step waits until you approve this one. The default.
  - **Harness decides** — the harness says whether its work needs your review; if it does not
    say, the next Step waits for you.
  - **Move on** — the next Step starts as soon as this one is done.
  - **Move on unless files changed** — moves on by itself, unless this Step changed files.

  Questions the harness asks always wait for you, and nothing ships until you approve the last
  Step.

- **Finished when** — What counts as a Step being done: **Harness says done**, or **You approve
  it**. It follows the review gate: choosing *Move on* or *Harness decides* sets *Harness says
  done*, and *You approve it* is the same as *Wait for review*.

- **Branch** — A Step that goes one of two ways on a yes-or-no question: whether the harness
  says so, whether the Step changed files, or how the harness says its run ended.

- **Checkpoint** — A kind of action, such as running a database migration, that a Step's
  harness must have a person approve before it happens.

- **Workflow store** — Ready-made Workflows you can add to your Workspace.

## Harnesses and settings

- **Harness** — The AI coding tool SoloW runs to do the work, such as Claude Code.

- **Harness profile** — A saved way to run a harness: which tool and model, how it signs in,
  what it may do without asking, and how many may run at once.

- **Harness config** — The harness's own settings file (for example Claude Code's
  `settings.json`), kept in SoloW so your machine's own copy is never read or changed.

- **Executor** — Where a harness's commands run: on this machine or in a Docker container.

- **Secret** — A stored credential such as a token. Once saved, it is never shown again.

- **MCP server** — A set of extra tools a harness can call. On for every run, or only for the
  Workflow Steps that name it.

- **Skill** — Written instructions a harness reads before it works. On for every run, or only
  for the Workflow Steps that name it.

- **MCP access** — Tokens that let an outside agent or script drive SoloW. Each covers one
  Workspace and either read or read-and-write.

- **Provider login** — Your own username on each provider, so filters such as *@me* find your
  work.

- **New task defaults** — The harness and executor a new Task starts with.

- **Feature flag** — An on/off switch for one area of SoloW in this Workspace. Every flag
  starts on.

## Keeping track

- **Needs attention** — Tasks whose run failed or is stuck, listed on the status bar and
  announced when they appear.

- **History** — Tasks closed or deleted recently. A deleted Task can be restored and a
  finished one reopened, until its worktree is removed.

- **Outcomes** — What the work delivered, counted from what SoloW records: Tasks shipped, how
  many attempts reaching approval took, and what the runs cost.

- **Status bar** — The strip along the bottom of the window: service health, runs needing
  attention, and the segments you choose in Settings.

## For contributors

Words the interface does not use, but the architecture, decisions and feature specifications
do.

- **Agent Client Protocol (ACP)** — The open protocol SoloW uses to drive a harness, much as
  the Language Server Protocol standardised editor tooling.

- **Session** — The record of one harness run against a Task: its conversation, its stream of
  events and its proposed changes. The interface shows it as the session log.

- **Change Request** — SoloW's provider-neutral name for a pull request (GitHub, Gitea) or a
  merge request (GitLab), so the domain never encodes one provider's noun.

- **Executor Profile** — The stored configuration behind an Executor.

- **Local Deployment** / **Hosted Deployment** — SoloW on one machine for one person, or as a
  shared multi-user service. 1.0 targets the first; hosted teams wait until after it
  ([Decision 0031](./decisions/0031-focus-on-the-solo-power-user.md)).

- **Snapshot** — A redacted, shareable export of a Task's conversation and outcome. Planned;
  not in the product.

- **tRPC** — The typed request/response protocol the web app uses for queries and mutations
  against the backend.

- **MCP (Model Context Protocol)** — The open protocol SoloW speaks at `/api/mcp` so outside
  agents can drive it. Its tools are derived from the tRPC procedures, so the API and the tool
  list cannot disagree. An **MCP Token** (the interface's *MCP access*) is stored hashed, shown
  once, and every call it carries passes the same authorisation as the web app.

- **`openapi.json`** — The generated OpenAPI document for the backend HTTP API, exported from
  the tRPC routers for outside tools. It does not cover the realtime channel.

- **WebSocket channel** — The live connection between the web app and the backend that
  streams harness activity and state changes out, and carries terminal input and steering in.

- **Gate values** — The stored names of the review gate options, which the API and MCP tools
  use: `human` (Wait for review), `agent-decides` (Harness decides), `auto` (Move on) and
  `auto-unless-changes` (Move on unless files changed). *Finished when* is `advanceOn`:
  `agent-signal` or `review`. A Step whose `advanceOn` is `review` waits for review whatever its
  gate says.
