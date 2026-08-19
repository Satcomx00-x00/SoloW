---
description: Regenerate `.specify/memory/context-pack.md` — the one-page snapshot every new AI session reads first. Aggregates ADR index, open RFCs, in-flight feature plans, recent CHANGELOG entries, active waivers, and the current project phase. Markdown-only; no external store.
---

## User Input

```text
$ARGUMENTS
```

Parse from `$ARGUMENTS`:

| Token | Meaning | Default |
|---|---|---|
| `--max-adrs <n>` | Show this many most-recent ADRs in the snapshot | `15` |
| `--max-changelog <n>` | Show this many most-recent CHANGELOG entries | `10` |
| `--include-proposed` | Include `proposed` ADRs and draft RFCs | on |
| `--dry-run` | Print the rendered content without writing | off |
| `--output <path>` | Override the output path | `.specify/memory/context-pack.md` |

## Pre-Execution Checks

Check for `.specify/extensions.yml`. Look for hooks under `hooks.before_context_refresh`. Apply standard hook-processing.

Verify `.specify/memory/constitution.md` exists. If not, warn — the context pack still renders, but downstream commands assume the constitution exists.

## Outline

### 1. Gather inputs

Read from the following sources (skip silently if absent):

| Source | Pull |
|---|---|
| `.specify/memory/constitution.md` front-matter | `version`, `current_phase`, `ratification_date`, `last_amended_date` |
| `docs/adr/*.md` front-matter | id, title, status, phase, criticality, date — sorted by id desc |
| `docs/rfcs/*.md` front-matter | id, title, status, owner, date |
| `.specify/plans/*.md` or `specs/*/plan.md` | feature name, phase, status (in-flight if not `completed`) |
| `CHANGELOG.md` (Keep-a-Changelog format) | `[Unreleased]` block + last released version block |
| `.specify/waivers.yml` | active and expired waivers |
| `.specify/sessions/*.md` (last 3 by mtime) | session title, date, summary line from front-matter |
| `.specify/queues/follow-ups.md` | top 10 unresolved items |

### 2. Render the context pack

Write to `.specify/memory/context-pack.md` (unless overridden):

```markdown
<!--
GENERATED FILE — do not edit directly.
Regenerate with: /speckit.context.refresh
Source of truth lives in: docs/adr/, docs/rfcs/, CHANGELOG.md, .specify/
-->

# Project Context Pack

> Read this first. Every section is a pointer to authoritative documents;
> never paraphrase it as if it were the source of truth. When the snapshot
> conflicts with the source, the source wins — regenerate this file.

**Generated**: <ISO-timestamp>
**Project phase**: <P1-P4>
**Constitution version**: <semver> (ratified <date>, last amended <date>)

## North star

<pull from constitution `mission:` or `north_star:` front-matter — one or two sentences>

## Accepted Architecture Decisions

The decisions below are binding. Code that contradicts them is a finding
(see `/speckit.adr.audit`).

| ID | Title | Phase | Criticality | Date |
|---|---|---|---|---|
| [ADR-0042](../../docs/adr/0042-...) | Use Drizzle for the data layer | P2 | Critical | 2026-05-12 |
| ... | | | | |

*(<N> total accepted; showing most-recent <max-adrs>. Full index:
`docs/adr/README.md`.)*

## Proposed (not yet binding)

| ID | Title | Owner | Opened |
|---|---|---|---|
| ADR-0051 | Adopt OpenTelemetry | @bob | 2026-05-20 |

## Open RFCs

| ID | Title | Status | Owner |
|---|---|---|---|
| [RFC-0007](../../docs/rfcs/0007-...) | Multi-tenant query scoping | draft | @carol |

## In-flight feature plans

These features have a plan but are not yet marked completed.

- `app/(billing)/subscription` — Phase P2 — owner @dave
  Plan: `.specify/plans/billing-subscription.md`

## Recent CHANGELOG entries

### [Unreleased]
- (Added) Drizzle migration scaffolds — ADR-0042
- (Changed) Server Action ownership checks now require explicit `actorId` arg

### [0.4.0] — 2026-05-18
- (Added) Org/workspace hierarchy — RFC-0004

## Active waivers

| Waiver ID | Owner | Expires | Reason |
|---|---|---|---|
| `ADR-0042/forbid#2` | @alice | 2026-07-01 | Legacy dashboard widget |

**Expired** (still firing as findings until remediated):

| Waiver ID | Owner | Expired |
|---|---|---|
| `BE.DAL.missing-server-only/1` | @bob | 2026-04-12 |

## Recent session logs

The last few AI sessions left these notes. Skim before starting work.

- 2026-05-24 — "Wire up billing webhooks" (.specify/sessions/2026-05-24-billing-webhooks.md)
- 2026-05-23 — "Add team invitations" (.specify/sessions/2026-05-23-team-invites.md)

## Top follow-ups carried from prior sessions

1. Re-add the `tenantId` index on `audit_log` (mentioned 2026-05-22)
2. Migrate `lib/dal/projects.ts` off Prisma (ADR-0042 follow-up)
3. ...

*(Full list: `.specify/queues/follow-ups.md`)*

## Source of truth

| Concern | File |
|---|---|
| Behavioral directives | `.specify/memory/constitution.md` |
| Operating rules for AI | `.specify/presets/nextjs/templates/agent-context.md` |
| Decisions | `docs/adr/` |
| Proposals | `docs/rfcs/` |
| Releases | `CHANGELOG.md` |
| Waivers | `.specify/waivers.yml` |
| Per-session notes | `.specify/sessions/` |
| Deferred items | `.specify/queues/follow-ups.md` |
```

### 3. Detect and report drift

After rendering, compute simple drift signals and append a final section
when any are non-empty:

```markdown
## Drift signals

- 2 ADRs accepted in the last 30 days lack an `audit:` block — they are
  enforced only by convention. Run /speckit.adr.audit and add rules.
- The constitution was last amended 124 days ago — consider re-running
  /speckit.constitution.scan.
- 3 feature plans have been in-flight for > 30 days. Stale plans become
  fiction.
- 2 waivers expired more than 14 days ago.
```

Drift signals are advisory; they do not affect exit code.

### 4. Print the summary

```
## Context pack refreshed

**File**: .specify/memory/context-pack.md
**Sections rendered**: <N>
**Drift signals**: <N>

**Next steps**:
- Reference this file at the top of CLAUDE.md / AGENTS.md / copilot-instructions
  so every new session picks it up automatically (see /speckit.docs.sync).
- Regenerate after any of: /speckit.adr.new, /speckit.adr.supersede,
  /speckit.constitution.scan, /speckit.session.close, CHANGELOG edits.
- Drift signals above are not auto-fixed — handle them explicitly.
```

If `--dry-run` is set, print the rendered content and the summary; do not write.

## Post-Execution Hooks

Check `.specify/extensions.yml` for `hooks.after_context_refresh`. Apply standard hook-processing.
