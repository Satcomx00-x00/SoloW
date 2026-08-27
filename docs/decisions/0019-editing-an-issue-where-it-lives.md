# 0019 — Edit an imported Issue on the provider that owns it, never on the copy

**Status:** Accepted · **Date:** 2026-08-25 · **Deciders:** Product, Architecture
**Builds on:** [0016](./0016-integration-provider-registry.md), [0018](./0018-provider-owned-project-fields.md) ·
**Amends:** [F23](../features/F23-project-planning.md) *Out of scope* ·
**Enables:** [F23](../features/F23-project-planning.md) FR-13

## Context

[F23](../features/F23-project-planning.md) shipped with editing deliberately excluded: *"Editing
titles, descriptions or comments. They stay the provider's ([F01](../features/F01-issue-management.md))."*
[0018](./0018-provider-owned-project-fields.md) put the *project field* values on the provider
and made SoloW their mirror, and the exclusion followed the same instinct — if we do not
own the value, do not offer to change it.

Using the result made the gap plain. A planning table where the status can be changed but the
title cannot, where the assignee column shows a face and the way to change it is to open GitHub
in another tab, is a table that stops halfway. The operator's report was blunt about it, and it
was right: the point of a control plane is that the work is done in it.

The exclusion also conflated two different things — **owning a value** and **being able to change
it**. A mirror that cannot write is one design; a mirror that writes through to the owner is
another, and only the first was ever considered.

## Decision

**An imported Issue is edited by sending the change to the provider that owns it, and re-reading
what the provider then holds.** SoloW never becomes a second author of the value.

Concretely:

- A new capability, **`issueWrites`**, separate from `issues`. Reading a tracker and writing to it
  are different permissions and, for some providers, different products. A read-only mirror of a
  tracker nobody here may edit stays a coherent integration, and folding the write into `issues`
  would make it inexpressible.
- The capability carries an **`issueWrites` support declaration** — `writes` and `cannot`, both
  required, disjoint and together exhaustive — exactly as `projectFields` does for
  [0018](./0018-provider-owned-project-fields.md). An editor renders a control only for a field
  the provider declared it can hold, and renders the provider's own sentence where it cannot.
- **Every write answers with what the provider now holds**, never an acknowledgement and never
  the value that was sent. The mirror is updated from that answer.
- **A patch omits what it is not changing.** Absent and null are different instructions: `null`
  clears a milestone, absent leaves it. A form that posted itself whole would silently overwrite
  every field it did not draw.
- The pre-existing refusal in the *local* edit path stands: `issue.update` still answers
  `ISSUE_SOURCE_OWNED` for an imported Issue's title. That is not a contradiction — editing the
  **copy** remains wrong. What changed is that there is now a way to edit the original.

## Consequences

- Editing needs a token with write scope. Its absence is a refusal *before* the network, read off
  the provider's declaration, rather than a failure discovered at the first save.
- The editor reads the issue live when it opens, costing one request. A form built from the last
  poll opens on a value someone else changed an hour ago and saves over it with neither party
  seeing a conflict; this at least starts from the truth.
- Assignees and milestones are **not** mirrored into columns. They are read live by the surface
  that edits them, because a copy nothing refreshes between polls is the drift this decision
  exists to avoid.
- Two clients editing between reads is still last-write-wins, unchanged from
  [0018](./0018-provider-owned-project-fields.md) and recorded there as a known limit.

## Alternatives considered

**Edit locally and diverge.** Cheap, needs no write scope, and produces two truths about one
issue with nothing able to say which is right. Rejected: the mirror's entire value is that it
does not disagree with the provider.

**Edit locally and push later.** A queue, a conflict model and a reconciliation UI — a
synchronisation product inside a control plane. Rejected as far more machinery than the problem
justifies, and [0014](./0014-direct-api-source-integrations.md) already chose direct API calls
over a sync layer for the same reason.

**Fold the write into `issues`.** One fewer capability, and no way to describe a provider that
can be read and not written. Rejected for the reason [0016](./0016-integration-provider-registry.md)
exists: a capability the registry cannot express is a capability the product will assume.
