---
description: Generate a one-page handoff document for the next engineer or AI session. Distinct from `/speckit.context.refresh` (which is the bootstrap snapshot) — handoff is human-curated, captures "what's hot right now", "what's broken but parked", and "the trap I almost fell into". Stored at `.specify/handoffs/<date>-<slug>.md`.
---

## User Input

```text
$ARGUMENTS
```

Parse from `$ARGUMENTS`:

| Token | Meaning | Default |
|---|---|---|
| First positional arg | Handoff slug (e.g. `pre-release-0.5`) | `<date>` |
| `--from <session>` | Anchor the handoff to a specific session log | most recent |
| `--audience <who>` | `next-ai` / `human-engineer` / `oncall` | `next-ai` |

## Pre-Execution Checks

Check for `.specify/extensions.yml`. Look for hooks under `hooks.before_handoff`. Apply standard hook-processing.

## Outline

### 1. Resolve the anchor session

Load the most recent file in `.specify/sessions/` (or the one named in `--from`). Pull `commit`, `summary`, `follow-ups`, and `decisions taken`.

### 2. Gather hot-state signals

- Branches with uncommitted changes — from `git status`
- Stashes — from `git stash list`
- Last 5 commits — from `git log --oneline -5`
- Currently failing CI checks (if accessible) — link to last CI run
- Open PRs touched by the same author/agent in the last 14 days (link only)
- Open ADRs in `proposed` status
- Open RFCs in `draft` status
- Top 10 entries from `.specify/queues/follow-ups.md`
- Active waivers expiring within 14 days
- Modified files not on `main` (`git diff main...HEAD --name-only`)

### 3. Prompt for curated content

Ask the user (skip any with a flag like `--no-prompt`):

1. **In-flight work** — "What is the next person actively in the middle of? (Files to open first, mental model of the change.)"
2. **Known traps** — "Anything that bit you this session that the next person should be warned about?"
3. **Parked but not abandoned** — "Code or branches that are paused but should not be deleted?"
4. **Don't-touch list** — "Anything that looks broken but is intentionally that way?"
5. **First moves for the next session** — "If I asked you 'what do I do in the first 15 minutes', what would you say?"

### 4. Write the handoff file

```markdown
---
date: <YYYY-MM-DD>
audience: <next-ai | human-engineer | oncall>
anchor_session: <session filename>
anchor_commit: <SHA>
branch: <branch name>
---

# Handoff — <slug>

> Distinct from the context pack: the context pack is comprehensive and
> regenerated. This is opinionated and hand-written. Read the context pack
> first, then this.

## TL;DR

<3–4 sentences. State of the world, what's mid-flight, what's blocked.>

## First 15 minutes

1. <concrete first action — file to open, command to run>
2. <second action>
3. <third action>

## What I was in the middle of

<Files, mental model, what "done" looks like. Be specific about names of
functions and files.>

## Known traps

- <trap with how to avoid it; reference the commit where you almost made the mistake>

## Parked work (don't delete)

- Branch `feat/multitenancy-attempt-2` — abandoned approach #1; the rationale
  lives in ADR-0044's "Rejected options".
- File `lib/dal/_drafts/audit.ts` — scaffolded but not wired; needed for
  follow-up #4 below.

## Don't touch

- `lib/legacy/cron-job.ts` — looks broken, isn't; runs once daily and
  intentionally swallows errors until ADR-0049 lands.

## Top follow-ups

1. **High** — <text> — *next step*: <one sentence>
2. **High** — <text>
3. **Medium** — <text>

*(Full queue: `.specify/queues/follow-ups.md`)*

## Hot-state signals (auto-collected)

- Uncommitted changes: <N> file(s)
- Stashes: <N>
- Failing CI: <last CI link or "n/a">
- Proposed ADRs awaiting decision: <list>
- Draft RFCs awaiting review: <list>
- Waivers expiring within 14 days: <list>

## Trust but verify

Before merging anything I shipped this session, re-check:
- <test that should pass>
- <UI flow to walk through>
- <metric/log to glance at>
```

### 5. Print the summary and a copy-paste handoff prompt

```
## Handoff written

**File**: .specify/handoffs/<YYYY-MM-DD>-<slug>.md
**Audience**: <audience>

**Bootstrap prompt for the next AI session** (paste at the start):

> Read `.specify/memory/context-pack.md`, then `.specify/handoffs/<filename>`,
> then `.specify/queues/follow-ups.md`. Begin with the "First 15 minutes"
> section. Do not modify the don't-touch list without an ADR.
```

## Post-Execution Hooks

Check `.specify/extensions.yml` for `hooks.after_handoff`. Apply standard hook-processing.
