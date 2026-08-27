# F15 — Notifications

**Status:** Draft · **Owner:** Product · **Maturity:** Core · **Last reviewed:** 2026-08-17

## Summary

Notifications tell users when something needs their attention — most importantly when a Task
or Workflow Run is waiting on a human decision. They keep the review-first model working
without users having to watch the board constantly.

## Jobs served

- **J4 — Watch a process unfold.**
- **J9 — Collaborate and share.**

## User stories

- As a Reviewer, I want to be notified when a Task needs my review, so I respond promptly.
- As a user, I want to know when a long-running Task finishes, fails, or is Parked, so I can
  act.
- As a Team Lead, I want notifications delivered to our chat, so the team sees them where
  they already work.

## Functional requirements

- **FR-1** SoloW notifies users of events that need attention: a Task entering Review,
  a Workflow reaching a Gate, a Task failing, a Task being Parked, and a subscription
  credential expiring.
- **FR-2** SoloW notifies users of completion events: a Task reaching Done and a
  Workflow Run completing.
- **FR-3** Notifications are delivered through *channels*. A channel is a contribution to the
  notification registry (see [F19](./F19-extension-contributions.md)), not a feature of its
  own: in-app is the first channel, and chat or email are further registrations that reuse a
  configured Integration (see [F12](./F12-integrations.md)).
- **FR-4** A user can configure which events they are notified about and which of the
  registered channels each is delivered through.
- **FR-5** Notifications link directly to the relevant Task, Run, or setting.

## Non-functional requirements

- **NFR-1** Attention-required notifications are timely so review is not delayed.
- **NFR-2** Notifications never include secrets or unredacted sensitive content.

## States & rules

- Notification triggers map to the lifecycle events defined in
  [Domain Model](../product/04-domain-model.md).
- Delivery through a channel depends on the relevant Integration being configured and
  healthy.

## Edge cases & failure handling

- If a delivery channel is unavailable, in-product notification still occurs so nothing is
  lost.

## Out of scope

- The internal design of each delivery channel, covered by [F12](./F12-integrations.md).

## Related

- [F03 — Visual Workflow Designer & Monitor](./F03-workflow-designer.md)
- [F10 — Review & Approval](./F10-review-approval.md)
- [F12 — External Integrations](./F12-integrations.md)
- [F19 — Extension Contributions](./F19-extension-contributions.md)
