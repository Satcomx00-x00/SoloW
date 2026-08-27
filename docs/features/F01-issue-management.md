# F01 — Issue Management

**Status:** Draft · **Owner:** Product · **Maturity:** Core · **Last reviewed:** 2026-08-22

## Summary

Issues are the organising unit of work in SoloW. Every Task exists to advance an
Issue. An Issue reaches SoloW one of two ways: **imported** from a connected GitHub or
GitLab repository (see [F12](./F12-integrations.md)), or **created directly** from the shell
header's Create menu with a title, description, a Repository, and labels (reversing the 2026-08-19
product decision, issue #15 — user reports showed a Workspace with no connected tracker, or a
user who wants to jot an Issue down before it exists upstream, had no way to use the board).
Whichever way an Issue arrives, its Tasks and derived status are always SoloW's own; an
*imported* Issue's title and description remain the provider's — SoloW never edits them.

## Jobs served

- **J2 — Organise agent work around issues.**

## User stories

- As a Team Lead, I want to import Issues from our existing tracker, so agent work is
  anchored to our real backlog, not a duplicate of it.
- As a Solo Power User, I want to see all Tasks that belong to an Issue in one place, so I
  know the whole state of that work.
- As a Reviewer, I want an Issue to reflect the outcome of its Tasks, so status stays
  truthful.

## Functional requirements

- **FR-1** A user can create an Issue directly with a title, description, a Repository, and
  labels. Restored 2026-08-20 (reversing the 2026-08-19 removal, issue #15) — opened from the
  shell header's **Create** menu via a dialog that also lets the user pick an existing
  Repository or connect a new one. A locally created Issue's `source` reads `"local"`, the same
  value pre-2026-08-19 rows already carried.
- **FR-1a** Every way to create or import work is reached from one place: the **Create** menu in
  the shell header, present on every route, offering New task, New issue, Import issues and
  Connect a repository (with ⌘⇧T / ⌘⇧I for the first two, and the same four entries in the ⌘K
  palette). Added 2026-08-21 after a user report that these were spread across the board header,
  the Issues page header, two glyph buttons inside the board's Backlog column and Settings, so
  which ones were reachable depended on the route. Settings → Integrations keeps its own
  "Import a repository", which connects a *source* rather than creating one Issue.
- **FR-2** A user can view all Issues in a Workspace, filter them by status, label and
  source, and search them by text (title, description, or the provider's own issue number —
  "#42" and "42" both find it). Built 2026-08-22; every filter lives in the URL
  (`/issues?status=&q=&label=&source=`), so a narrowed list is shareable and survives a reload.
  Labels compose as an AND — a second label narrows — and the filter offers the Workspace's
  whole label vocabulary (`issue.labels`), not the labels of whatever survived the current
  filter. **No priority filter**: an Issue has no priority in the domain model, and this
  feature's own "Out of scope" rules out custom fields. Adding one is a product decision, not
  an omission in the list.
- **FR-3** An Issue is created either by importing it from a connected GitHub or GitLab
  repository (see [F12](./F12-integrations.md)) or directly, per FR-1. Title and description
  are locked to the provider's own once an Issue is imported — SoloW refuses to edit
  them — but are freely editable for a locally created Issue. Labels are always editable,
  regardless of source: a Repository linked to an Integration offers a picker of the
  repository's real labels (fetched live, `repository.listLabels`); a local-path Repository has
  no labels to fetch, so labels are free text there.
- **FR-4** An imported Issue displays its source (provider, number) and a link back to the
  original — on the Issue page, under the title ("GitHub #42 ↗ · synced 21/08/2026"), added
  2026-08-22 alongside FR-2/FR-7.
- **FR-5** An Issue shows all Tasks administered under it and their current lifecycle
  states.
- **FR-6** An Issue's status derives from its Tasks: it is In Progress while any Task is
  active and Resolved when its Tasks are Done with changes accepted.
- **FR-7** A user can manually set an Issue's status, overriding the derived status, with
  the override recorded. Built 2026-08-22 (`issue.setStatus`): the status badge on the Issue is
  a menu, and what is stored is only the part the Tasks cannot know — that a person disagreed
  with them — in `issue.status_override`, with who set it and when. A `status` column that was
  written once at creation and never updated went with it, so the status has one source of
  truth again. The override is shown *as* an override ("Set by hand on 22/08 · its tasks read
  In progress"), and clearing it (`status: null`) hands the Issue back to `deriveIssueStatus`.
- **FR-8** A user can break an Issue into one or more Tasks directly from the Issue.
- **FR-9** A user can close an Issue; closing is prevented, with a warning, while active
  Tasks remain, unless explicitly forced. Built 2026-08-22 as part of FR-7's `setStatus`:
  `closed` over a Task that is ready, running, in review or parked is refused with
  `ISSUE_HAS_ACTIVE_TASKS`, which the UI turns into a warning naming the count and a "Close
  anyway" that re-sends with `force`. A warning rather than a wall (unlike FR-10's delete):
  closing destroys nothing, and an Issue whose remaining Tasks are abandoned is a real thing to
  want to close.
- **FR-10** A user can delete an Issue. Refused while it has any Tasks against it (see States
  & rules) — the Issue is never silently cascaded away, and a Task's `issueId` reference is
  never left dangling.

## Non-functional requirements

- **NFR-1** Synchronisation with an external tracker keeps status and links current within
  a bounded, configurable interval and on demand.
- **NFR-2** Issue lists remain responsive with large numbers of Issues.

## States & rules

- Issue states: **Open → In Progress → Resolved → Closed**.
- An imported Issue's canonical fields (title, description) are owned by its source and are
  not edited in SoloW; SoloW-specific fields (its Tasks, its derived status) are
  owned by SoloW.
- Deleting an Issue is blocked while it has Tasks; the user must first move or remove those
  Tasks.

## Edge cases & failure handling

- If an external tracker is unreachable, synchronised Issues remain visible with their last
  known state and a staleness indicator.
- A conflict between an external update and a local override surfaces to the user rather
  than silently resolving.

## Out of scope

- Full issue-tracker capabilities (sprints, estimation, custom fields) beyond what is
  needed to organise agent Tasks. Those remain in the external tracker.

## Related

- [F02 — Kanban Task Administration](./F02-kanban-task-administration.md)
- [F12 — External Integrations](./F12-integrations.md)
- [Domain Model](../product/04-domain-model.md)
