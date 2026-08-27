# F21 — Integration Providers

**Status:** Draft · **Owner:** Platform · **Maturity:** Core · **Last reviewed:** 2026-08-23

## Summary

[F12](./F12-integrations.md) connects SoloW to GitHub and GitLab. This feature is about
everything *behind* that: how a provider is described, registered and resolved, so that adding a
third — Gitea, Jira, whatever a team already uses — is a driver and a descriptor rather than an
edit in eight files.

Two ideas carry it. A provider **declares what it can do** instead of being assumed to do
everything, so a tracker with issues and no repositories is expressible rather than forced to
implement four methods that throw. And the rest of the product **asks for a capability**, not
for a named provider: "the trackers this Workspace can import issues from" is a question with an
answer, where "GitHub or GitLab?" is a question that has to be rewritten every time the answer
changes.

The registration shape is [F19](./F19-extension-contributions.md)'s, reused rather than
re-invented — the same dotted ids, the same "registration is the only way in". That is what
makes this the seam a plugin loader would later stand on, without this feature having to build
one. See [Decision 0016](../decisions/0016-integration-provider-registry.md).

## Jobs served

- **J2 — Organise agent work around issues.** — the job [F12](./F12-integrations.md) serves,
  widened: issues can come from a tracker SoloW does not ship a driver for today.
- **J10 — Operate with confidence.**

## User stories

- As an Operator, I want to connect a self-hosted Gitea the same way I connect GitHub, so the
  host my team actually uses is not a second-class citizen.
- As an Operator, I want to import issues from a tracker that has no repositories, so where my
  work is described and where my code lives can be two different products.
- As an Operator, I want the connect form to ask for exactly what my provider needs, so I am
  not typing a base URL into a field my host does not use.
- As a developer, I want to add a provider by writing one driver, so the work is proportional
  to the provider and not to the codebase.
- As a user, I want a Workspace restored into an older build to still show me my Issues, so an
  unfamiliar provider costs me a badge rather than a page.

## Functional requirements

- **FR-1** A provider is described by a manifest: a stable id, a display name, the connection
  fields it requires, the capabilities it provides, and the driver implementing them.
- **FR-2** A provider id follows the same grammar as a contribution id (lowercase segments
  joined by `.` or `-`). An id is a compatibility surface: it is written into `integration.provider`
  and `issue.source`, so renaming one orphans the rows that carry it.
- **FR-3** A provider declares one or more capabilities from a closed set — `issues`,
  `repositories`, `changeRequests` — and supplies an implementation for each it declares, and
  for none it does not.
- **FR-4** Callers resolve providers **by capability**. Asking for a capability no installed
  provider declares yields an empty list, never a provider that fails when called.
- **FR-5** A registration whose id is already taken is refused; the registration already in
  place is kept. (Same rule as [F19](./F19-extension-contributions.md) FR-7, for the same
  reason.)
- **FR-6** The connect form is built from the chosen provider's manifest: its fields, their
  labels, and which are required. No surface hard-codes a provider's name or its field set.
- **FR-7** A provider that is not installed, but whose id appears in stored data, is rendered as
  its own id, inert. Nothing can be synced, imported or authenticated through it.
- **FR-8** Terminology stays neutral in the domain, as [F12](./F12-integrations.md) requires: a
  manifest may name its provider's own noun for display, and the domain still says **change
  request**.
- **FR-9** Every per-provider constant a caller needs — the https clone username, the API root
  convention, the label for an imported Issue's source — is read from the manifest, not from a
  table maintained beside it.

## Non-functional requirements

- **NFR-1** Adding a provider touches its own driver, its own descriptor and one registration.
  No file under `apps/web`, `apps/orchestrator` or `packages/contracts` changes to accommodate
  it.
- **NFR-2** Resolution is deterministic: the same registered providers produce the same order
  for the same query, independent of module load order.
- **NFR-3** A driver's failure is contained. A provider that throws on one call fails that call
  — it does not prevent other providers being listed, connected or synced.
- **NFR-4** Provider drivers are tested against recorded fixtures, never a live API
  (Principle VI), as [Decision 0014](../decisions/0014-direct-api-source-integrations.md)
  already requires of GitHub and GitLab.
- **NFR-5** A credential reaches only the driver of the provider it was stored for. A registry
  lookup is not an opportunity to hand a token to the wrong host (Principle IV).

## States & rules

- A provider is *registered* (known to the process), or not. There is no disabled state: a
  provider that should not be offered is not registered.
- An integration is *connectable* when its provider is registered and its manifest's required
  fields are satisfied; *connected* when its credential has authenticated at least once;
  *orphaned* when its stored provider id has no registered provider behind it.
- An orphaned integration is shown and can be deleted. It cannot be synced, re-authenticated,
  or used to import — every one of those needs a driver that is not there.
- Capability is a property of the provider, not of the connection: two Workspaces connecting the
  same provider get the same capabilities.
- A Repository can only be linked to an integration whose provider declares `repositories`. An
  Issue can only be imported from one that declares `issues`.

## Edge cases & failure handling

- **A stored provider id nothing registers** — the row renders with the id as its own label and
  no styling. This is the restored-database and uninstalled-provider case, and it is the reason
  the persisted columns take a pattern rather than an enum.
- **A manifest declaring a capability it does not implement** — refused at registration, loudly,
  at start-up. This is a programming error in a driver, and the honest moment to find it is
  before anything is connected.
- **A driver that throws on `authenticate`** — the connection is refused with the driver's own
  reason, and nothing is stored. A provider cannot be connected on the strength of having been
  registered.
- **A provider removed while integrations exist** — those integrations become orphaned (above).
  Their imported Issues keep their title, description and labels, because those are SoloW's
  copy; only the link back and the sync stop working.
- **Two providers claiming the same id** — the second registration is refused (FR-5) and the
  conflict is reported. Silently preferring either one would make behaviour depend on load
  order, which NFR-2 forbids.

## Out of scope

- **Discovering providers outside this repository.** This feature defines the manifest; a
  loader that reads one from an installed package is separate work
  ([Decision 0016](../decisions/0016-integration-provider-registry.md), *Out of scope*).
- **Running untrusted provider code**, and everything it requires — declared permissions,
  isolation, mediated access to secrets and the network. A provider holds Personal Access
  Tokens; community-published drivers are a security project of their own.
- **Which providers ship.** This feature makes a provider addable; whether SoloW carries a
  Jira driver is [F12](./F12-integrations.md)'s scope to state.
- **Write-back** — opening change requests, commenting, reading checks (issue #71). The
  `changeRequests` capability is declared read-side here and grows those methods there.
- **Per-provider webhooks and push-based sync.** Everything here is pull.

## Related

- [F12 — External Integrations](./F12-integrations.md)
- [F19 — Extension Contributions](./F19-extension-contributions.md)
- [F01 — Issue Management](./F01-issue-management.md)
- [F08 — Workspaces & Repositories](./F08-workspaces-repositories.md)
- [F17 — Security & Secrets](./F17-security-secrets.md)
- [Decision 0016 — Register integration providers by capability](../decisions/0016-integration-provider-registry.md)
- [Decision 0014 — Direct REST API source integrations](../decisions/0014-direct-api-source-integrations.md)
