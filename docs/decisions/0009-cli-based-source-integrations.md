# 0009 — Drive source-host integrations through official CLIs (gh, glab)

**Status:** Superseded by [0014](./0014-direct-api-source-integrations.md) for GitHub and GitLab · **Date:** 2026-08-17 · **Deciders:** Product, Architecture

> **2026-08-19:** For GitHub and GitLab specifically, this decision is superseded by
> [0014](./0014-direct-api-source-integrations.md) — a direct REST API client authenticated by
> a stored Secret, not the `gh`/`glab` CLIs. The reasoning below is kept for the record; see
> 0014 for why it changed. This record's pattern (drive the official CLI) may still be the
> right call for a future integration whose credential model doesn't already fit GateControl's
> Secret store — it just turned out not to fit GitHub/GitLab once issue #15 was built out.

## Context

GateControl integrates with GitHub and GitLab to synchronise Issues and to create branches,
pull requests (GitHub), and merge requests (GitLab) from accepted Task changes. Each of these
platforms offers an official command-line tool — **`gh`** for GitHub and **`glab`** for
GitLab — that already handles authentication (including device-flow login, credential
storage, and enterprise/self-managed instances), stays current with the platform, and
exposes the operations GateControl needs. This mirrors GateControl's existing pattern of
driving official command-line tools rather than reimplementing their behaviour: agents are
driven through their CLIs, and Claude subscription authentication is inherited from the agent
CLI's login.

## Decision

Implement **GitHub integration through the `gh` CLI** and **GitLab integration through the
`glab` CLI**. GateControl drives these tools for authentication, Issue synchronisation, and
branch and pull/merge request creation. Authentication can be inherited from an existing
`gh` / `glab` login, or established during onboarding (see
[F18](../features/F18-onboarding-setup-workflow.md)), the same way subscription authentication
is handled ([Decision 0005](./0005-subscription-authentication.md)).

## Considered options

- **Raw API client libraries per platform** — Rejected: reimplements authentication flows,
  enterprise/self-managed handling, and keeps pace with two evolving platform APIs; more
  surface to build and maintain.
- **Official CLIs `gh` and `glab` (chosen)** — reuse the platforms' own maintained tools for
  auth and operations; consistent with the "drive the CLI" pattern already used for agents;
  auth can be inherited from an existing login.
- **A mix (CLI for auth, raw API for operations)** — Rejected: splits the integration across
  two mechanisms with two failure modes for no clear benefit.

## Consequences

- Positive: less integration code to maintain; robust, platform-maintained authentication
  including enterprise/self-managed instances; a consistent, familiar pattern across the
  product.
- Positive: onboarding can guide the user through `gh auth login` / `glab auth login`, and
  existing logins are reused (see [F18](../features/F18-onboarding-setup-workflow.md)).
- Negative: the CLIs must be installed and available in the relevant environment — a
  prerequisite the Setup Workflow checks and guides the user to satisfy (F18 FR-7).
- Negative: integration capability is bounded by what the CLIs expose; platform-specific
  terminology differs (GitHub pull requests versus GitLab merge requests) and is presented
  per host.
- Realises [F12](../features/F12-integrations.md) for GitHub and GitLab; other trackers
  (Jira, Linear, Sentry) are integrated by their own appropriate means.
