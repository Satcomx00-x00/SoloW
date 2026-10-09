# F14 — Analytics & Reporting

**Status:** Draft · **Owner:** Product · **Maturity:** Core · **Last reviewed:** 2026-08-17

## Summary

SoloW reports on how much work is getting done and how, so users and operators can
understand throughput, harness activity, and the balance between subscription and metered
billing.

## Jobs served

- **J10 — Operate with confidence.**

## User stories

- *(Later — team use.)* As a Team Lead, I want to see how many Tasks we complete and how, so I understand our
  throughput.
- As an Operator, I want to see how harnesses split between subscription and API-key billing,
  so I manage cost.
- As a user, I want to see how much parallel work ran without collisions, so I trust the
  isolation.

## Functional requirements

- **FR-1** SoloW reports completed Tasks over time, per Workspace.
- **FR-2** SoloW reports harness activity: number of Sessions, harness turns, and Workflow
  Runs completed.
- **FR-3** SoloW reports the split of Harness activity between Subscription and API-key
  billing modes.
- **FR-4** SoloW reports concurrency: how many Tasks ran in parallel and how often work
  was Parked or queued.
- **FR-5** SoloW reports Workflow Run outcomes, including Runs successfully resumed
  after interruption.
- **FR-6** Reports can be scoped and filtered by Issue, Harness Profile, Executor Profile, and
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

## Outcomes page (finding A4)

The 1.0 slice of this feature, behind `ff-outcomes` (default ON), at `/outcomes` in the
sidebar's Workspace group. It reads only what the product already records (`task`, `session`,
`review`, `task_repository`, `session_usage`); nothing new is tracked. The definitions are on
`outcomesDto` in `@solow/contracts` and printed beside each figure:

- **Shipped**: Done, with an `approve` decision and a committed result branch. Dated by the latest
  approval; "as pull request" when an attachment has a change request, else a local commit
  (no remote, or Keep local). A Task dragged to Done without an approval is not shipped;
  `delivery_failed` and `partial_integration` are counted as approved but not delivered.
- **Attempt**: one round judged at the review gate. Attempts to approval are 1 plus the rejects
  and requests for changes before the latest approval, across all Sessions and Workflow Steps.
- **Run-to-approval rate** and **approved within two attempts** are over the Tasks first run in
  the window, leaving out the ones still running, parked or at review.
- **Spend**: tokens per Task, Harness Profile and billing mode. Cost is metered cost only: API-key
  turns priced from `MODEL_PRICES` in `@solow/core`; unknown models are counted as unpriced, and
  the billing mode is the Profile's current one.
- **Time to first pull request**: from the Workspace's creation to the first Task shipped as one.

Deleted Tasks are left out of every figure (they are purged after the retention window). Weeks
start on Monday, in UTC. FR-2, FR-4, FR-5 and FR-6 beyond the time window are not built; they
are Later ([0031](../decisions/0031-focus-on-the-solo-power-user.md)).

## Out of scope

- Financial billing reconciliation with a provider's invoice (owned by the provider).

## Related

- [F06 — Authentication & Billing Modes](./F06-authentication-billing.md)
- [F11 — Sessions & Conversations](./F11-sessions-conversations.md)
- [Product Requirements — Success metrics](../product/03-product-requirements.md)
