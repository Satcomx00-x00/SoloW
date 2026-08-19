# F01 — Issue Management

**Status:** Draft · **Owner:** Product · **Maturity:** Core · **Last reviewed:** 2026-08-17

## Summary

Issues are the organising unit of work in GateControl. Every Task exists to advance an
Issue. **Every Issue is imported from a connected GitHub or GitLab repository** (see
[F12](./F12-integrations.md)) — there is no free-text "create Issue" form (product decision,
2026-08-19, issue #15). Agent work is always anchored to a real, externally-tracked request,
never to something typed up inside GateControl and nowhere else.

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

- **FR-1** ~~A user can create an Issue with a title, description, and optional labels and
  priority.~~ Removed 2026-08-19 (issue #15) — see FR-3.
- **FR-2** A user can view all Issues in a Workspace, filter them by status, label,
  priority, and source, and search them by text.
- **FR-3** An Issue is created only by importing it from a connected GitHub or GitLab
  repository (see [F12](./F12-integrations.md)); GateControl has no native Issue-creation
  path. Title and description are the provider's own; GateControl does not edit them.
- **FR-4** An imported Issue displays its source (provider, number) and a link back to the
  original.
- **FR-5** An Issue shows all Tasks administered under it and their current lifecycle
  states.
- **FR-6** An Issue's status derives from its Tasks: it is In Progress while any Task is
  active and Resolved when its Tasks are Done with changes accepted.
- **FR-7** A user can manually set an Issue's status, overriding the derived status, with
  the override recorded.
- **FR-8** A user can break an Issue into one or more Tasks directly from the Issue.
- **FR-9** A user can close an Issue; closing is prevented, with a warning, while active
  Tasks remain, unless explicitly forced.

## Non-functional requirements

- **NFR-1** Synchronisation with an external tracker keeps status and links current within
  a bounded, configurable interval and on demand.
- **NFR-2** Issue lists remain responsive with large numbers of Issues.

## States & rules

- Issue states: **Open → In Progress → Resolved → Closed**.
- An imported Issue's canonical fields (title, description) are owned by its source and are
  not edited in GateControl; GateControl-specific fields (its Tasks, its derived status) are
  owned by GateControl.
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
