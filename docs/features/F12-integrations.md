# F12 — External Integrations

**Status:** Draft · **Owner:** Product · **Maturity:** Core · **Last reviewed:** 2026-08-20

## Summary

Integrations connect SoloW to the tools teams already use. **GitHub, GitLab and Gitea
ship today.** Which providers exist is no longer a property of this feature: a provider is a
driver and a manifest registered behind [F21](./F21-integration-providers.md), so adding a
fourth is proportional to the provider rather than to the codebase, and a tracker with issues
and no repositories — Jira, Linear — is now expressible rather than structurally excluded. What
SoloW *carries* is still a product decision, and today it carries three. A connected
Integration is what gives SoloW real Issues to work from (see
[F01](./F01-issue-management.md), which has no native "create Issue" path any more), and
keeps a linked Repository's branches and change requests (pull requests / merge requests)
visible alongside the Tasks that touch it.

Every provider is driven through the same terminology-neutral driver boundary
(`packages/scm`), split by capability so a provider supplies only what it actually has — a direct REST API client authenticated by a stored Personal
Access Token, not the `gh`/`glab` CLIs (see [Decision 0014](../decisions/0014-direct-api-source-integrations.md),
which supersedes [Decision 0009](../decisions/0009-cli-based-source-integrations.md) for this
pair). GitLab's merge requests and GitHub's pull requests both surface as a **change
request** — the domain never encodes one provider's noun. Integrations are optional; the
product functions fully without any of them, and behind the `ff-integrations` flag,
default OFF.

This feature also covers integration in the **opposite direction**: the external **MCP
server** (issue #16), which lets outside agents and scripts drive SoloW rather than
SoloW reaching out to them. It is the same product surface seen from the other side —
the MCP tools are *derived* from the same tRPC procedures the SPA calls and `openapi.json`
documents, so there is no second definition of any operation to drift. It sits behind its own
`ff-mcp` flag, default OFF.

## Jobs served

- **J2 — Organise agent work around issues.**
- **J9 — Collaborate and share.**

## User stories

- As a Team Lead, I want to import Issues from our existing tracker, so SoloW
  reflects our real backlog instead of a second, disconnected one.
- As a Reviewer, I want to see a Task's repository's open change requests and branches
  without leaving SoloW, so I have the full picture in one place.
- As an Operator, I want to connect a self-managed GitHub Enterprise or GitLab instance,
  not just the public SaaS hosts.

## Functional requirements

- **FR-1** SoloW integrates with GitHub and GitLab to import Issues (see
  [F01](./F01-issue-management.md)) and to display each linked Repository's branches and
  change requests.
- **FR-2** A user connects an Integration by selecting a provider (GitHub or GitLab), a
  stored Personal Access Token Secret (never a pasted-in-place value — Principle IV), and
  an optional base URL for a self-managed instance. The token is verified against the
  provider before the Integration is stored as connected, and connecting then automatically
  imports Repositories and their Issues — see FR-13.
- **FR-3** A user imports a Repository by picking one the Integration's token can see. The
  Repository is created already bound to the provider, recording its clone URL; no local
  clone has to exist first, and nothing is cloned at import time — the orchestrator clones
  it, authenticating with the Integration's token, the first time a Task runs against it.
  Importing a Repository, this way or automatically (FR-13), also imports its Issues.
- **FR-4** A user previews a linked Repository's open provider Issues and selects which to
  import; import is idempotent on `(Integration, external id)` — importing an id already
  imported is a no-op, not a duplicate.
- **FR-5** A user refreshes ("sync now") a linked Repository's change requests and
  branches on demand. v1 is manual/on-demand only; scheduled or webhook-driven sync is
  future work (issue #15 calls this out explicitly: design for webhooks, ship polling).
- **FR-6** SoloW does not currently write anything back to GitHub or GitLab — there
  is no status write-back, no comment posting, and no change-request creation yet (that is
  issue #71, gated on issue #7). An Integration's `writeBackEnabled` flag is stored, off by
  default, ready for when write-back is built, but nothing reads it yet.
- **FR-7** Integrations are optional; every core capability works without them (product
  [NFR-14](../product/03-product-requirements.md)).
- **FR-13** Connecting an Integration automatically imports the Repositories its token can
  see, up to 20 (the request is a single synchronous mutation the caller's browser blocks
  on, and there is no queue in apps/web to hand the rest off to — 20 keeps the worst case a
  bounded, watchable number of sequential provider calls while covering the common case of a
  handful of repositories per Workspace). Each imported Repository's Issues are imported
  the same way, whether the Repository arrived through this automatic sync or through a
  manual `importRepository` call. One Repository failing to import does not abort the
  batch: `connect`'s result reports every visible Repository's outcome individually
  (`imported`, `failed` with a reason, or `skipped_over_cap`), and the mutation itself still
  succeeds as long as the Integration connected. This is additive automation — the manual
  `listExternalRepositories` / `importRepository` / `listExternalIssues` / `importIssues`
  procedures (FR-3, FR-4) are unchanged and are how an operator finishes what the cap left
  out, or re-syncs by hand later.

### External MCP server (issue #16)

- **FR-8** SoloW exposes an MCP endpoint at `/api/mcp` over Streamable HTTP, answering
  a POST as either `application/json` or a single-message SSE stream, and opening a
  server→client SSE stream on GET.
- **FR-9** The MCP tool definitions are derived from the tRPC procedures — name, input schema
  and read/write classification all read off the router that generates `openapi.json`. Adding
  a procedure adds a tool; no operation is defined twice.
- **FR-10** Three namespaces are deliberately withheld from the tool surface: `secret` (a
  token must not be able to plant a credential — Principle IV), `mcpToken` (a token must not
  mint further tokens or undo its own revocation), and `stream` (a SPA WebSocket ticket an MCP
  client cannot use).
- **FR-11** An MCP request authorises through *the same* middleware as the SPA, by resolving
  the token to a Workspace and then calling the router's own caller. There is no second
  authorisation path — Workspace scoping, feature flags and rate limits are enforced once.
- **FR-12** The Owner issues and revokes scoped tokens (`read` or `read_write`). A token value
  is displayed exactly once at issue time; it is stored only as a SHA-256 hash, so a lost token
  is reissued rather than recovered. Revocation takes effect on the token's next request, and a
  revoked token is refused indistinguishably from an unknown one.

### Discovery, bounded (issue #82)

- **FR-13** Every list a discovery tool reads — `issue.list`, `task.list`, `repository.list`
  and the two profile lists — is **paged**, and a caller that names no `limit` receives
  `PAGE_SIZE_DEFAULT` rows rather than the whole table. The bound is a property of the
  contract, not a courtesy the caller may forget: these procedures are tools by construction
  (FR-9), and an unbounded one spends an agent's context listing four hundred rows to answer a
  question about three.
- **FR-14** Paging is a **keyset cursor** over `(createdAt, id)`, never an offset. These tables
  are written by the poll, the orchestrator and the person reading at the same time, and a row
  created between two pages shifts every offset after it — the reader then skips a row without
  either page looking wrong. The id is in the cursor because a sync writes a batch of rows in
  one millisecond, and a tie makes the ordering partial.
- **FR-15** The cursor is opaque, and a cursor that does not parse is read as no cursor: a
  stale bookmark answers with the first page rather than failing the list.
- **FR-16** A cursor carries no authority. It is a value the caller hands back, so the
  Workspace scope is re-applied on every page — a cursor from one Workspace cannot walk into
  another's rows (Principle V).
- **FR-17** SoloW's own screens read these lists with `PAGE_SIZE_MAX`, and a surface that
  *counts* states a floor (`500+`) rather than a number the read cannot support.

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
- A Repository belongs to at most one Integration; `externalFullName` and `integrationId`
  are set together, at import, and cleared together when the Integration is disconnected.
- Disconnecting an Integration removes what only it could produce — the synced branches and
  change requests — unlinks its Repositories, and keeps imported Issues, which are work
  items Tasks point at.
- Canonical data owned by an external system (an imported Issue's title and description)
  is not edited in SoloW — see [F01](./F01-issue-management.md).

## Edge cases & failure handling

- If the token fails to authenticate at connect time, the Integration is not stored — the
  user sees the failure immediately rather than a silently broken connection discovered
  later.
- If a sync call fails (network, revoked token, rate limit), the Repository's branches and
  change requests keep showing their last-synced values with no partial overwrite.
- If a Repository fails during `connect`'s automatic sync (FR-13), it is reported by name in
  the mutation's result with its failure reason, not silently dropped, and the Repositories
  that did import are kept — a caller checking only whether `connect` itself succeeded still
  sees the correct outcome (the Integration connected); reading the per-Repository list is
  how a failed import is noticed and, if needed, retried by hand through
  `importRepository`.

## Out of scope

- Jira, Linear, Sentry, Slack (`wont-do` — issue #15).
- Pushing a branch or opening a change request from SoloW (issue #71).
- Webhook-driven or scheduled sync (v1 is on-demand only).
- Queued or background auto-sync: `connect`'s automatic Repository/Issue import (FR-13) is
  synchronous and capped at 20 Repositories; there is no job queue in apps/web to route the
  rest through, so a Workspace connecting an account with more than 20 repositories finishes
  the remainder through the manual picker, not a background process.
- MCP prompts, resources, and sampling — SoloW has none to offer, and advertising
  capabilities the server does not have makes clients probe endpoints that only ever fail.
- Per-procedure MCP token permissions. Scope is `read` / `read_write`, mirroring the
  query/mutation split the router already makes; a finer catalogue is additive later.
- Task-scoped session MCP (issue #15's row 75) — the same token-issuing mechanism with a Task
  id bound in, deliberately left until there is a caller for it.
- The specific field mappings beyond title/description/state/branch/author (configuration
  detail).

## Related

- [F01 — Issue Management](./F01-issue-management.md)
- [F08 — Workspaces & Repositories](./F08-workspaces-repositories.md)
- [F13 — Collaboration & Sharing](./F13-collaboration-sharing.md)
- [F17 — Security & Secrets](./F17-security-secrets.md)
- [Decision 0014 — Drive GitHub/GitLab integrations through their REST APIs directly](../decisions/0014-direct-api-source-integrations.md)
- [Decision 0009 — CLI-based source-host integrations](../decisions/0009-cli-based-source-integrations.md) (superseded for GitHub/GitLab)
