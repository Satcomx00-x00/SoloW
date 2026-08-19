# F18 — First-Run Onboarding & Setup Workflow

**Status:** Draft · **Owner:** Product · **Maturity:** Core · **Last reviewed:** 2026-08-17

## Summary

Onboarding is a guided **Setup Workflow** that prepares a Workspace for use. Rather than
leaving a new user to discover configuration screens on their own, GateControl walks them
through the essential steps as an ordered, resumable, self-verifying sequence — connecting
source hosts, repositories, and integrations; creating at least one Agent Profile and one
Executor Profile; choosing a billing mode; and confirming the setup works with a small
verification Task. The Setup Workflow uses the same guided, step-based, resumable model as
user-authored Workflows ([F03](./F03-workflow-designer.md)), so getting started and running
work share one mental model.

## Jobs served

- **J6 — Control cost** (billing mode is chosen during setup).
- **J10 — Operate with confidence** (a verified, complete configuration before real work).
- Foundational: a completed Setup Workflow is what makes every other job reachable.

## User stories

- As a first-time user, I want to be guided through getting set up, so I can start using the
  product without hunting through settings.
- As a user, I want the setup to skip what I have already configured, so re-running it is
  safe and quick.
- As a user, I want to leave setup and come back without losing progress, so I am not forced
  to finish in one sitting.
- As a user, I want the setup to confirm my configuration actually works, so I trust it
  before running real work.
- As an Operator, I want to re-run setup to add or change configuration later, so the
  Workspace stays correct as needs change.

## Functional requirements

- **FR-1** On first use of a Workspace, GateControl launches a guided Setup Workflow.
- **FR-2** The Setup Workflow is presented as an ordered sequence of steps with visible
  progress and completion state, using the same guided step model as
  [Workflows](./F03-workflow-designer.md) where it aids clarity.
- **FR-3** The Setup Workflow covers, at minimum, these steps:
  1. Name and confirm the **Workspace**.
  2. Connect **source hosts** (GitHub, GitLab) with a stored Personal Access Token,
     verified against the provider before it is stored as connected (see
     [F12](./F12-integrations.md), [Decision 0014](../decisions/0014-direct-api-source-integrations.md)).
  3. Connect one or more **Repositories** (see [F08](./F08-workspaces-repositories.md)).
  4. Configure optional **Integrations** (issue trackers, chat) (see [F12](./F12-integrations.md)).
  5. Create at least one **Agent Profile**, including its **Authentication & Billing Mode** —
     Subscription or API Key (see [F05](./F05-agent-executor-profiles.md), [F06](./F06-authentication-billing.md)).
  6. Create at least one **Executor Profile** (see [F07](./F07-execution-environments.md)).
  7. Run a **verification** step: a minimal Task confirming an Agent can run and produce a
     reviewable result.
- **FR-4** The Setup Workflow detects steps that are already satisfied and only prompts for
  what is missing, so it behaves as a checklist and is safe to re-run.
- **FR-5** The Setup Workflow is resumable: a user can leave and return without losing
  progress.
- **FR-6** The Setup Workflow can be re-run at any time from Settings to add or reconfigure.
- **FR-7** The Setup Workflow surfaces prerequisites — for example, that a GitHub/GitLab
  Personal Access Token authenticates successfully, and that the chosen agent tools are
  available and authenticated — and guides the user to satisfy them, without ever
  displaying secrets.
- **FR-8** Completing the Setup Workflow leaves the Workspace ready to create Issues and
  Tasks.

## Non-functional requirements

- **NFR-1** No step is a dead end: every step either completes, is skipped safely, or gives a
  clear action to unblock it.
- **NFR-2** Each step is independently verifiable, so the user always knows what is done and
  what remains.
- **NFR-3** Secrets entered during setup are handled per [F17](./F17-security-secrets.md) —
  stored encrypted and never displayed again.
- **NFR-4** Progress is durably recorded so setup survives interruption and resumes, matching
  the durability of Workflows (see [Decision 0004](../decisions/0004-durable-orchestration-engine.md)).

## States & rules

- The Setup Workflow is a system-provided Workflow template distinct from user-authored
  Workflows, but it shares their guided, resumable, verifiable nature.
- A Workspace is considered **Ready** when the Setup Workflow's required steps are complete;
  optional steps (extra integrations) can remain outstanding without blocking use.
- Re-running the Setup Workflow never destroys existing configuration; it only fills gaps or
  makes changes the user confirms.

## Edge cases & failure handling

- If a prerequisite command-line tool is missing or not authenticated, the relevant step
  clearly explains what to install or sign in to, and the Workspace can still proceed with
  the steps that do not depend on it.
- If the verification Task fails, the Setup Workflow surfaces the reason and points the user
  to the step likely responsible (for example, an unavailable Executor or an unauthenticated
  agent), rather than declaring the Workspace Ready.

## Out of scope

- The specific visual design of the guided steps (owned by Design).
- The mechanics of each Integration, specified in [F12](./F12-integrations.md).

## Related

- [F03 — Visual Workflow Designer & Monitor](./F03-workflow-designer.md)
- [F05 — Agent & Executor Profiles](./F05-agent-executor-profiles.md)
- [F06 — Authentication & Billing Modes](./F06-authentication-billing.md)
- [F12 — External Integrations](./F12-integrations.md)
- [Decision 0014 — Direct API GitHub/GitLab integrations](../decisions/0014-direct-api-source-integrations.md)
