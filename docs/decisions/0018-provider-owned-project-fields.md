# 0018 — Mirror the provider's own planning fields, rather than owning a project model

**Status:** Accepted · **Date:** 2026-08-25 · **Deciders:** Product, Architecture
**Builds on:** [0016](./0016-integration-provider-registry.md), [0014](./0014-direct-api-source-integrations.md) ·
**Enables:** [F23](../features/F23-project-planning.md)

## Context

[F23](../features/F23-project-planning.md) asks for GitHub Projects' table — title, status,
assignees, linked pull requests, sub-issue progress, size, estimate, iteration, start and target
dates — working identically for GitHub **and** GitLab.

GitLab has no GitHub Projects. That is the whole problem, and it is not a small one: Projects v2
is a general typed-field store attached to issues, and GitLab's nearest primitives are scoped
labels, iterations, weights, milestones and epics — a fixed set, several of them paid tiers.

So the field values have to live *somewhere*, and there are only two somewheres: this product, or
the provider.

## Decision

**The provider owns the field values. GateControl mirrors them, and declares per provider which
field types that provider can express.**

For GitHub, the mirror is direct: Projects v2 fields and their values, read and written through
the GraphQL API. For GitLab, the same fields are **synthesised from scoped labels** —
`status::in-progress`, `priority::high`, `size::XL` — which is the convention GitLab teams
already use for exactly this purpose, plus the native primitives where they exist (iterations,
weight, milestone dates, epics).

The consequence that shapes everything else: **the two providers cannot express the same field
set**, and pretending otherwise is how this feature would rot. A scoped label can carry a
single-select. It cannot carry a number, a date, or an iteration without GitLab's paid tiers.

That is what [0016](./0016-integration-provider-registry.md)'s capability registry is for, and
this decision extends it rather than inventing a second mechanism: a provider declares the field
**types** it can express, the table asks for a capability rather than for a provider, and a field
its provider cannot hold is rendered read-only with the reason stated — never silently dropped,
and never editable into a write that will fail.

A local cache of every mirrored value is kept, because a planning table that reads the network
per cell is not a table. The cache is explicitly *not* the authority: a write goes to the
provider and the value is re-read from the answer.

## Considered options

- **Mirror the provider (chosen).** Values stay visible and editable where the team already
  works — a status changed here shows up in GitHub Projects, and in GitLab as the scoped label
  everyone's boards already filter on. The cost is two models to hold, and a ceiling set by the
  weaker provider.

- **GateControl owns the project model, providers supply only issues.** One model, identical on
  every provider, working with no external service at all — the closest fit to Principle VII, and
  rejected here deliberately: the planning would be invisible from GitHub and GitLab, so a team
  whose project managers live in GitHub Projects would be keeping two boards. Recorded because it
  remains the fallback if the mirror proves unmaintainable.

- **GitHub only.** Rejected by the requirement. It is also the option that quietly becomes true
  if the capability declaration is skipped and GitLab is treated as a degraded GitHub.

- **Own the model, write back optionally.** Rejected for now as the worst of both: it needs a
  conflict resolution story ("a person edited both sides between two polls") before it needs
  anything else, and that is a project of its own.

## Consequences

- Positive: nothing is trapped in GateControl. Uninstall it and the planning is still in GitHub
  Projects and in GitLab's labels, which is the same promise Principle VII makes about data.
- Positive: 0016's registry gains its second real consumer, and the "ask for a capability, never
  for a provider" rule is tested by a case that genuinely differs per provider rather than by two
  drivers that happen to match.
- Negative: **the feature is only as capable as each provider.** A GitLab Free workspace gets
  single-selects and no estimate field, and the table has to say so in words rather than showing
  an input that cannot save.
- Negative: latency and rate limits are now user-visible. Every edit is a round trip to a provider
  that rate-limits, which the local cache hides for reads and cannot hide for writes.
- Negative: a scoped-label convention is a convention. A team that names theirs `Status::Doing`
  rather than `status::in-progress` has to be able to say so, so the mapping is configuration.
- Negative: GateControl now writes to the provider's issues, where before it only read them
  (0014 established read-only PAT usage). The token scope required grows, and that has to be
  stated at connection time rather than discovered on the first failed write.

## Out of scope

- **Conflict resolution.** Last write wins, and the value is re-read from the provider's answer.
  Two people editing one field between two polls is a real case and not one this decision solves.
- **Creating projects on the provider.** GateControl mirrors a project that already exists; the
  provider's own UI is where one is created.
- **Writing back anything but field values** — titles, descriptions and comments stay the
  provider's, exactly as [F01](../features/F01-issue-management.md) already requires.
