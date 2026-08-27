# F13 — Collaboration & Sharing

**Status:** Draft · **Owner:** Product · **Maturity:** Core · **Last reviewed:** 2026-08-17

## Summary

SoloW lets users share what agents did so teammates can learn from, review, or build
on it. The primary mechanism is a redacted, shareable Snapshot of a Task's Conversation and
outcome.

## Jobs served

- **J9 — Collaborate and share.**

## User stories

- As a user, I want to share a clean record of how an agent solved a Task, so a teammate can
  learn from it.
- As a user, I want sensitive details removed from a shared record, so I do not leak secrets.
- As a Team Lead, I want a reusable Workflow to be shareable, so my team adopts it.

## Functional requirements

- **FR-1** A user can export a Task's Session as a **Snapshot**: a shareable record of the
  Conversation and outcome.
- **FR-2** A Snapshot is **redacted**: secrets and sensitive details are removed before it is
  shared.
- **FR-3** A user can share a Snapshot through a shareable link or an external destination
  (see [F12](./F12-integrations.md)).
- **FR-4** A user can export and import a Workflow definition so processes can be shared
  (see [F03](./F03-workflow-designer.md)).
- **FR-5** In hosted deployments, sharing respects Workspace access boundaries
  (see [F16](./F16-platform-deployment.md)).

## Non-functional requirements

- **NFR-1** Redaction is applied before any export leaves the user's control
  (product [NFR-4](../product/03-product-requirements.md), [NFR-7](../product/03-product-requirements.md)).
- **NFR-2** Sharing something externally is always an explicit, confirmed user action.

## States & rules

- A Snapshot is derived from a Session's Conversation at a point in time; it does not change
  when the Session later does.
- Nothing is shared externally without an explicit user action.

## Edge cases & failure handling

- If redaction cannot be confidently applied, the export is withheld and the user is warned
  rather than sharing potentially sensitive content.

## Out of scope

- The specifics of any external sharing destination, covered by [F12](./F12-integrations.md).

## Related

- [F03 — Visual Workflow Designer & Monitor](./F03-workflow-designer.md)
- [F11 — Sessions & Conversations](./F11-sessions-conversations.md)
- [F16 — Platform, Deployment & Multi-Tenancy](./F16-platform-deployment.md)
- [F17 — Security & Secrets](./F17-security-secrets.md)
