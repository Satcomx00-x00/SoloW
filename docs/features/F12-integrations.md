# F12 — External Integrations

**Status:** Draft · **Owner:** Product · **Maturity:** Core · **Last reviewed:** 2026-08-17

## Summary

Integrations connect GateControl to the tools teams already use: issue trackers to
synchronise Issues, source hosts to create branches and pull or merge requests, and chat to
notify people. GitHub and GitLab integrations are driven through their official
command-line tools — **`gh`** for GitHub and **`glab`** for GitLab — consistent with the
product's pattern of driving official CLIs (see
[Decision 0009](../decisions/0009-cli-based-source-integrations.md)). Integrations are
optional; the product functions fully without any of them.

## Jobs served

- **J2 — Organise agent work around issues.**
- **J9 — Collaborate and share.**

## User stories

- As a Team Lead, I want Issues to synchronise with our tracker, so GateControl reflects our
  real backlog.
- As a Reviewer, I want accepted changes to become a pull request, so they follow our normal
  merge process.
- As a user, I want to be notified in chat when a Task needs my review, so I do not miss it.

## Functional requirements

- **FR-1** GateControl integrates with issue trackers (GitHub, Jira, Linear, GitLab,
  Sentry) to synchronise Issues (see [F01](./F01-issue-management.md)).
- **FR-2** GateControl integrates with source hosts to create branches and pull requests
  (GitHub) or merge requests (GitLab) from accepted Task changes, driving the `gh` and
  `glab` command-line tools respectively (see [F08](./F08-workspaces-repositories.md),
  [F10](./F10-review-approval.md), [Decision 0009](../decisions/0009-cli-based-source-integrations.md)).
- **FR-2a** For GitHub and GitLab, GateControl performs authentication, Issue
  synchronisation, and branch and pull/merge request creation by driving `gh` and `glab`.
  Authentication may be inherited from an existing `gh` / `glab` login or established during
  onboarding (see [F18](./F18-onboarding-setup-workflow.md)).
- **FR-2b** GateControl checks that the required command-line tools are available and
  authenticated, and guides the user to install or sign in to them when they are not, without
  displaying secrets (see [F18](./F18-onboarding-setup-workflow.md) FR-7).
- **FR-3** GateControl integrates with chat (Slack) to send notifications
  (see [F15](./F15-notifications.md)).
- **FR-4** A user configures each Integration once at the Workspace level, providing the
  necessary credentials (stored per [F17](./F17-security-secrets.md)).
- **FR-5** Integrations are optional; every core capability works without them
  (product [NFR-14](../product/03-product-requirements.md)).
- **FR-6** GateControl reports the health of each Integration and surfaces failures clearly.

## Non-functional requirements

- **NFR-1** An unavailable Integration degrades gracefully: dependent features show stale or
  reduced state rather than failing the product.
- **NFR-2** Integration credentials are stored encrypted and never displayed after entry.

## States & rules

- Each Integration is Workspace-scoped and reusable across Issues and Tasks.
- Canonical data owned by an external system (for example, an Issue's source fields) is not
  silently overwritten; conflicts are surfaced (see [F01](./F01-issue-management.md)).

## Edge cases & failure handling

- If an Integration's credential expires, dependent actions pause with a clear
  re-authentication prompt rather than failing silently.
- If a source host rejects a pull request creation, the failure is reported and the accepted
  changes are preserved for retry.

## Out of scope

- The specific field mappings of each external tool (configuration detail).

## Related

- [F01 — Issue Management](./F01-issue-management.md)
- [F13 — Collaboration & Sharing](./F13-collaboration-sharing.md)
- [F15 — Notifications](./F15-notifications.md)
- [F17 — Security & Secrets](./F17-security-secrets.md)
- [F18 — First-Run Onboarding & Setup Workflow](./F18-onboarding-setup-workflow.md)
- [Decision 0009 — CLI-based source-host integrations (gh, glab)](../decisions/0009-cli-based-source-integrations.md)
