---
description: Scaffold a new Architecture Decision Record using MADR 4 (full) format at docs/adr/. Auto-numbers, links to the current commit, prompts for status, drivers, options, and consequences. The ADR becomes part of the project's durable memory — read by /speckit.context.refresh and enforced by /speckit.adr.audit.
handoffs:
  - label: Refresh context pack
    agent: speckit.context.refresh
    prompt: Re-render `.specify/memory/context-pack.md` so the new ADR is visible to the next AI session.
---

## User Input

```text
$ARGUMENTS
```

Parse from `$ARGUMENTS`:

| Token | Meaning | Default |
|---|---|---|
| First positional arg | Decision title (free-form phrase, will be slugified) | required |
| `--status <s>` | `proposed` / `accepted` / `rejected` / `deprecated` / `superseded` | `proposed` |
| `--phase <p>` | `P1` / `P2` / `P3` / `P4` | inferred from constitution |
| `--criticality <c>` | `Critical` / `High` / `Medium` / `Low` | `Medium` |
| `--supersedes <id>` | ADR ID this one replaces (e.g. `0023`) | none |
| `--rfc <path>` | Link to the originating RFC | none |
| `--owner <handle>` | Decision owner | git config `user.name` |

If the title is missing, ask for it before proceeding.

## Pre-Execution Checks

Check for `.specify/extensions.yml`. Look for hooks under `hooks.before_adr`. Apply standard hook-processing.

Verify `.specify/memory/constitution.md` exists. If not, abort with: `No constitution found. Run /speckit.constitution.scan first — ADRs reference constitution directives.`

## Outline

### 1. Resolve the ADR directory and next ID

Look for `docs/adr/` (create if missing). Find the highest existing `NNNN-*.md` file. The new ID is `NNNN + 1`, zero-padded to 4 digits. If the directory is empty, start at `0001`.

### 2. Slugify the title

`"Use Drizzle for the data layer"` → `0042-use-drizzle-for-the-data-layer.md`

Rules: lowercase, replace non-alphanumeric runs with `-`, strip leading/trailing `-`, cap at 60 chars.

### 3. Resolve metadata

Collect:
- Current git commit SHA (short, 7 chars)
- Current date in `YYYY-MM-DD`
- Constitution version from `.specify/memory/constitution.md` front-matter
- Phase: read from `--phase` or infer from the constitution's `current_phase` field

If `--supersedes <id>` is provided, locate the prior ADR file. Read its current `Status:` field. Verify the prior ADR exists.

### 4. Write the ADR file

Use this exact template (MADR 4 full):

```markdown
---
id: <NNNN>
title: <Title>
status: <status>
phase: <P1-P4>
criticality: <Critical | High | Medium | Low>
owner: <owner>
date: <YYYY-MM-DD>
commit: <short-sha>
supersedes: <NNNN or null>
superseded_by: null
rfc: <path or null>
constitution_refs:
  - <directive-id>  # e.g. BE.DAL.missing-server-only
tags:
  - <tag>
---

# ADR <NNNN>: <Title>

## Context and Problem Statement

<Describe the architectural problem this decision addresses. State the problem
as a question if possible. Include constraints, forces, and the system state
that makes this decision necessary now rather than later.>

## Decision Drivers

- <driver 1 — e.g. type-safety guarantees>
- <driver 2 — e.g. operational simplicity>
- <driver 3 — e.g. team familiarity>
- <driver 4 — e.g. migration risk>

## Considered Options

1. **<Option A>**
2. **<Option B>**
3. **<Option C>** *(if applicable)*

## Decision Outcome

**Chosen option**: "<Option X>".

**Rationale**: <Why this option beats the alternatives against the drivers
above. Reference any RFC, prototype, benchmark, or prior ADR that informs the
choice.>

### Confirmation

<How will we know this decision was correct? What signal (metric, audit rule,
test, post-incident review) confirms it? Set a review date if applicable.>

## Consequences

### Positive

- <consequence 1>
- <consequence 2>

### Negative

- <consequence 1 — including new risks introduced>
- <consequence 2>

### Neutral

- <new conventions teams must adopt>
- <documentation/training implied>

## Pros and Cons of the Options

### <Option A>

**Pros**:
- <pro>

**Cons**:
- <con>

### <Option B>

**Pros**:
- <pro>

**Cons**:
- <con>

### <Option C>

**Pros**:
- <pro>

**Cons**:
- <con>

## More Information

- Related ADRs: <links>
- Related RFCs: <links>
- Constitution sections enforced: <list of directive IDs>
- Migration plan: <link, or "n/a">
- Review date: <YYYY-MM-DD, or "n/a">
```

### 5. If `--supersedes` was passed, update the prior ADR

In the superseded ADR's front-matter:
- Set `status: superseded`
- Set `superseded_by: <new NNNN>`

Append a line at the end of its "More Information" section:
```
- Superseded by: [ADR-<new NNNN>](./<new-slug>.md) on <YYYY-MM-DD>
```

### 6. Update the ADR index

Maintain `docs/adr/README.md` as an index. If absent, create it:

```markdown
# Architecture Decision Records

This directory contains the project's Architecture Decision Records (ADRs)
in [MADR 4](https://adr.github.io/madr/) format. The records are the
durable rationale for choices that shape the codebase. They supersede
tutorials, blog posts, and AI suggestions — when a directive here conflicts
with one of those, the ADR wins until a new ADR is recorded that supersedes it.

## Index

| ID | Title | Status | Phase | Criticality | Date |
|---|---|---|---|---|---|
| [0001](./0001-...) | ... | accepted | P1 | Critical | 2026-01-04 |
```

Insert the new row in ID order (preserves chronology when sorted). If the new
ADR supersedes another, also update the superseded row's `Status` column.

### 7. Print the result

```
## ADR scaffold complete

**ID**: <NNNN>
**File**: docs/adr/<NNNN>-<slug>.md
**Status**: <status>
**Supersedes**: <prior ID or "none">

**Next steps**:
- Fill in the Context, Decision, and Consequences sections — the template
  has placeholders that /speckit.adr.audit will flag if left as TODOs.
- If status is `proposed`, open an RFC or discussion to socialize it before
  changing to `accepted`.
- Once `accepted`, run /speckit.context.refresh to surface it in
  `.specify/memory/context-pack.md` for the next AI session.
- If the decision changes a Critical directive, run /speckit.constitution.scan
  to refresh the constitution's Sync Impact Report.

**Audit check**: /speckit.adr.audit will scan code for patterns that
contradict accepted ADRs. Run it after implementing the decision to verify
the codebase reflects the ADR.
```

## Post-Execution Hooks

Check `.specify/extensions.yml` for `hooks.after_adr`. Apply standard hook-processing.
