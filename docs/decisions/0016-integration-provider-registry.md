# 0016 — Register integration providers by capability, rather than enumerating them

**Status:** Accepted · **Date:** 2026-08-23 · **Deciders:** Product, Architecture
**Extends:** [0014](./0014-direct-api-source-integrations.md) · **Builds on:** [F19](../features/F19-extension-contributions.md)

## Context

[0014](./0014-direct-api-source-integrations.md) built GitHub and GitLab as two drivers behind
one `ChangeProvider` interface, and issue #78 existed to prove the abstraction rather than
assume it. That worked: the interface is terminology-neutral, both drivers satisfy it, and the
domain never learns which host it is talking to.

What did not come with it is a way to *add* a third. The interface is open; the set of
providers is closed, in eight places at once:

| Where | What is fixed |
|---|---|
| `packages/contracts/src/scm.ts` | `scmProviderSchema`, `issueSourceSchema` — two `z.enum`s |
| `packages/scm/src/types.ts` | the `ScmProvider` union |
| `packages/scm/src/index.ts` | `providerFor()`'s `switch` |
| `apps/web/.../settings/integrations-section.tsx` | two hand-written `<SelectItem>`s and a placeholder naming both hosts |
| `apps/web/src/lib/issue-status.ts` | `ISSUE_SOURCE_LABELS`, a total `Record` over the union |
| `apps/orchestrator/.../task-run.ts` | `CLONE_USERNAME` — the https clone username per host |
| `apps/web/src/server/dal/repository.ts`, `issues-view.tsx` | per-provider branches |

Adding Gitea today means editing all eight and re-deriving `openapi.json`. None of the eight is
hard; together they are the reason nobody adds one.

Two facts make this more than a refactor.

**The enums are persisted.** `integration.provider` and `issue.source` are columns. Opening the
set means a row can hold an identifier the running build does not recognise — a provider that
was installed last month, a database restored into an older build. A closed `z.enum` currently
guarantees that cannot happen by refusing to parse, which in practice means the Issues page
fails to render rather than showing one unfamiliar badge.

**`ChangeProvider` is the wrong shape for half of what we want to add.** It has six methods and
assumes one host answers all of them. Gitea fits. Jira does not: it has issues and labels, and
no repositories, branches or change requests at all. Linear and Sentry are further off again. A
flat interface forces a Jira driver to implement four methods that throw, and forces every
caller to know which providers are safe to call them on — a per-provider domain, which is the
exact thing 0014's neutral vocabulary was written to prevent.

The product already has the answer to the first half of this in another area.
[F19](../features/F19-extension-contributions.md) defines contribution registries for the
command palette, the status bar and notification channels: a stable dotted id, a priority, a
visibility predicate, registration as the only way in. Its own doc comment names a plugin
manifest (#93) as the thing it is a seam for.

## Decision

Make an integration provider a **registered contribution declaring its capabilities**, in the
shape F19 already established, and let the rest of the product ask for a capability rather than
for a provider.

Three parts.

**1. A manifest, not an enum entry.** A provider registers a descriptor: its id (the F19 dotted
grammar — `github`, `gitlab`, `gitea`, `jira`), a display name, the connection fields it needs,
the capabilities it provides, and the driver that implements them. `providerFor()` becomes a
registry lookup; the settings picker, the source labels and the clone username are read off the
descriptor instead of being maintained beside it.

**2. Capabilities, not one interface.** `ChangeProvider` splits along the lines the providers
themselves fall on:

- `issues` — list and read issues and their labels.
- `repositories` — list repositories, branches, and clone metadata.
- `changeRequests` — list, and later open, change requests.

A descriptor declares which it provides and supplies only those. GitHub and GitLab declare all
three and are unchanged in behaviour. Gitea declares all three. Jira declares `issues` alone and
is not asked for a branch by anything. Callers resolve *providers that can do X* — "the trackers
this Workspace can import issues from" — so a capability nobody has is an empty list rather than
a method that throws.

**3. Unrecognised identifiers degrade, they do not refuse.** The persisted columns accept the id
grammar rather than a fixed enum. A stored id with no registered provider behind it renders as
itself, unstyled and inert — the row is still readable, its issue still has a title, and nothing
can be synced through a provider that is not there. This is F19's own rule for an arrangement
naming a contribution nothing registers, applied to a column instead of a preference.

Providers stay **in this repository and are registered at build time**. Discovery of packages
installed out-of-tree, and the sandbox that untrusted third-party code would need, are both
deliberately excluded — see *Out of scope*.

## Considered options

- **Keep the enums; add each provider by hand (status quo)** — Rejected. It works and it is
  honest about its cost, but the cost is paid on every addition, in eight files that have no
  reason to know about each other, and it gives no answer at all to a provider that is not an
  SCM.
- **One registry, one flat `ChangeProvider` (chosen shape without capabilities)** — Rejected.
  It solves the eight-files problem and leaves the Jira problem untouched: every non-SCM driver
  implements four throwing methods, and every caller grows a check for which providers are safe.
  Choosing this now would mean revisiting the interface the first time a tracker is added, which
  is the same work done twice.
- **Capability registry, providers registered at build time (chosen)** — one place to add a
  provider, no closed set anywhere, and a shape a non-SCM tracker fits without lying. The
  registration is the seam a loader would later plug into.
- **Runtime loading of out-of-tree provider packages** — Deferred, not rejected. It is a small
  addition *on top of* this decision (discover, validate a manifest, register) and a large one
  without it. Doing it first would mean designing the manifest twice.
- **Sandboxed third-party providers** — Deferred. See *Out of scope*; this is a security
  project, not an extension of this one.

## Consequences

- Positive: adding a provider is a driver file, a descriptor, and one registration. Nothing in
  `apps/web`, `apps/orchestrator` or `packages/contracts` changes to accommodate it.
- Positive: trackers that are not source hosts become expressible. Jira, Linear and Sentry stop
  being `wont-do` for structural reasons and become `not yet` for scheduling ones — which is a
  product decision, not an architectural one. F12's stated scope is amended accordingly.
- Positive: registration becomes the only way a provider enters the product, which is the
  precondition [F19](../features/F19-extension-contributions.md) named for a plugin API and the
  only thing a future sandbox has to police.
- Negative: the persisted columns lose the guarantee that every stored value is one the build
  understands. Bought back by the id grammar and the degrade rule, and paid for deliberately —
  an unfamiliar badge is a better failure than a page that will not render.
- Negative: `openapi.json` stops enumerating the valid providers for `integration.connect`. The
  document describes a string with a pattern instead, and the list of what is actually installed
  moves to a runtime endpoint the settings UI already needs in order to draw its picker.
- Negative: one more indirection between a caller and a driver. Mitigated by the same discipline
  0014 used — the third provider is written as part of this work, to test the design rather than
  assume it.
- Realises the registry half of [F21](../features/F21-integration-providers.md); F19's
  contribution shape is reused rather than re-invented.

## Out of scope

- **Loading providers from outside this repository** — a `plugins/` directory, npm modules named
  in configuration, or anything discovered at start-up. This decision defines the manifest such a
  loader would read; it does not build one.
- **Running untrusted provider code.** A provider holds a Workspace's Personal Access Tokens and
  makes network calls on a user's behalf. Community-published drivers need declared permissions,
  isolation, and mediated access to secrets and the network before any of that is safe, and none
  of it follows automatically from a registry. It is its own decision.
- **Write-back** (`createChangeRequest`, `comment`, `readChecks`), which remains issue #71's.

## References

- Issue #15 — GitHub integration, and the provider interface GitLab is a driver for
- Issue #78 — GitLab as the design test for that interface
- Issue #93 — plugin manifest (the seam F19 and this decision both anticipate)
- [F19 — Extension Contributions](../features/F19-extension-contributions.md)
- [F21 — Integration Providers](../features/F21-integration-providers.md)
- `packages/core/src/registry.ts` — the contribution registry this reuses
- `packages/scm/src/types.ts` — the `ChangeProvider` interface being split
