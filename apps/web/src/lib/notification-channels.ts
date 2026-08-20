"use client";

import { contribute, type NotificationEvent, notificationChannelRegistry } from "./contributions";

/**
 * The in-app notification channel (issue #3). "In-app first" is the issue's own sequencing:
 * Slack (#73) and email become further registrations here rather than features of their own.
 *
 * There is no dispatcher — deciding which events reach which channels is #92's job. What exists
 * now is the seam: a channel is a contribution whose renderer is a `deliver` function, and the
 * dispatcher will find its channels by resolving this registry instead of by importing them.
 *
 * Delivery is a DOM event for the same reason the create dialog uses one: the bell UI does not
 * exist yet, and a channel that imported it would be the coupling the registry is here to avoid.
 */
export const IN_APP_NOTIFICATION_EVENT = "gatecontrol:notification";

contribute(notificationChannelRegistry, {
  id: "notify.in-app",
  priority: 10,
  render: {
    label: "In-app",
    deliver: (event: NotificationEvent) => {
      document.dispatchEvent(new CustomEvent(IN_APP_NOTIFICATION_EVENT, { detail: event }));
    },
  },
});
