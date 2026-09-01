# 0022 — Relicense from AGPL-3.0-only to Apache-2.0

**Status:** Accepted · **Date:** 2026-09-01 · **Deciders:** Repository owner
**Affects:** every distribution of SoloW from v0.5.1 onward

## Context

SoloW shipped under **AGPL-3.0-only** — declared in two `package.json` files and nowhere else.

Two facts about that state, found while making this change:

**There was no licence text anywhere in the repository.** No `LICENSE` file, at the root or in the
published package. AGPL-3.0 §4 requires that a copy of the licence be conveyed with the work, so
every npm release so far has declared terms it did not deliver. Whatever licence the project
carries, that is a defect, and it is fixed here.

**The AGPL was doing more than it was being asked to do.** Its distinguishing feature is §13: a
user who interacts with a modified version *over a network* must be offered its source. For a
self-hostable control plane that people are meant to run for themselves, that clause converts every
private, modified deployment into a publication obligation. It deters exactly the adoption the
project wants — an operator evaluating it inside a company, a team wanting to patch one thing for
their own use — while protecting against a hosting scenario that is not what this is.

## Decision

**SoloW is licensed under Apache-2.0**, from v0.5.1 onward.

`LICENSE` carries the verbatim Apache-2.0 text (md5 `3b83ef96387f14655fc854ddc3c6bd57`, the
canonical file), and `NOTICE` carries the copyright and the caveat below. Both are declared in the
package's `files` so they reach npm: `LICENSE` would be included by npm's defaults anyway, `NOTICE`
would not.

Apache-2.0 rather than MIT because of what it adds beyond permissiveness: an **express patent
grant** from contributors, and termination of that grant for anyone who brings a patent claim.
For a tool that orchestrates agents and may be evaluated inside companies, that is the clause their
review will look for, and MIT is silent on it.

### What this does not relicense

`npx @satcomx00-x00/solow` installs one platform-specific optional dependency,
`@satcomx00-x00/solow-inngest-<platform>`, carrying the Inngest Dev Server binary. That binary is
Inngest's own work, redistributed unmodified under the **Server Side Public License**, with
upstream's `LICENSE.md` beside it. SoloW starts it as a separate process and neither links against
nor modifies it, so the SSPL governs that binary alone.

This is stated in `NOTICE` and in the package README because the honest sentence is not "SoloW is
Apache-2.0" but "SoloW is Apache-2.0, and it installs one thing that is not". Someone doing licence
review will find that out; better from the README than from a scan.

### Why this was the owner's to decide, and could be decided

Relicensing needs the agreement of everyone holding copyright in the work. Every human-authored
commit in this repository's history is the repository owner's (`Satcomx00`, `Satcom`); the
remainder are AI co-authorship trailers and the release bot. There is no third-party contributor
whose consent is missing.

The dependency tree does not force copyleft either. Of 2413 package manifests: 1694 MIT, 494
Apache-2.0, then ISC, BSD and 0BSD. No GPL and no AGPL anywhere. The only copyleft present is
LGPL-3.0 (`@img/sharp-libvips-*`, dynamically-linked native libraries, which LGPL permits inside a
differently-licensed program) and MPL-2.0 (`lightningcss`, whose copyleft is per-file).

## Considered options

- **Apache-2.0 (chosen).** Permissive, with the patent grant and the "state your changes"
  requirement. The cost is a longer text and the NOTICE obligation on redistributors.

- **MIT.** Shorter and marginally more permissive in practice. Rejected for the patent grant alone:
  it costs nothing to give and is the difference between "a lawyer glances at it" and "a lawyer
  asks questions".

- **MPL-2.0.** File-level copyleft — genuinely less restrictive than AGPL while keeping changes to
  existing files open. A reasonable middle, rejected because it still asks an adopter to reason
  about which files they touched, and the point of this change is to stop asking.

- **Stay on AGPL-3.0 and just add the missing LICENSE file.** The status quo made honest. Rejected
  by the owner, but worth recording: it is the option that best protects against someone else
  hosting SoloW as a service, and this decision gives that protection up deliberately.

## Consequences

- Positive: an operator can run, modify and deploy SoloW privately with no publication obligation.
  That is the adoption path AGPL §13 was closing.
- Positive: the published package finally carries the terms it claims. Every release before v0.5.1
  declared a licence whose text it did not include.
- Positive: contributors and users get an express patent grant in both directions.
- Negative: **this is effectively irreversible.** Every version published under Apache-2.0 stays
  available under it forever; a future move back to AGPL would bind only new releases, and anyone
  may fork from the last permissive one. That is the whole weight of this decision.
- Negative: nothing now requires a modified, network-hosted SoloW to publish its source. A
  competitor may run a closed fork as a service. Accepted knowingly.
- Negative: Apache-2.0 obliges redistributors to carry `NOTICE`, which is a real requirement that
  did not exist before and that downstream packagers can get wrong.
- Neutral: versions up to and including v0.5.0 remain licensed AGPL-3.0-only, since that is what
  they were published under. This decision is not retroactive and cannot be.

## Out of scope

- **Per-file copyright headers.** Apache-2.0's appendix suggests them; this repository has never
  used them and adding several hundred is a change of its own. `LICENSE` plus `NOTICE` is
  sufficient to license the work.
- **A CLA or DCO for future contributors.** Worth considering now that outside contribution is more
  likely, and a separate decision.
- **Relicensing the Inngest binary packages.** Not SoloW's to relicense; they carry upstream's
  terms and will continue to.
