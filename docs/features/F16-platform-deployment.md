# F16 — Platform, Deployment & Multi-Tenancy

**Status:** Draft · **Owner:** Product / Operator · **Maturity:** Core / Edge · **Last reviewed:** 2026-08-17

## Summary

SoloW runs as both a local single-user tool and a hosted multi-user service, from one
product. Local deployment is trivial to start; hosted deployment adds shared access, teams,
and multi-tenancy. Users own their compute and data in both modes, with no required cloud
service and no telemetry.

## Jobs served

- **J10 — Operate with confidence.**

## User stories

- As a Solo Power User, I want to run SoloW on my own machine with minimal setup, so I
  can start immediately.
- As a Team Lead, I want a shared, hosted instance my team can use together, so we
  collaborate.
- As an Operator, I want to control who can access which Workspace, so shared use is safe.

## Functional requirements

### Local deployment
- **FR-1** SoloW runs entirely on one machine for a single user, storing its data and
  Worktrees locally.
- **FR-2** Local deployment requires no external service and sends no telemetry
  (product [NFR-5](../product/03-product-requirements.md), [NFR-14](../product/03-product-requirements.md)).

### Hosted deployment
- **FR-3** SoloW runs as a shared, multi-user service using the same product and
  capabilities as local deployment (product [NFR-13](../product/03-product-requirements.md)).
- **FR-4** Hosted deployment supports multiple users organised into Workspaces, with each
  user able to access only the Workspaces they are granted.
- **FR-5** An Operator can manage members and their access to Workspaces.
- **FR-6** Hosted deployment isolates each Workspace's data, work, and secrets from others.

### Common
- **FR-7** The same features behave identically across deployment modes, differing only in
  configuration.
- **FR-8** SoloW is distributed so a user can obtain and run it without a proprietary
  gatekeeper, consistent with its open-source nature.
- **FR-9** A signed-in member can view and toggle their Workspace's feature flags from Settings
  (issue #21), not only via `scripts/flag.ts` on the machine running the instance. Every flag is
  ON by default; a flag exists so a capability can be switched *off* when it misbehaves, not so
  it can be switched on before use. Turning `ff-core-program` off is confirmed before it takes
  effect: it is a self-lockout, disabling most of the rest of Settings along with the core Task
  loop for everyone in that Workspace until it is turned back on. Settings' own flags section
  stays reachable with every flag off, so the switch can always be reversed in the app; the
  out-of-app recovery path is `bun run flag enable ff-core-program`.

### Emptying a Workspace
- **FR-10** A signed-in member can delete their Workspace's data from Settings, at one of two
  scopes. `work-data` removes Projects, Issues, Tasks, Sessions, transcripts, reviews and the
  Worktree directories they created, and keeps the setup — Repositories, Harness and Executor
  Profiles, Secrets, Integrations, MCP servers, Skills, tokens and preferences — so the
  Workspace can run work again immediately. `everything` additionally removes that setup.
- **FR-11** Neither scope removes the account, the Workspace row, or the harness catalog. A
  factory-reset Workspace is in the state a fresh installation is in, and its owner is still
  signed in.
- **FR-12** A reset is refused unless the request carries the Workspace's current name, compared
  against the name the server holds rather than the one the client was showing.
- **FR-13** A reset reports what it removed — rows per table, and how many Worktree directories
  are being removed from disk. There is no undo and nothing enters History; the report is the
  only account of what happened.
- **FR-14** A reset removes rows belonging to no other Workspace.

### Appearance and new-Task defaults
- **FR-15** A signed-in member can choose light, dark, or following the machine's own setting.
  The choice is stored against their account, applies before the first paint of a later load,
  and is theirs alone — another member of the same Workspace is unaffected.
- **FR-16** A signed-in member can choose the Harness Profile and the Executor Profile a new
  Task starts with. Both remain editable on every Task form; the setting decides only what the
  form opens on, and either may be left unset so the question is asked each time.
- **FR-17** A stored default naming a Profile that has since been deleted is reported as unset,
  and the Task form asks again, rather than preselecting a Profile the Task could not be created
  with.
- **FR-18** A Task created from an Issue is named after that Issue by default, whether the Issue
  was picked in the form or supplied by the page the form was opened from. A title the member
  typed is never replaced.

### Choosing the Project in view
- **FR-19** The Project a member is working in is chosen from the navigator's title, from any
  screen, and switching keeps the section they were on. The Project in view is carried in the
  address, so a reload, a shared link and the back button all resolve to the same Project.

## Non-functional requirements

- **NFR-1** No feature is available only in one deployment mode except those that are
  inherently multi-user (members and access control).
- **NFR-2** In hosted deployment, access control is enforced on every action, not only in
  the interface (product [NFR-6](../product/03-product-requirements.md)).
- **NFR-3** Moving from local to hosted does not require re-learning the product.

## States & rules

- A Workspace is the unit of tenancy and access in hosted deployment.
- Secrets and Profiles remain Workspace-scoped in both modes.
- Appearance and new-Task defaults are **per member**, not per Workspace: two people sharing a
  hosted Workspace each get their own.
- Emptying a Workspace is **per Workspace**, not per member: it removes shared rows, and every
  member of that Workspace sees the result.

## Edge cases & failure handling

- If a user loses access to a Workspace, in-flight work they started continues under the
  Workspace's ownership; the user simply can no longer see or act on it.
- A reset requested from a tab whose Workspace was renamed after the page loaded is refused: the
  name it carries is compared against the stored one, so the gate fails closed rather than acting
  on a Workspace the requester was no longer looking at.
- A reset does not wait for the Worktree directories to be removed. The rows are deleted in one
  transaction and the Orchestrator is asked afterwards to remove the files, best effort — an
  Orchestrator that is not running leaves directories behind, and never leaves half-deleted rows.
- A member whose stored theme cannot be cached in their browser (private window, blocked site
  data) still gets the theme they chose; it simply arrives a moment after the first paint.

## Out of scope

- The specific infrastructure used to host the service (an operational concern).
- The optional desktop shell (a distribution detail, planned as Later).
- Exporting a Workspace before emptying it. A reset deletes; it does not archive. Taking a copy
  of the data first is the operator's own business, and pretending otherwise would make the
  confirmation gate sound recoverable when it is not.
- Per-Workspace or per-organisation branding. Appearance is a member's own setting.

## Related

- [F17 — Security & Secrets](./F17-security-secrets.md)
- [Architecture — Deployment View](../architecture/07-deployment-view.md)
- [Decision 0002 — Local-first with a path to hosted](../decisions/0002-technology-stack.md)
- [Decision 0008 — SQLite locally, Postgres hosted](../decisions/0008-data-store-strategy.md)
