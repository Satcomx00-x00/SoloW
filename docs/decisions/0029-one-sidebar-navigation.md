# 0029 — One labelled sidebar replaces the activity rail and the navigator

**Status:** Accepted · **Date:** 2026-10-05 · **Deciders:** Product / Design
**Supersedes:** the "no Projects destination" rule recorded in `apps/web/src/lib/navigation.ts`
(spec F16's title-as-switcher) · **Builds on:** [0006](./0006-kanban-scoped-to-issues.md)

## Context

The shell copied VS Code: a 48px rail of unlabelled icons, a 240px "navigator" beside it, a
breadcrumb, and on a Task page a third column of its own. Used day to day it failed in ways that
were each small and together made the app hard to move around:

- **The front door had no door.** `/` redirects to `/projects`, and a Project is created there,
  but nothing in the chrome linked to it. The logo was not a link, and the breadcrumb's root (the
  Workspace's name) opened *Settings*. The only way back was a "New or adopted project…" entry
  inside the switcher popover.
- **The rail was icons only.** An inbox meant "Unassigned", a node graph meant "Workflows"; you had
  to hover to find out.
- **The navigator meant something different on every route.** Recent tasks, then a Project's
  sections, then lifecycle counts that repeated the board columns beside them, then a Workflow
  list with a create form, then Settings' sections. Its header was a "switch project" button on
  every page, including ones in no Project, where it showed the page's own title.
- **The Task page could not say where it was.** Its route is flat, so the breadcrumb read
  `Workspace › Task`, nothing was lit, and three controls (the page's back arrow, the
  breadcrumb, the navigator's "Go to › Board") offered the same way out. Rail, navigator and the
  Task's own column took about 530px before any content.

## Decision

1. **One sidebar, labelled, the same on every route.** Top to bottom: the Workspace menu
   (Workspace settings, Sign out); **Projects**, with "All projects" and every Project, the open
   one's Planning / Board / Issues nested under it; **Workspace**, with Unassigned (with its
   count), Workflows and History; **Recent**, the last five Tasks opened; and Settings at the foot.
   Exactly one row is filled: the current page. A parent whose child is current is named in full
   strength but not filled.
2. **Projects is a destination again.** `/projects` heads `WORKSPACE_SECTIONS` and the command
   palette offers it. Choosing a Project is a row in the sidebar, not a popover; picking another
   Project keeps the section you are in.
3. **Flat routes are placed.** `usePlace()` asks the server which Project holds a Task's or an
   Issue's Issue (`project.forIssue`, the query the pages already make), so a Task lights its
   Project's Board and an Issue its Project's Issues, or Unassigned when no Project holds it.
   The sidebar and the breadcrumb both read this one answer.
4. **The breadcrumb starts at Projects**: `Projects › Project › Section › leaf`, the leaf being
   the Task's or Issue's own title. On Settings it is `Settings › Section`.
5. **Settings takes the sidebar over** while it is open, with a "Back to app" link to the last
   page you were on outside it.
6. **The sidebar can be put away**, with ⌘B / Ctrl+B or its footer button, and is remembered in a
   cookie (`solow-sidebar`) that the server layout reads, so the first paint is already the
   right width. Below `md` it is a drawer opened from the header and closed by navigating.
7. **The sidebar only navigates.** The Workflow create, import and store controls moved to the
   Workflows page header; delete was already in the inspector. The board-lifecycle and
   issue-status counts were dropped: the board's columns and the issue list's filter tabs show
   the same numbers next to them.

## Consequences

- The Workspace's name is no longer in the breadcrumb; it heads the sidebar instead.
- `ActivityBar`, `Navigator`, `ProjectPicker` and `TaskNav` are gone. `Section.caption` and
  `ProjectSection.caption` went with them, since only the navigator's header read them.
- The board still honours `?column=`, but nothing in the chrome links to it any more.
- The project list is fetched on every page, where the picker fetched it only when opened. It is
  one cached query with the same key as the Projects page's own.
