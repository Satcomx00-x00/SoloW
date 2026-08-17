# Glossary — Ubiquitous Language

This glossary defines the shared vocabulary used across all GateControl documentation,
the user interface, and internal communication. Terms are capitalised throughout the
docs when they refer to these specific concepts.

## Core work items

- **Workspace** — The top-level container and boundary of ownership. A Workspace holds
  Repositories, Boards, Issues, Profiles, Workflows, and secrets. In hosted deployments a
  Workspace is also the multi-tenancy and access-control boundary. (Not to be confused
  with a Worktree.)

- **Repository** — A connected Git repository that Tasks operate on. A Workspace may
  connect many Repositories.

- **Issue** — The organising unit of work. An Issue represents a problem, request, or
  feature to be addressed. It may be created natively in GateControl or synchronised from
  an external tracker (GitHub, Jira, Linear, GitLab, Sentry). Tasks are administered
  **under** an Issue.

- **Task** — An executable unit of work that lives on a Kanban Board under an Issue. A
  Task binds together an Agent Profile, an Executor Profile, and a Worktree, and moves
  through a defined lifecycle from creation to review to completion.

- **Board** — The Kanban surface on which Tasks are administered. A Board arranges Tasks
  in columns representing lifecycle states and can be scoped to a single Issue or span
  many Issues.

## Execution and isolation

- **Worktree** — The isolated Git working copy created for a single Task, so that
  concurrent Tasks never interfere with one another's files or branches.

- **Executor** — The runtime environment in which an Agent runs: a local process, a
  Docker container, an SSH-connected remote host, or a cloud runner.

- **Executor Profile** — A reusable, named configuration describing an Executor.

## Agents and sessions

- **Agent** — An external AI coding-agent command-line tool (for example Claude Code,
  Codex, Gemini CLI) that GateControl drives to perform work.

- **Agent Client Protocol (ACP)** — The open, standard protocol GateControl uses to
  connect to Agents, analogous to how the Language Server Protocol standardised editor
  tooling.

- **Agent Profile** — A reusable, named configuration for an Agent: which tool, which
  model, its connected tools, its authentication and billing mode, and its concurrency
  limit.

- **Authentication Mode** — How an Agent is billed and authenticated: **Subscription**
  (using a personal Claude Pro/Max plan) or **API Key**.

- **Session** — A single run of an Agent against a Task, producing a Conversation, a
  stream of events, and a set of proposed changes. Sessions can be reviewed and resumed.

- **Conversation** — The recorded exchange between a user, GateControl, and an Agent
  within a Session.

## Workflows

- **Workflow** — A repeatable, multi-step process that chains Agents and human decisions
  together. Workflows are designed and monitored as a visual node graph.

- **Workflow Step** — A single node in a Workflow: an Agent action, a human review gate,
  a condition, or a fork/join.

- **Gate** — A Workflow Step that pauses execution until a human approves, rejects, or
  provides input (human-in-the-loop).

- **Run** — A single execution of a Workflow, whose live progress is overlaid on the
  Workflow's visual graph.

## Review and change

- **Diff** — The set of file changes an Agent proposes, presented for human review before
  they are accepted.

- **Review** — The human step of inspecting a Diff and approving, rejecting, or requesting
  changes before anything is merged.

- **Snapshot** — A redacted, shareable export of a Task's Conversation and outcome.

## Platform

- **Local Deployment** — GateControl running entirely on one machine for a single user.

- **Hosted Deployment** — GateControl running as a shared, multi-user service.

- **Integration** — A connection to an external service (issue tracker, chat, source host)
  that GateControl reads from or writes to.

- **Setup Workflow (Onboarding)** — The guided, resumable, self-verifying process that
  prepares a Workspace for use on first run and can be re-run later to add or change
  configuration.

- **GitHub CLI (`gh`) / GitLab CLI (`glab`)** — The official command-line tools GateControl
  drives to perform GitHub and GitLab integration: authentication, Issue synchronisation, and
  branch and pull/merge request creation.

- **Pull Request / Merge Request** — The change-integration mechanism of a source host: a
  pull request on GitHub, a merge request on GitLab. GateControl creates them from accepted
  Task changes.

- **tRPC** — The typed request/response protocol the SPA uses for queries and mutations
  against the backend HTTP API.

- **`openapi.json`** — The generated OpenAPI document describing the backend HTTP API,
  exported from the tRPC routers and published as a build artifact for external consumers and
  tooling. Covers the HTTP API only, not the realtime channel.

- **WebSocket channel** — The live, bidirectional connection between the SPA and the backend
  that streams agent activity and state changes outward and carries terminal input and
  steering inward.
