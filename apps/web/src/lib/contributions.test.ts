/// <reference types="bun-types" />

import { describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppContext, CommandActions, CommandItem } from "@/lib/contributions";
import {
  commandRegistry,
  contribute,
  notificationChannelRegistry,
  statusItemRegistry,
} from "@/lib/contributions";
import "@/lib/contributions-boot";

/**
 * The app half of issue #3: one registry abstraction instantiated three times (AC-1), and a
 * feature module reaching a surface without importing it (AC-4).
 *
 * Assertions are "contains", never "equals": these are module singletons registered at import
 * time, so every test file in the process shares them and a count would break the moment another
 * feature contributes something.
 */

const SIGNED_OUT: AppContext = { identity: null };

const ids = (contributions: ReadonlyArray<{ id: string }>) => contributions.map((c) => c.id);

describe("the app's contribution registries", () => {
  it("are three separate instances of the one abstraction", () => {
    expect(statusItemRegistry.surface).toBe("status-bar");
    expect(commandRegistry.surface).toBe("commands");
    expect(notificationChannelRegistry.surface).toBe("notifications");
  });

  it("do not share contributions, so registering with one cannot leak into another", () => {
    const statusIds = new Set(ids(statusItemRegistry.list()));
    for (const id of ids(commandRegistry.list())) expect(statusIds.has(id)).toBe(false);
    for (const id of ids(notificationChannelRegistry.list())) expect(statusIds.has(id)).toBe(false);
    expect(ids(statusItemRegistry.list())).toContain("status.workspace");
  });
});

describe("the notification channel registry", () => {
  it("resolves a registered channel even though no dispatcher exists yet", () => {
    expect(ids(notificationChannelRegistry.resolve(SIGNED_OUT))).toContain("notify.in-app");
  });

  it("delivers through the channel's own renderer, which is where #92 will reach it", async () => {
    const channel = notificationChannelRegistry
      .resolve(SIGNED_OUT)
      .find((c) => c.id === "notify.in-app");
    const delivered: unknown[] = [];
    const listener = (event: Event) => delivered.push((event as CustomEvent).detail);
    document.addEventListener("solow:notification", listener);

    await channel?.render.deliver({ kind: "task.review", title: "Keypad task needs review" });
    document.removeEventListener("solow:notification", listener);

    expect(delivered).toEqual([{ kind: "task.review", title: "Keypad task needs review" }]);
  });
});

describe("a feature module contributing commands", () => {
  it("is resolvable from the registry once the boot barrel has run", () => {
    expect(ids(commandRegistry.resolve(SIGNED_OUT))).toContain("settings.secrets");
  });

  it("runs through the actions the surface supplies, never a router it imported itself", () => {
    const command = commandRegistry.list().find((c) => c.id === "settings.secrets");
    const navigated: string[] = [];
    const actions: CommandActions = {
      navigate: (href) => navigated.push(href),
    };

    command?.render.run(actions);

    expect(navigated).toEqual(["/settings?section=secrets"]);
    expect(command?.render.group).toBe("Settings");
  });

  it("migrated the palette's own entries, so the destination list is a registration too", () => {
    const resolved = ids(commandRegistry.resolve(SIGNED_OUT));
    expect(resolved).toContain("goto.projects");
    /*
     * And the four create entries that used to sit beside them are gone from the *registry*, not
     * merely hidden by the palette.
     *
     * They ran `actions.create(kind)`, a verb `CommandActions` no longer has. A half-removal that
     * deleted the header menu and left these registered would put dead rows straight back into
     * ⌘K — resolvable, drawn, and throwing into the registry's try/catch on selection.
     *
     * A saved arrangement may still name them in its `order` or `hidden` arrays. That is inert:
     * `resolveContributions` only ever looks an id up, so an id that resolves to nothing is
     * skipped rather than rendered as an empty row.
     */
    expect(resolved).not.toContain("task.create");
    expect(resolved).not.toContain("issue.create");
    expect(resolved).not.toContain("issue.import");
    expect(resolved).not.toContain("repository.connect.create");
  });

  it("decides a command from the context alone, never by reading another registry", () => {
    // `settings.status-bar` used to be gated on `statusItemRegistry.list().length > 0`: a
    // predicate whose answer depended on which modules had been evaluated, and on global state a
    // sandboxed plugin (#93) has no business reaching. Emptying that registry must change
    // nothing about which commands apply.
    const items = [...statusItemRegistry.list()];
    for (const item of items) statusItemRegistry.unregister(item.id);
    try {
      expect(ids(commandRegistry.resolve(SIGNED_OUT))).toContain("settings.status-bar");
    } finally {
      for (const item of items) statusItemRegistry.register(item);
    }
    expect(statusItemRegistry.list()).toHaveLength(items.length);
  });

  it("reports a registration the registry refused, rather than dropping it in silence", () => {
    // A Result nobody reads is worse than an exception: a mistyped id would leave the
    // contribution missing with nothing anywhere to say why.
    const reported: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      reported.push(args.map(String).join(" "));
    });

    contribute(commandRegistry, {
      id: "Not A Valid Id",
      priority: 10,
      render: {
        title: "Never shown",
        group: "Settings",
        icon: (() => null) as unknown as CommandItem["icon"],
        run: () => {},
      },
    });
    spy.mockRestore();

    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("Not A Valid Id");
    expect(ids(commandRegistry.list())).not.toContain("Not A Valid Id");
  });

  it("imports no surface: the dependency runs one way, registration only (AC-4)", () => {
    const source = readFileSync(
      join(import.meta.dir, "../components/features/settings/settings-commands.ts"),
      "utf8",
    );
    // Asserted against the import list rather than the file text, so prose about the palette in
    // a comment does not count as reaching into it.
    const imported = [...source.matchAll(/^import\s[^"']*["']([^"']+)["'];$/gm)].map((m) => m[1]);

    // `@/lib/navigation` is the app's route registry — data, with no surface behind it. A command
    // that spelled its own destination would be a second opinion about where Settings lives, and
    // the rule this test protects is about reaching *into* the palette, not about knowing an href.
    expect(imported).toEqual(["lucide-react", "@/lib/contributions", "@/lib/navigation"]);
  });
});
