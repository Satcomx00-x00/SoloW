"use client";

import { type Contribution, createRegistry, type Registry } from "@gatecontrol/core";
import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";

/**
 * The app's three contribution registries (issue #3), and the types they are generic over.
 *
 * One abstraction, instantiated three times — the command palette, the status bar, and
 * notification delivery. The rule that makes this worth having is the one the plugin API (#93)
 * will depend on: **no feature module reaches into another surface directly**. A feature module
 * imports this file and registers; it never imports the component that will draw it. Surfaces
 * import `contributions-boot` for the registrations and never import a contributor.
 *
 * `"use client"` because these are module singletons: a registry evaluated once in the server
 * bundle and once in the client bundle would be two different registries, and only one of them
 * would have the browser's registrations in it.
 */

/** The signed-in Owner, or null on the local dev-owner path. */
export interface ShellIdentity {
  name: string;
  email: string;
}

/**
 * What every `when` predicate is evaluated against, supplied by the surface that is rendering.
 *
 * Deliberately small, explicit, and free of hooks or client objects: a predicate has to stay a
 * pure function of stated facts if #93 is ever to run one written by a third party, and a router
 * or a query client handed to a plugin is an escape hatch out of the sandbox. A registry
 * singleton is the same escape hatch wearing a first-party badge, so a predicate reads this and
 * nothing else — its answer must not depend on which modules happen to have been evaluated.
 *
 * It carries what predicates need today and widens by a field when one needs more. The obvious
 * next one is the current route, so that "do not offer to navigate where you already are" is a
 * fact about the app rather than a branch in the palette; it is not here yet because reading it
 * means `usePathname`, and the process-global `next/navigation` mock in
 * `features/auth/sign-in-form.test.tsx` exports only `useRouter`, so any component importing
 * `usePathname` fails whichever test file happens to load after it. Widening this belongs with
 * fixing that mock.
 */
export interface AppContext {
  readonly identity: ShellIdentity | null;
}

/**
 * A status-bar segment. `slot` preserves the bar's existing left/right split — the counters sit
 * hard right and the workspace and identity sit left — so migrating today's segments to
 * registrations is not also a visual change.
 */
export interface StatusItem {
  /** Names the item wherever it is arranged rather than rendered (Settings, later a plugin list). */
  readonly label: string;
  readonly slot: "left" | "right";
  readonly Component: ComponentType;
}

/**
 * The palette's headings, in the order it shows them. A closed list: an unbounded set of headings
 * is not a palette, and the order is here rather than in the palette because "where the Settings
 * group sits" is a fact about the command vocabulary, not about the component drawing it.
 */
export const COMMAND_GROUPS = ["Go to", "Create", "Settings"] as const;
export type CommandGroup = (typeof COMMAND_GROUPS)[number];

/**
 * What a command may do when chosen. Passing capabilities in rather than letting a command
 * import the router keeps a contributed command testable without a surface, and is the shape a
 * permission prompt eventually attaches to.
 */
export interface CommandActions {
  navigate(href: string): void;
  createTask(): void;
}

export interface CommandItem {
  readonly title: string;
  readonly group: CommandGroup;
  readonly icon: LucideIcon;
  readonly run: (actions: CommandActions) => void;
}

/**
 * The minimum an event needs for a channel to deliver it. #92 owns the dispatcher and the real
 * event catalogue; this stays deliberately thin so that when it arrives it widens this type
 * rather than replacing a guess at it.
 */
export interface NotificationEvent {
  readonly kind: string;
  readonly title: string;
  readonly href?: string;
}

/** A delivery channel is a contribution whose renderer is a `deliver` function (issue #3). */
export interface NotificationChannel {
  readonly label: string;
  readonly deliver: (event: NotificationEvent) => void | Promise<void>;
}

export type StatusItemContribution = Contribution<StatusItem, AppContext>;
export type CommandContribution = Contribution<CommandItem, AppContext>;
export type NotificationChannelContribution = Contribution<NotificationChannel, AppContext>;

export const statusItemRegistry = createRegistry<StatusItem, AppContext>("status-bar");
export const commandRegistry = createRegistry<CommandItem, AppContext>("commands");
export const notificationChannelRegistry = createRegistry<NotificationChannel, AppContext>(
  "notifications",
);

/**
 * Register, and say so out loud when the registry refuses.
 *
 * `register` returns a Result rather than throwing so that one bad contribution cannot stop the
 * shell booting — but a Result nobody reads is worse than an exception: a mistyped id (`status.Tasks`)
 * is rejected, the segment never appears, and there is nothing anywhere to explain why. Every
 * contributor goes through this so a refusal is always visible to whoever caused it. Only the
 * surface and the id are logged; a contribution's `render` may close over anything, and a log
 * line is not the place to find out what.
 */
export function contribute<T>(
  registry: Registry<T, AppContext>,
  contribution: Contribution<T, AppContext>,
): void {
  const result = registry.register(contribution);
  if (result.ok) return;
  console.error(
    `[contributions] ${registry.surface} refused "${contribution.id}": ${result.error}`,
  );
}
