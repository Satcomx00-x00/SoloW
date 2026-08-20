"use client";

import { Plus } from "lucide-react";
import { commandRegistry, contribute } from "./contributions";
import { SECTIONS } from "./navigation";

/**
 * The palette's own entries, as registrations (issue #3, AC-2/DoD).
 *
 * These were a hardcoded list inside `command-palette.tsx`. Nothing about what the user sees
 * changed; what changed is that the palette no longer knows what a section or a task is, which
 * is the only way a feature — or later a plugin — can add an entry without editing the palette.
 *
 * The destinations are generated from `SECTIONS` rather than written out three times, because
 * that list exists precisely so the rail, the breadcrumb and the palette cannot disagree about
 * where the app's places are. The id is derived from the route and not from the label: a label
 * is copy and gets reworded, while a route is the durable name of a place, and an id that
 * changes silently discards the arrangement a user saved for it (F19 NFR-3).
 */
for (const [index, section] of SECTIONS.entries()) {
  contribute(commandRegistry, {
    id: `goto${section.href.replaceAll("/", ".")}`,
    // Ten apart, in rail order, so a later contribution can be slotted between two of them.
    priority: (index + 1) * 10,
    render: {
      title: section.label,
      group: "Go to",
      icon: section.icon,
      run: (actions) => actions.navigate(section.href),
    },
  });
}

contribute(commandRegistry, {
  id: "task.create",
  priority: 10,
  render: {
    title: "New task",
    group: "Create",
    icon: Plus,
    run: (actions) => actions.createTask(),
  },
});
