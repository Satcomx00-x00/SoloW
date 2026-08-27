"use client";

import { KeyRound, ListOrdered, PlugZap } from "lucide-react";
import { commandRegistry, contribute } from "@/lib/contributions";
import { settingsHref } from "@/lib/navigation";

/**
 * Settings' entries in the command palette (issue #3, AC-4).
 *
 * The point of this file is what it does *not* import: there is no path from here to
 * `command-palette.tsx`, and none from the palette back to here. A feature module contributes by
 * registering, the palette renders whatever resolved, and neither knows the other exists — which
 * is the constraint a plugin sandbox needs (#93) and the reason these three commands are real
 * rather than a fixture.
 */

contribute(commandRegistry, {
  id: "settings.secrets",
  priority: 10,
  render: {
    title: "Manage secrets",
    group: "Settings",
    icon: KeyRound,
    run: (actions) => actions.navigate(settingsHref("secrets")),
  },
});

contribute(commandRegistry, {
  id: "settings.repositories",
  priority: 20,
  render: {
    title: "Connect a repository",
    group: "Settings",
    icon: PlugZap,
    run: (actions) => actions.navigate(settingsHref("repositories")),
  },
});

/**
 * Offered unconditionally, even though an empty status bar is possible once plugins supply the
 * segments. The predicate this used to carry read the status-item registry — a mutable global,
 * whose answer depends on which modules have been evaluated, and exactly the kind of thing a
 * sandboxed plugin (#93) must not be able to reach. A predicate has to be a pure function of the
 * `AppContext` it is handed or it is not a predicate, it is a race. The section this command
 * leads to already says so for itself when it has nothing to arrange.
 */
contribute(commandRegistry, {
  id: "settings.status-bar",
  priority: 30,
  render: {
    title: "Customize the status bar",
    group: "Settings",
    icon: ListOrdered,
    run: (actions) => actions.navigate(settingsHref("status-bar")),
  },
});
