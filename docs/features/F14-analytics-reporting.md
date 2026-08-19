# F14 — Analytics & Reporting

**Status:** Draft · **Owner:** Product · **Maturity:** Core · **Last reviewed:** 2026-08-17

## Summary

GateControl reports on how much work is getting done and how, so users and operators can
understand throughput, agent activity, and the balance between subscription and metered
billing.

## Jobs served

- **J10 — Operate with confidence.**

## User stories

- As a Team Lead, I want to see how many Tasks we complete and how, so I understand our
  throughput.
- As an Operator, I want to see how agents split between subscription and API-key billing,
  so I manage cost.
- As a user, I want to see how much parallel work ran without collisions, so I trust the
  isolation.

## Functional requirements

- **FR-1** GateControl reports completed Tasks over time, per Workspace.
- **FR-2** GateControl reports agent activity: number of Sessions, agent turns, and Workflow
  Runs completed.
- **FR-3** GateControl reports the split of Agent activity between Subscription and API-key
  billing modes.
- **FR-4** GateControl reports concurrency: how many Tasks ran in parallel and how often work
  was Parked or queued.
- **FR-5** GateControl reports Workflow Run outcomes, including Runs successfully resumed
  after interruption.
- **FR-6** Reports can be scoped and filtered by Issue, Agent Profile, Executor Profile, and
  time range.

## Non-functional requirements

- **NFR-1** Reporting reflects the same authoritative state used elsewhere, so numbers are
  consistent across the product.
- **NFR-2** Reporting never exposes secrets or redacted content.

## States & rules

- Reported figures derive from the recorded history of Tasks, Sessions, and Runs.
- The product's primary success metric (reviewed-and-accepted Task completion rate) is
  reportable here (see [Product Requirements](../product/03-product-requirements.md)).

## Edge cases & failure handling

- Where history is incomplete (for example, a very new Workspace), reports indicate limited
  data rather than showing misleading figures.

## Out of scope

- Financial billing reconciliation with a provider's invoice (owned by the provider).

## Related

- [F06 — Authentication & Billing Modes](./F06-authentication-billing.md)
- [F11 — Sessions & Conversations](./F11-sessions-conversations.md)
- [Product Requirements — Success metrics](../product/03-product-requirements.md)
