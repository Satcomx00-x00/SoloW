---
description: Close out the current AI session by writing a structured session log at `.specify/sessions/<date>-<slug>.md`. Captures starting context, decisions taken, files touched, follow-ups, and waivers added — so the next session resumes with full state, not a fresh slate.
handoffs:
  - label: Refresh context pack
    agent: speckit.context.refresh
    prompt: Include the new session log in the next AI session's bootstrap context.
---

## User Input

```text
$ARGUMENTS
```

Parse from `$ARGUMENTS`:

| Token | Meaning | Default |
|---|---|---|
| First positional arg | Session title (free-form, will be slugified) | required |
| `--summary <text>` | One-line summary for the context pack | prompted if absent |
| `--no-follow-ups` | Skip the follow-ups prompt | off |
| `--commit <sha>` | Pin the session to a commit SHA | current HEAD |

If the title is missing, ask for it before proceeding.

## Pre-Execution Checks

Check for `.specify/extensions.yml`. Look for hooks under `hooks.before_session_close`. Apply standard hook-processing.

## Outline

### 1. Resolve the session file path

`.specify/sessions/<YYYY-MM-DD>-<slug>.md`

If the file already exists for today with the same slug, append a numeric suffix: `-2`, `-3`, etc.

### 2. Gather session signals

Collect automatically (best-effort; skip if unavailable):

| Signal | Source |
|---|---|
| Files touched | `git status --porcelain` + `git diff --name-only HEAD` since the previous session's `commit` field |
| Commits made | `git log <prev-session-commit>..HEAD --oneline` |
| New ADRs | `docs/adr/*.md` with `date:` ≥ session start date |
| New RFCs | `docs/rfcs/*.md` with `date:` ≥ session start date |
| New waivers | new entries in `.specify/waivers.yml` since the previous session |
| CHANGELOG diff | section of `CHANGELOG.md` modified since the previous session |
| New follow-ups | from `.specify/queues/follow-ups.md` since the previous session |

The "previous session" is the most recent file in `.specify/sessions/` by mtime.

### 3. Prompt for missing context

If `--summary` was not provided, ask: `One-line summary for the context pack:`

If `--no-follow-ups` was not set, ask:
- `Open follow-ups for the next session? (one per line, blank to finish)`
- For each, ask `Severity?` (`Critical` / `High` / `Medium` / `Low`)

Ask: `Any decisions taken that should be captured as an ADR? (y/N)`. If `y`, surface a list of recent changes that look like architectural decisions (e.g. a new dependency added, a directive interpretation chosen) and suggest running `/speckit.adr.new` for each.

### 4. Write the session log

```markdown
---
title: <Session Title>
date: <YYYY-MM-DD>
commit: <SHA at session close>
prev_session: <previous filename or null>
summary: <one-line summary>
agent: <agent identifier — e.g. claude-opus-4-7, gpt-4o>
duration_estimate: <if known>
---

# Session: <Session Title>

## Starting context

- Previous session: <link or "first session">
- Project phase at start: <P1-P4>
- Context pack version: <git SHA of `.specify/memory/context-pack.md` at start>

## What was done

<3–6 sentence narrative of the work performed. State outcomes, not steps. Link
to commits, ADRs, and RFCs created or changed.>

## Decisions taken

| Type | Reference | Note |
|---|---|---|
| ADR | [ADR-0042](../../docs/adr/0042-...) | Adopted Drizzle for the data layer |
| Inline | commit `<sha>` | Chose to put cache keys in `lib/cache/keys.ts` (below ADR bar) |

## Files touched

```
M  app/(billing)/page.tsx
A  lib/dal/subscriptions.ts
A  docs/adr/0042-use-drizzle-for-the-data-layer.md
D  prisma/schema.prisma
```

## CHANGELOG additions

```
### Added
- Subscription DAL with idempotent webhook handler

### Changed
- ORM swap from Prisma to Drizzle (ADR-0042)
```

## Waivers added

| ID | Owner | Expires | Reason |
|---|---|---|---|
| `ADR-0042/forbid#2` | @alice | 2026-07-01 | Legacy dashboard widget |

## Follow-ups for the next session

- [ ] **High** — Migrate `lib/dal/projects.ts` off Prisma (ADR-0042 follow-up)
- [ ] **Medium** — Re-add `tenantId` index on `audit_log`
- [ ] **Low** — Sweep `useEffect`+`fetch` patterns in `app/(marketing)/*`

## Open questions

- <question that should become an RFC, or that the next session must answer>

## What I would have done with more time

<short list — informs the next session about scope discipline>
```

### 5. Append follow-ups to the queue

For each follow-up captured in step 3:

Append a row to `.specify/queues/follow-ups.md`:

```markdown
- [ ] **<severity>** — <text> *(opened in [session](../../sessions/<file>) <YYYY-MM-DD>)*
```

Create the file with a header if it doesn't exist.

### 6. Update the context pack (advisory)

Print:
```
Reminder: run /speckit.context.refresh to surface this session in the
context pack consumed by the next AI iteration.
```

If `.specify/extensions.yml` has `hooks.after_session_close` invoking `speckit.context.refresh`, run it automatically.

### 7. Print the summary

```
## Session closed

**File**: .specify/sessions/<YYYY-MM-DD>-<slug>.md
**Files touched**: <N>
**Commits**: <N>
**Decisions captured**: <N> ADR + <N> inline
**Follow-ups queued**: <N>

**Next session bootstrap**:
- Will read `.specify/memory/context-pack.md` (refresh it now: /speckit.context.refresh)
- Will pick up follow-ups from `.specify/queues/follow-ups.md`
- Will see the new ADRs in `docs/adr/`
```

## Post-Execution Hooks

Check `.specify/extensions.yml` for `hooks.after_session_close`. Apply standard hook-processing.
