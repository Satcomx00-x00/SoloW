"use client";

import { Download, FolderPlus, SquarePen, Zap } from "lucide-react";
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

/**
 * The same four things the header's Create menu offers, reachable by name from ⌘K.
 *
 * They resolve to `actions.create(kind)`, which the shell answers by opening the dialog wherever
 * you are — none of these navigates any more, because the dialogs no longer belong to a page.
 */
const CREATE_COMMANDS = [
  { id: "task.create", title: "New task", icon: Zap, kind: "task" },
  { id: "issue.create", title: "New issue", icon: SquarePen, kind: "issue" },
  { id: "issue.import", title: "Import issues", icon: Download, kind: "import-issues" },
  {
    id: "repository.connect.create",
    title: "Connect a repository",
    icon: FolderPlus,
    kind: "connect-repository",
  },
] as const;

for (const [index, command] of CREATE_COMMANDS.entries()) {
  contribute(commandRegistry, {
    id: command.id,
    priority: 10 + index,
    render: {
      title: command.title,
      group: "Create",
      icon: command.icon,
      run: (actions) => actions.create(command.kind),
    },
  });
}
