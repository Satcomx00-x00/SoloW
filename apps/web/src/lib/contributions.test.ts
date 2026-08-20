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
    document.addEventListener("gatecontrol:notification", listener);

    await channel?.render.deliver({ kind: "task.review", title: "Keypad task needs review" });
    document.removeEventListener("gatecontrol:notification", listener);

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
      createTask: () => {},
    };

    command?.render.run(actions);

    expect(navigated).toEqual(["/settings#secrets"]);
    expect(command?.render.group).toBe("Settings");
  });

  it("migrated the palette's own entries, so the destination list is a registration too", () => {
    const resolved = ids(commandRegistry.resolve(SIGNED_OUT));
    expect(resolved).toContain("goto.board");
    expect(resolved).toContain("task.create");
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

    expect(imported).toEqual(["lucide-react", "@/lib/contributions"]);
  });
});
