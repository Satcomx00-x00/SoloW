# Feature Specifications

**Status:** Draft · **Owner:** Product · **Last reviewed:** 2026-08-17

This folder contains one specification per feature. Each is business-level: it describes
observable behaviour, not implementation. Every specification follows the same template so
readers always know where to find each kind of information.

## Feature index and status

Maturity: **Core** (required for parity with comparable tools) · **Edge** (SoloW
differentiator) · **Later** (planned after first release).

| ID | Feature | Maturity | Serves jobs |
|----|---------|----------|-------------|
| [F01](./F01-issue-management.md) | Issue Management | Core | J2 |
| [F02](./F02-kanban-task-administration.md) | Kanban Task Administration | Core | J1, J2 |
| [F03](./F03-workflow-designer.md) | Visual Workflow Designer & Monitor | Core / Edge | J3, J4, J8 |
| [F04](./F04-agent-orchestration.md) | Multi-Agent Orchestration | Core | J1, J7 |
| [F05](./F05-agent-executor-profiles.md) | Agent & Executor Profiles | Core | J1, J6, J7 |
| [F06](./F06-authentication-billing.md) | Authentication & Billing Modes | Edge | J6 |
| [F07](./F07-execution-environments.md) | Execution Environments | Core | J7 |
| [F08](./F08-workspaces-repositories.md) | Worktrees & Repositories | Core | J1 |
| [F09](./F09-integrated-workspace.md) | Integrated Review Workspace | Core | J5 |
| [F10](./F10-review-approval.md) | Review & Approval | Core | J5 |
| [F11](./F11-sessions-conversations.md) | Sessions & Conversations | Core | J8 |
| [F12](./F12-integrations.md) | External Integrations | Core | J2, J9 |
| [F13](./F13-collaboration-sharing.md) | Collaboration & Sharing | Core | J9 |
| [F14](./F14-analytics-reporting.md) | Analytics & Reporting | Core | J10 |
| [F15](./F15-notifications.md) | Notifications | Core | J4, J9 |
| [F16](./F16-platform-deployment.md) | Platform, Deployment & Multi-Tenancy | Core / Edge | J10 |
| [F17](./F17-security-secrets.md) | Security & Secrets | Core | J6, J10 |
| [F18](./F18-onboarding-setup-workflow.md) | First-Run Onboarding & Setup Workflow | Core | J6, J10 |
| [F19](./F19-extension-contributions.md) | Extension Contributions | Core | J4, J10 |
| [F20](./F20-agent-widgets.md) | Agent Widgets | Core | J4, J10 |
| [F21](./F21-integration-providers.md) | Integration Providers | Core | J2, J10 |
| [F22](./F22-source-control.md) | Source Control Panel | Core | J5, J10 |
| [F23](./F23-project-planning.md) | Project Planning | Core | J2, J3, J10 |

## Specification template

Every feature specification contains these sections:

1. **Summary** — one paragraph on what the feature is and why it exists.
2. **Jobs served** — the Jobs-to-be-Done from [product/02](../product/02-personas-and-jobs.md)
   this feature advances.
3. **User stories** — the concrete needs, phrased from the user's perspective.
4. **Functional requirements** — numbered, observable behaviours (`FR-n`).
5. **Non-functional requirements** — quality attributes specific to the feature (`NFR-n`),
   in addition to the product-wide ones.
6. **States & rules** — the states, transitions, and business rules that govern the
   feature.
7. **Edge cases & failure handling** — what happens when things go wrong.
8. **Out of scope** — what this feature deliberately does not do.
9. **Related** — links to other features, decisions, and glossary terms.
