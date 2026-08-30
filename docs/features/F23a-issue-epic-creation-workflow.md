# F23a — Create Issue & Create Epic from a Project (GitLab + GitHub)

**Status:** Design · **Depends on:** [F23 Project Planning](./F23-project-planning.md),
[Decision 0018](../decisions/0018-provider-owned-project-fields.md) · **Date:** 2026-08-30

## Problem

F23 made the Project a *read* surface: issues arrive on their own and provider-owned fields
are edited in place. What it never had is the one authoring action a planning table needs —
**create a new item**. And on GitLab specifically, two things are missing:

1. No way to create an **Issue** or an **Epic** on the provider from inside a Project.
2. A GitLab Project shows **fewer columns** than the same table on GitHub, because its field set
   is synthesised from whichever scoped labels happen to exist rather than from the canonical
   column set F23 FR-1 defines.

This feature adds the create workflow and closes the column gap, keeping the provider the
source of truth (writes go out, the stored value comes back — never the typed one).

---

## Part 1 — The create workflow

A single **`＋ New`** split-button sits top-right in the Project toolbar, immediately left of
`Adopt project` (mirrored projects) / `Repositories` (local projects). It has two entries:

- **New issue**
- **New epic** — shown only when the active Project resolves to a provider whose manifest
  declares `issueCreates.epics` (GitLab groups on a tier with epics). Otherwise the entry is
  present but disabled with the reason, so the capability difference is stated, never hidden
  (the same rule F23 FR-5 follows for unexpressible fields).

### Flow A — New issue

```
[Button ＋New ▸ New issue]
        │
        ▼
┌─ MODAL 1 · "Where" ──────────────────────────────┐   (skipped when the Project has exactly
│  • Repository picker (repos in this Project)      │    one repository — pre-selected)
│  • Provider + target shown read-only              │
│  [Cancel]                       [Next →]          │
└───────────────────────────────────────────────────┘
        │
        ▼
┌─ MODAL 2 · "Compose" ────────────────────────────┐
│  • Title            (required, 1–300)             │
│  • Description      (Markdown, optional)          │
│  • Assignees        (from listAssignableUsers)    │
│  • Labels           (from listLabels + create)    │
│  • Milestone        (from listMilestones)         │
│  • Parent epic      (optional; from listEpics —   │
│                      GitLab only, capability-gated)│
│  [← Back]                       [Create issue]    │
└───────────────────────────────────────────────────┘
        │
        ▼
ACTION 3 · POST to provider  (issue.createOnProvider mutation)
        │   GitLab:  POST /projects/:id/issues
        │   GitHub:  POST /repos/:owner/:repo/issues (GraphQL createIssue)
        ▼
ACTION 4 · Mirror the returned issue into the Workspace + attach to this Project
        │   (reuses the existing local-attach path; the row appears immediately —
        │    never the typed value, always what the provider stored)
        ▼
ACTION 5 · Optimistically insert the row, invalidate project.allItems,
           close the modal, and select/scroll to the new row.
        │
        ▼
[Row visible in the table + toast "Issue #<iid> created on <provider>"]
```

Error handling: a provider rejection (403, label that does not exist, assignee without access)
surfaces inline in Modal 2 with the provider's message; the modal stays open with the form
intact so nothing typed is lost.

### Flow B — New epic  (GitLab groups)

```
[Button ＋New ▸ New epic]
        │
        ▼
┌─ MODAL 1 · "Where" ──────────────────────────────┐
│  • Group picker (groups the token can create in)  │   (skipped when only one group is reachable)
│  [Cancel]                       [Next →]          │
└───────────────────────────────────────────────────┘
        │
        ▼
┌─ MODAL 2 · "Compose epic" ───────────────────────┐
│  • Title            (required)                    │
│  • Description      (Markdown, optional)          │
│  • Labels           (group labels)                │
│  • Start / due date (epics DO carry dates, unlike │
│                      issues — see Decision 0018)  │
│  [← Back]                       [Create epic]     │
└───────────────────────────────────────────────────┘
        │
        ▼
ACTION 3 · POST /groups/:id/epics
        ▼
ACTION 4 · Mirror the epic as a parent row; existing children re-nest under it on next sync
        ▼
ACTION 5 · Insert the epic row (collapsed, 0% rollup), invalidate, toast.
```

Epics are a **group** object, not a project one — the driver translates, the domain stays
neutral (an epic is "a parent planning item"). GitHub declares `issueCreates.epics = false`;
its parity concept is the sub-issue, tracked separately.

---

## Part 2 — GitLab column parity

**Target:** a GitLab Project shows the **exact** F23 FR-1 column set, column-for-column, as a
GitHub Project — never a shorter table with nothing to explain the difference.

Canonical field columns (F23 FR-1): **Status · Priority · Size · Estimate · Iteration ·
Start date · Target date**. (Title, Assignees, Linked change requests, Sub-issue progress and
Repository are intrinsic mirror columns the table already renders for every provider.)

The rule stays Decision 0018's: **a scoped label is a single-select and nothing else.**

| Column      | Type          | GitLab expression                    | Editable? |
|-------------|---------------|--------------------------------------|-----------|
| Status      | single_select | `status::*` scoped labels            | ✅        |
| Priority    | single_select | `priority::*` scoped labels          | ✅        |
| Size        | single_select | `size::*` scoped labels              | ✅        |
| Estimate    | number        | — (weights are a paid tier)          | read-only + reason |
| Iteration   | iteration     | — (paid tier)                        | read-only + reason |
| Start date  | date          | — (no per-issue date field)          | read-only + reason |
| Target date | date          | — (no per-issue date field)          | read-only + reason |

Changes:

1. `fieldsFromLabels` emits the **entire** canonical set in canonical order every time — the
   expressible three as editable single-selects (options from whatever labels exist, empty is
   fine), the rest read-only with their existing reasons. The column set no longer depends on
   which labels happen to be present, so the table is the same shape on an empty project.
2. `provisionProjectStructure` seeds a starter option for every expressible field (from
   `DEFAULT_LABEL_TAXONOMY`) so the single-selects are never empty on a fresh project —
   additive-only, never destructive, as today.
3. On a paid GitLab tier, `hasWeights`/`hasIterations` flip Estimate/Iteration to editable; the
   read-only path is the free-tier fallback, not the definition of the column.

Net effect: identical columns on both providers; the only visible difference is *four cells*
GitLab marks read-only with a stated reason, which is the honest projection Decision 0018 asks
for — not a missing column.
