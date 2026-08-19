# 0014 — Drive GitHub/GitLab integrations through their REST APIs directly, not `gh`/`glab`

**Status:** Accepted · **Date:** 2026-08-19 · **Deciders:** Product, Architecture
**Supersedes:** [0009](./0009-cli-based-source-integrations.md) for GitHub and GitLab specifically

## Context

[0009](./0009-cli-based-source-integrations.md) chose to drive GitHub and GitLab integrations
through their official CLIs (`gh`, `glab`), reusing the CLI-driving pattern already used for
agents ([0003](./0003-agent-connection-protocol.md)). Issue #15 ("GitHub integration — and the
provider interface GitLab is a driver for") is the concrete specification this area was
actually built from, and its accepted design is a `ChangeProvider` interface authenticated by
a **stored Secret reference** (Principle IV) — it does not mention `gh`/`glab` at all. Building
against #15 surfaced three problems with the CLI approach that 0009 did not have in view:

- **Testability.** Issue #15's own Definition of Done requires "contract tests against a
  recorded fixture, no live API in CI" (constitution Principle VI). A fixture HTTP server is a
  few lines of `Bun.serve`; a fixture for a CLI binary's stdout/stderr/exit-code contract is a
  second thing to build and keep in sync with two tools GateControl does not control the
  release cadence of.
- **A runtime dependency GateControl cannot express in its own data model.** `gh auth login`
  and `glab auth login` store credentials in the CLI's own local state (a config file, the OS
  keychain) — a **process-local, host-local** credential. GateControl's credential model is a
  Workspace-scoped, encrypted `Secret` row (Principle IV; [0005](./0005-subscription-authentication.md)
  established the same shape for agent credentials). Reusing an inherited CLI login means the
  integration's credential does not live in that model at all, and a hosted or multi-host
  deployment ([0008](./0008-data-store-strategy.md)) has no login to inherit.
- **Two credential shapes for the same PAT.** A user who already has a GitHub PAT would need
  to additionally run `gh auth login` and trust GateControl to find that state, rather than
  pasting the token once into the Secret store the rest of the product already uses for every
  other credential (subscription tokens, API keys).

## Decision

Implement `ChangeProvider` (issue #15) as a **direct REST API client** — `packages/scm`'s
`GithubProvider` (GitHub REST API v3) and `GitlabProvider` (GitLab REST API v4) — authenticated
by a Personal Access Token stored as a `scm_pat` Secret, decrypted only inside the request that
needs it (`decryptForScmSync`). No shell-out, no dependency on `gh`/`glab` being installed.

0009 is superseded **for GitHub and GitLab only**; nothing else changes. The "drive the
official CLI" pattern remains correct where 0009's own reasoning still applies — most notably
agents, whose CLIs are the product being integrated, not an API surface with its own stable,
documented contract.

## Considered options

- **Official CLIs `gh`/`glab` (0009's choice)** — Rejected here: the credential model mismatch
  and the CI-fixture cost above are structural, not incidental.
- **Direct REST API clients per platform (chosen)** — a stored Secret PAT authenticates a plain
  `fetch` call; testable against a fixture HTTP server; no external binary dependency; the same
  credential shape as every other integration in the product.
- **A mix (CLI for auth, raw API for operations)** — Rejected, same as 0009: two mechanisms,
  two failure modes, for a case where the API alone is sufficient.

## Consequences

- Positive: `packages/scm`'s provider tests run against `Bun.serve` fixtures with zero live
  network calls, satisfying Principle VI without a CLI-mocking layer.
- Positive: one credential shape (`Secret`) across every integration the product has, agents
  included — no second place a token can live.
- Positive: no install-and-authenticate prerequisite for GitHub/GitLab specifically; the Setup
  Workflow's `gh`/`glab` preflight check (F18 FR-7) no longer applies to this pair (it may still
  apply to any future CLI-driven integration).
- Negative: GateControl re-implements the slice of GitHub/GitLab's REST surface it needs
  (issues, pulls/merge requests, branches) rather than inheriting a maintained CLI — bounded by
  what `packages/scm`'s drivers cover, same tradeoff 0009 accepted in the other direction.
- Negative: GitHub Enterprise Server / self-managed GitLab base-URL handling (`gh`/`glab` solve
  this themselves) is now GateControl's own concern — handled by `ScmCredential.baseUrl` and a
  per-provider API-root convention (`/api/v3`, `/api/v4`).
- Realises [F12](../features/F12-integrations.md) for GitHub and GitLab; other trackers remain
  out of scope (`wont-do`, per issue #15's stated scope).

## References

- Issue #15 — GitHub integration — and the provider interface GitLab is a driver for
- `packages/scm/src/types.ts` — the `ChangeProvider` interface
- `packages/scm/src/github.ts`, `packages/scm/src/gitlab.ts` — the two drivers
