# Product Requirements

**Status:** Draft · **Owner:** Product · **Last reviewed:** 2026-08-17

This is the product-level requirements document. It states the high-level functional
capability areas and the cross-cutting non-functional requirements that apply to the
whole product. Detailed behaviour lives in the individual [feature specifications](../features/README.md).

## Goals

- Let a user run many AI coding agents in parallel, safely and under review.
- Organise all agent work around Issues, administered as Tasks on a Kanban board.
- Let users design and monitor multi-agent processes as visual Workflows.
- Support both subscription and API-key billing per agent.
- Run identically as a local single-user tool and as a hosted multi-user service.

## Non-goals

- Being a manual IDE, a model provider, or a general project-management suite.
- Requiring any external cloud service to function.

## Functional capability areas

Each area is fully specified in its own feature document.

| Area | Feature |
|------|---------|
| Issue tracking, native and synchronised | [F01](../features/F01-issue-management.md) |
| Kanban administration of Tasks under Issues | [F02](../features/F02-kanban-task-administration.md) |
| Visual Workflow design and monitoring | [F03](../features/F03-workflow-designer.md) |
| Multi-agent orchestration | [F04](../features/F04-agent-orchestration.md) |
| Agent and Executor Profiles | [F05](../features/F05-agent-executor-profiles.md) |
| Authentication and billing modes | [F06](../features/F06-authentication-billing.md) |
| Execution environments | [F07](../features/F07-execution-environments.md) |
| Worktrees and repositories | [F08](../features/F08-workspaces-repositories.md) |
| Integrated review workspace | [F09](../features/F09-integrated-workspace.md) |
| Review and approval | [F10](../features/F10-review-approval.md) |
| Sessions and conversations | [F11](../features/F11-sessions-conversations.md) |
| External integrations | [F12](../features/F12-integrations.md) |
| Collaboration and sharing | [F13](../features/F13-collaboration-sharing.md) |
| Analytics and reporting | [F14](../features/F14-analytics-reporting.md) |
| Notifications | [F15](../features/F15-notifications.md) |
| Platform, deployment, and multi-tenancy | [F16](../features/F16-platform-deployment.md) |
| Security and secrets | [F17](../features/F17-security-secrets.md) |
| First-run onboarding as a Setup Workflow | [F18](../features/F18-onboarding-setup-workflow.md) |

## Non-functional requirements

These apply across the whole product. Feature specifications may add stricter local
requirements but may not relax these.

### Reliability
- **NFR-1** In-flight Workflow Runs and Tasks survive an orchestrator restart and resume
  rather than restarting from the beginning.
- **NFR-2** A failure in one Task, Agent, or Executor must not corrupt another Task's
  Worktree or halt unrelated work.
- **NFR-3** Every state change to a Task, Session, or Run is recorded so its history can be
  reconstructed.

### Security & privacy
- **NFR-4** Secrets (API keys, subscription tokens, integration credentials) are stored
  encrypted and are never displayed after entry.
- **NFR-5** The product functions with no outbound telemetry.
- **NFR-6** In hosted deployments, a user can only see and act on the Workspaces they are
  granted access to.
- **NFR-7** Credentials are never exposed to the code an Agent runs.

### Performance & scale
- **NFR-8** The board and live views reflect state changes in near real time.
- **NFR-9** The system supports many concurrent Tasks bounded only by configured
  concurrency limits and available Executors.

### Cost control
- **NFR-10** Subscription-billed Agents respect a configurable concurrency cap, and quota
  exhaustion parks work rather than failing it or silently switching to metered billing.

### Usability
- **NFR-11** The state of any Task or Run is understandable at a glance without reading raw
  logs.
- **NFR-12** Destructive actions (discarding changes, deleting work) require confirmation.

### Portability
- **NFR-13** The same product runs locally and hosted, differing only in configuration.
- **NFR-14** No feature depends on a proprietary third-party service being present.

## Success metrics

- **Primary metric:** proportion of Tasks that reach completion with their changes reviewed
  and accepted by a human, measured per Workspace per week.
- **Supporting metrics:** number of parallel Tasks run without collisions; share of Agents
  running on subscription versus API-key billing; number of Workflow Runs completed;
  Runs successfully resumed after interruption.

## Open questions

- The default concurrency cap for subscription-billed Agents.
- Which external trackers are supported at first release versus later.
- Whether the desktop shell ships at first release or later.
