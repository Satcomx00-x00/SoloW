# F19 — Extension Contributions

**Status:** Draft · **Owner:** Platform · **Maturity:** Core · **Last reviewed:** 2026-08-20

## Summary

Several surfaces in GateControl are not fixed lists but *assembled* ones: the command palette,
the status bar, and — once notifications exist — the set of channels an event is delivered
through. Each is made of things supplied by feature modules, ordered, conditionally visible,
and arranged by the user. This feature defines that shared shape once, so a feature does not
reach into a surface and a surface does not know its features. It is the seam a plugin system
stands on: registration is the only way in, which is exactly the constraint a sandbox needs.

## Jobs served

- **J4 — Watch a process unfold.**
- **J10 — Operate with confidence.**

## User stories

- As a user, I want to hide the parts of the status bar I do not care about, so the shell
  shows me what I actually use.
- As a user, I want the arrangement I chose to be waiting for me on another machine, so my
  setup belongs to my account rather than to a browser.
- As a user, I want the command palette to offer only the commands that apply where I am, so
  the list is short and everything in it works.
- As an Operator, I want a new capability to appear in the surfaces it belongs in without the
  shell being modified, so adding one is a low-risk change.

## Functional requirements

- **FR-1** A contribution has a stable id, a default ordering priority, an optional visibility
  predicate, and whatever the surface renders or runs it with.
- **FR-2** A feature contributes to a surface by registering. It never references the surface's
  component, and a surface never references a contributor.
- **FR-3** A contribution's visibility predicate is evaluated each time the surface is shown. A
  predicate that fails hides its own contribution and nothing else.
- **FR-4** A surface shows contributions in the user's saved arrangement first, then everything
  else by ascending priority. A contribution the saved arrangement does not name appears in a
  stable position rather than invalidating the arrangement.
- **FR-5** A user can hide and reorder the contributions of an arrangeable surface. Hidden
  contributions remain listed where the surface is arranged, so they can be restored.
- **FR-6** An arrangement belongs to a user within a Workspace and is restored on any device
  that user signs in on.
- **FR-7** A registration whose id is already taken is refused; the registration already in
  place is kept.
- **FR-8** A registration can be removed. A capability that is uninstalled stops contributing,
  and its id becomes available again — hiding it through the user's arrangement is not the same
  thing, because a hidden contribution stays listed wherever the surface is arranged.
- **FR-9** Notification delivery channels are contributions. In-app is the first channel;
  chat and email are further registrations, not features of their own
  (see [F15](./F15-notifications.md)).

## Non-functional requirements

- **NFR-1** The ordering of a surface is deterministic: the same contributions and the same
  arrangement produce the same sequence, independent of the order modules were loaded in.
- **NFR-2** A failing contribution costs its own slot only. It never blanks a surface or
  prevents the shell from rendering.
- **NFR-3** A contribution id is durable. Renaming one discards the arrangement users saved for
  it, so ids are treated as a compatibility surface.

## States & rules

- A contribution is *registered* (known to a surface), *visible* (its predicate holds and the
  user has not hidden it), or *hidden*.
- Precedence when a surface renders: the user's hidden list, then the predicate, then the
  user's order, then the registered priority, then the id.
- An arrangement is stored per user per Workspace per surface (Principle V), not per browser.
  The tenant and the user are taken from the session, never from the request, so "restore my
  arrangement on another device" and "restore it for me" are the same statement.
- An arrangeable surface is offered for arranging the way it is drawn. A move the surface cannot
  make is not offered, because a move that changes the saved arrangement and nothing on screen
  is indistinguishable from a broken control.

## Edge cases & failure handling

- An arrangement naming a contribution nothing registers — an item removed by an upgrade, or a
  plugin that is no longer installed — ignores that id rather than leaving a gap.
- A contribution registered after an arrangement was saved is shown at its priority behind the
  arranged ones, so a new capability is discoverable without the arrangement being reset.
- A stored arrangement that no longer parses degrades to the default arrangement. A stale
  preference must not prevent the shell from rendering.

## Out of scope

- The plugin manifest, its permission prompt and its loader, which supply contributions at
  runtime instead of at build time.
- Deciding which events reach which notification channels; this feature defines the channel,
  [F15](./F15-notifications.md) defines the delivery.
- The contents of any particular surface. A status segment or a command is specified by the
  feature that contributes it.

## Related

- [F15 — Notifications](./F15-notifications.md)
- [F16 — Platform, Deployment & Multi-Tenancy](./F16-platform-deployment.md)
- [F17 — Security & Secrets](./F17-security-secrets.md)
