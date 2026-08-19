# F12 — External Integrations

**Status:** Draft · **Owner:** Product · **Maturity:** Core · **Last reviewed:** 2026-08-19

## Summary

Integrations connect GateControl to the tools teams already use. **Scope is GitHub and
GitLab only** — Jira, Linear, Sentry and Slack are `wont-do` (issue #15). A connected
Integration is what gives GateControl real Issues to work from (see
[F01](./F01-issue-management.md), which has no native "create Issue" path any more), and
keeps a linked Repository's branches and change requests (pull requests / merge requests)
visible alongside the Tasks that touch it.

GitHub and GitLab are driven through a single, terminology-neutral `ChangeProvider`
interface (`packages/scm`) — a direct REST API client authenticated by a stored Personal
Access Token, not the `gh`/`glab` CLIs (see [Decision 0014](../decisions/0014-direct-api-source-integrations.md),
which supersedes [Decision 0009](../decisions/0009-cli-based-source-integrations.md) for this
pair). GitLab's merge requests and GitHub's pull requests both surface as a **change
request** — the domain never encodes one provider's noun. Integrations are optional; the
product functions fully without any of them, and behind the `ff-integrations` flag,
default OFF.

## Jobs served

- **J2 — Organise agent work around issues.**
- **J9 — Collaborate and share.**

## User stories

- As a Team Lead, I want to import Issues from our existing tracker, so GateControl
  reflects our real backlog instead of a second, disconnected one.
- As a Reviewer, I want to see a Task's repository's open change requests and branches
  without leaving GateControl, so I have the full picture in one place.
- As an Operator, I want to connect a self-managed GitHub Enterprise or GitLab instance,
  not just the public SaaS hosts.

## Functional requirements

- **FR-1** GateControl integrates with GitHub and GitLab to import Issues (see
  [F01](./F01-issue-management.md)) and to display each linked Repository's branches and
  change requests.
- **FR-2** A user connects an Integration by selecting a provider (GitHub or GitLab), a
  stored Personal Access Token Secret (never a pasted-in-place value — Principle IV), and
  an optional base URL for a self-managed instance. The token is verified against the
  provider before the Integration is stored as connected.
- **FR-3** A user links a Repository to an Integration by its provider identifier
  ("owner/repo" for GitHub, "namespace/path" for GitLab).
- **FR-4** A user previews a linked Repository's open provider Issues and selects which to
  import; import is idempotent on `(Integration, external id)` — importing an id already
  imported is a no-op, not a duplicate.
- **FR-5** A user refreshes ("sync now") a linked Repository's change requests and
  branches on demand. v1 is manual/on-demand only; scheduled or webhook-driven sync is
  future work (issue #15 calls this out explicitly: design for webhooks, ship polling).
- **FR-6** GateControl does not currently write anything back to GitHub or GitLab — there
  is no status write-back, no comment posting, and no change-request creation yet (that is
  issue #71, gated on issue #7). An Integration's `writeBackEnabled` flag is stored, off by
  default, ready for when write-back is built, but nothing reads it yet.
- **FR-7** Integrations are optional; every core capability works without them (product
  [NFR-14](../product/03-product-requirements.md)).

## Non-functional requirements

- **NFR-1** An unavailable Integration degrades gracefully: dependent features show stale
  or reduced state rather than failing the product.
- **NFR-2** Integration credentials are stored encrypted (as a `scm_pat` Secret) and never
  displayed after entry; a decrypted token is held only for the single request that needs
  it.
- **NFR-3** GitHub/GitLab calls are covered by contract tests against a scripted fixture
  HTTP server — never a live API call in CI (constitution Principle VI).

## States & rules

- Each Integration is Workspace-scoped and reusable across every Repository it is linked
  to.
- A Repository is linked to at most one Integration; `externalFullName` and
  `integrationId` are set together.
- Canonical data owned by an external system (an imported Issue's title and description)
  is not edited in GateControl — see [F01](./F01-issue-management.md).

## Edge cases & failure handling

- If the token fails to authenticate at connect time, the Integration is not stored — the
  user sees the failure immediately rather than a silently broken connection discovered
  later.
- If a sync call fails (network, revoked token, rate limit), the Repository's branches and
  change requests keep showing their last-synced values with no partial overwrite.

## Out of scope

- Jira, Linear, Sentry, Slack (`wont-do` — issue #15).
- Pushing a branch or opening a change request from GateControl (issue #71).
- Webhook-driven or scheduled sync (v1 is on-demand only).
- The specific field mappings beyond title/description/state/branch/author (configuration
  detail).

## Related

- [F01 — Issue Management](./F01-issue-management.md)
- [F08 — Workspaces & Repositories](./F08-workspaces-repositories.md)
- [F13 — Collaboration & Sharing](./F13-collaboration-sharing.md)
- [F17 — Security & Secrets](./F17-security-secrets.md)
- [Decision 0014 — Drive GitHub/GitLab integrations through their REST APIs directly](../decisions/0014-direct-api-source-integrations.md)
- [Decision 0009 — CLI-based source-host integrations](../decisions/0009-cli-based-source-integrations.md) (superseded for GitHub/GitLab)
