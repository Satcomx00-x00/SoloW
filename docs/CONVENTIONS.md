# Documentation Conventions

These conventions keep SoloW's documentation consistent, discoverable, and
maintainable. They apply to every file under `docs/`.

## Docs-as-Code

- Documentation is stored in the repository alongside the product and is version-controlled.
- Changes to documentation follow the same review workflow as changes to the product.
- A change to product behaviour and its documentation belong in the same change set.

## File and folder naming

- Folders group documents by **purpose** (`product`, `features`, `architecture`, `decisions`).
- Feature specifications are prefixed with a stable identifier (`F01`, `F02`, …) that
  never changes once assigned, so cross-references remain valid.
- Architecture documents follow the arc42 section order (`01`–`10`).
- Decision records are numbered sequentially (`0001`, `0002`, …) and are immutable once
  accepted; a superseded decision is marked, not deleted.

## Document structure

Every substantial document begins with a short header:

- **Status** — Draft, Reviewed, or Accepted.
- **Owner** — the role accountable for the document's accuracy.
- **Last reviewed** — the date the content was last verified.

## Writing style

- Use plain, precise language; prefer the shortest sentence that is still exact.
- Define every domain term in the [Glossary](./glossary.md) and use it consistently.
- State requirements as observable behaviour, not as implementation.
- Separate **functional** requirements (what the system does) from **non-functional**
  requirements (how well it does it — performance, security, reliability, usability).
- Where a document describes a choice with meaningful trade-offs, record the choice as an
  [Architecture Decision Record](./decisions/README.md) and link to it.

## Diagrams

- Diagrams are described in text and, where drawn, use text-based, version-controllable
  formats so they diff cleanly and never drift from the prose beside them.
- Architecture diagrams follow the [C4 model](https://c4model.com) levels: System Context,
  Container, and Component.

## Requirement identifiers

- Functional requirements within a feature specification are numbered (`FR-1`, `FR-2`, …).
- Non-functional requirements are numbered (`NFR-1`, `NFR-2`, …).
- Identifiers are stable and referenced from tests, decisions, and the roadmap.

## Maintenance

- Each feature specification names an owner responsible for keeping it current.
- Decision records are reviewed roughly one month after acceptance to compare the
  expected consequences against reality.
- Superseded content is marked with its replacement, never silently removed.

## Contribution and release rules

In force until 1.0 ([0031](./decisions/0031-focus-on-the-solo-power-user.md)).

- **Feature freeze.** Only fixes and the items in the [Roadmap](./ROADMAP.md) ship. A new
  capability waits for 1.0, however small.
- **Weekly releases.** A release is cut once a week, not per merge. Database migrations and API
  changes are batched into those planned releases, and dependencies are upgraded on purpose, in
  their own change, never as a side effect.
- **Main is always green.** Do not merge on red; the release is gated on the verify run
  ([0021](./decisions/0021-commits-decide-the-version.md)), which includes the full end-to-end
  suite and the control check. When main goes red anyway, fixing it — or reverting the change
  that broke it — comes before any other merge. A known-failing test is not left on main to be
  read past: it is fixed, or removed with the reason in the commit. A flaky test counts as a
  failing one. Run the web app's unit tests with `make test` (batched by
  `scripts/test-batches.ts`), the same way the pipeline does.
