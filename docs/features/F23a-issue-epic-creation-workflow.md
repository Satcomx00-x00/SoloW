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
- **New <parent item>** — shown when the active Project resolves to a provider whose manifest
  declares `issueCreates.parentPlanningItem`, and labelled with the noun that descriptor carries
  ("New epic" on GitLab, "New parent issue" on GitHub). Otherwise the entry is present but
  disabled with the reason, so the capability difference is stated, never hidden (the same rule
  F23 FR-5 follows for unexpressible fields). *Corrected 2026-08-31:* this used to read
  `issueCreates.epics`, which locked out every provider that has a parent item and no epic
  object — see Part 3.

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
its parity concept is the sub-issue, and Part 3 is how the menu offers it.

---

## Part 3 — Providers without epics: the parent planning item

**Date:** 2026-08-31 · **Decision:** the parent issue *is* the epic on GitHub.

GitHub has no epic object. Its parity concept is the sub-issue: an ordinary issue that other
issues nest under. So creating "an epic" on GitHub creates an **ordinary issue**, and the
epic-ness is entirely the sub-issue edges the children later draw to it — the same edges the read
side already mirrors as `ExternalIssue.parentExternalId`. No second hierarchy is invented.

### Two manifest facts, not one

`issueCreates.epics` was made to answer both questions and can only answer one. It now answers
exactly what it says:

| Manifest key | The question it answers | GitLab | GitHub | Gitea |
| --- | --- | --- | --- | --- |
| `epics` | Are there epic objects to list and nest issues under? (gates `createEpic` / `listGroups` / `listEpics` and the compose form's Parent-epic picker) | `true` | `false` | — |
| `parentPlanningItem` | Can this provider *originate* a parent item, and what container does the Where step collect? | `{ container: "group", noun: "epic" }` | `{ container: "repository", noun: "parent issue" }` | — |

They are deliberately independent: a provider may declare either, both or neither, so neither can
answer for the other. Flipping `epics` to `true` for GitHub was rejected outright — the manifest
would then claim a group object GitHub does not have, which is precisely the false claim
Decision 0016 exists to prevent. Gitea declares no `issueCreates` at all and therefore declares
neither, which is the honest answer rather than a default.

The driver boundary gains `createParentPlanningItem(credential, repo, seed: IssueSeed)`, answering
with an `ExternalIssue`. GitHub implements it by delegating to its own `createIssue`; GitLab
implements it as a descriptive `ScmProviderError` its declared container stops anyone reaching.

### Flow B, repository-container variant

```
[Button ＋New ▸ New parent issue]
        │
        ▼
┌─ MODAL 1 · "Where" ──────────────────────────────┐
│  • Repository picker — only repositories on the   │   (skipped when only one is eligible)
│    connection whose manifest declared this        │
│    container; a repository on another connection  │
│    may be on a provider with no parent item at all │
│  [Cancel]                       [Next →]          │
└───────────────────────────────────────────────────┘
        │
        ▼
┌─ MODAL 2 · "Compose" ────────────────────────────┐
│  • Title            (required)                    │
│  • Description      (Markdown, optional)          │
│  • Labels                                         │
│  • No start/due date — an item in a repository is │
│    an issue, and `issueCreates.dueDate` is false  │
│  [← Back]                  [Create parent issue]  │
└───────────────────────────────────────────────────┘
        │
        ▼
ACTION 3 · POST /repos/:owner/:repo/issues  (issue.createParentOnProvider mutation)
        ▼
ACTION 4 · Mirror through the same path Flow A uses, and attach to this Project
        ▼
ACTION 5 · Invalidate project.allItems and issue.list, close the modal.
```

Unlike a group epic, this item genuinely **gets a row**: it is an issue in a repository this
Workspace mirrors, it will come back on the very next `listIssues` regardless, and leaving it
unmirrored would hide the operator's own creation until the next poll — and invite them to create
it a second time. A group epic still writes nothing, for the reason Flow B already gives: it has
no repository, no issue number, and only a sync can see what the provider nests under it.

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
