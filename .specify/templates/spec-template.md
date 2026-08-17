# Feature Specification: [FEATURE NAME]

**Feature slug**: `[feature-name]`
**Feature flag**: `ff-[feature-name]` (default: OFF)
**Feature branch**: `feat/[feature-name]`
**Created**: [DATE]
**Status**: Draft
**RFC PR**: [link — must be merged before implementation PR is opened]

**Input**: User description: "$ARGUMENTS"

---

## User Stories *(mandatory)*

<!--
  Each story is a binary, independently testable slice.
  Acceptance criteria must be yes/no verifiable — no "should", "ideally", "if possible".
  Prioritize by user value: P1 = blocks everything else, P3 = nice to have.

  Acceptance criteria use EARS syntax (Easy Approach to Requirements Syntax).
  Pick the pattern that fits; every criterion names an observable system response:
    Event-driven:   WHEN <trigger>, THE SYSTEM SHALL <response>
    State-driven:   WHILE <state>, THE SYSTEM SHALL <response>
    Unwanted:       IF <failure/abuse case>, THEN THE SYSTEM SHALL <response>
    Optional:       WHERE <feature/flag is present>, THE SYSTEM SHALL <response>
    Ubiquitous:     THE SYSTEM SHALL <response>
  A criterion that cannot be phrased in EARS is usually not testable — rewrite it
  until it is, or move it to Open Questions.
-->

### Story 1 — [Brief Title] (P1)

**As** [role from the project's real role set],
**I want** [action],
**so that** [benefit].

**Why P1**: [explain the value and why this is the most critical slice]

**Primary path**:
1. [step 1]
2. [step 2]
3. [step 3]

**Alternate paths**:
- [alternate: e.g. empty state, pagination end]

**Acceptance criteria** (EARS — binary, each verifiable yes/no):
- [ ] AC-001: WHEN [trigger], THE SYSTEM SHALL [observable response — UI or API]
- [ ] AC-002: IF [invalid input / failure case], THEN THE SYSTEM SHALL [error behavior]
- [ ] AC-003: WHILE [state, e.g. mutation pending], THE SYSTEM SHALL [behavior]

---

### Story 2 — [Brief Title] (P2)

**As** [role],
**I want** [action],
**so that** [benefit].

**Acceptance criteria** (EARS):
- [ ] AC-004: WHEN [trigger], THE SYSTEM SHALL [response]
- [ ] AC-005: IF [failure case], THEN THE SYSTEM SHALL [response]

---

[Add more stories as needed. Each story must be independently deployable and testable.]

---

## Non-Goals *(mandatory)*

What is explicitly out of scope for this feature:

- [Non-goal 1 — e.g. "Real-time collaboration (deferred to P3)"]
- [Non-goal 2 — e.g. "Mobile-native push notifications"]
- [Non-goal 3 — e.g. "Bulk export > 10k rows"]

---

## Edge Cases *(mandatory)*

- Empty state: what happens when [the list is empty / no data exists]?
- Max length: what happens when [a field exceeds its maximum]?
- Timeout: what happens when [the background job takes > N minutes]?
- Offline: what happens when [the client loses connectivity mid-action]?
- Unicode / emoji: what happens with [non-ASCII input in text fields]?
- Concurrent writes: what happens when [two users edit the same resource simultaneously]?
- Quota: what happens when [the org hits its plan limit]?

---

## RBAC Roles Affected

> Use the project's real role set (from the constitution / auth config) — do
> not invent roles the product does not have. For user-scoped (non-org)
> products, replace roles with owner-vs-other-user access rules.

| Role | Can do what |
|---|---|
| [role 1] | [list actions] |
| [role 2] | [list actions] |
| [role 3] | [list actions — typically read-only] |
| public / unauthenticated | [list actions — typically none] |

---

## Key Entities

- **[Entity 1]**: [what it represents, key attributes, relationships]
- **[Entity 2]**: [what it represents, relationships to other entities]

Tenant scoping: every entity must carry the project's tenant key (per the
constitution — e.g. `organizationId` for org-scoped products, `ownerId` for
user-scoped products) as a non-nullable FK. Single-tenant projects may waive
this with a constitution reference.

---

## Functional Requirements

Written in EARS syntax — a requirement that fits no EARS pattern is not yet testable:

- **FR-001**: THE SYSTEM SHALL [specific, verifiable capability]
- **FR-002**: WHEN [trigger], THE SYSTEM SHALL [specific, verifiable response]
- **FR-003**: IF [failure/abuse case], THEN THE SYSTEM SHALL [specific response]

Flag requirements where the spec is unclear:
- **FR-004**: THE SYSTEM SHALL [NEEDS CLARIFICATION: X not specified — options are A / B / C]

---

## Success Metrics *(mandatory)*

Measurable, time-bound, technology-agnostic:

| Metric | Target | Measurement |
|---|---|---|
| Adoption | ≥ X% of active orgs use the feature within 30 days | analytics event count |
| J7 retention | ≥ Y% of users who try it return within 7 days | cohort analysis |
| J30 retention | ≥ Z% retention at 30 days | cohort analysis |
| p95 latency | < N ms end-to-end on primary mutation | [tracing/metrics tool] |
| Error rate | < M% on primary endpoints | [error tracking / logs tool] |

---

## Rollback Thresholds

Revert the feature flag (set to OFF for all tenants) if:

- Error rate > [N]% over a 15-minute window
- p95 latency > [N ms] over a 15-minute window
- [Domain-specific threshold — e.g. "failed job rate > 5%"]

Flag OFF restores previous behavior without a deployment.

---

## Marginal Cost Estimate

| Resource | Per operation | At 10k ops/day | At 100k ops/day |
|---|---|---|---|
| Database rows | [+N] | [~Nk rows/day] | [~Nk rows/day] |
| Cache keys | [+N] | negligible | negligible |
| Background jobs | [+N] | [~Nk/day] | [~Nk/day] |
| Analytics events | [+N] | [~Nk/day] | [~Nk/day] |
| Storage (if files) | [+N bytes] | [~N GB/day] | [~N GB/day] |
| External API calls (LLM, email, …) | [+N / cost] | [~$/day] | [~$/day] |

---

## GDPR / Privacy Classification

| Data field | Classification | Retention | Basis |
|---|---|---|---|
| [field name] | Personal / Sensitive / Non-personal | [N days / until deletion] | [consent / contract / legitimate interest] |

Data minimization: collect only fields required for the feature. Provide deletion flow if personal data is stored.

---

## Assumptions

- [Assumption about target users — e.g. "Users have stable internet connectivity"]
- [Assumption about scope — e.g. "Mobile support is out of scope for v1"]
- [Dependency — e.g. "Requires the organization plan quota service to be available"]
- [Stack assumption — e.g. "an authenticated session is available on all protected routes"]

---

## Open Questions

1. [Decision needed before implementation — e.g. "Soft-delete or hard-delete?"]
2. [Decision needed — e.g. "Quota: per-org flat limit or per-plan tiered?"]

*(Delete this section if there are none before the RFC is approved.)*
