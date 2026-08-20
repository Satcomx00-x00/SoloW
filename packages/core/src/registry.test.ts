import { describe, expect, it } from "bun:test";
import {
  arrangeContributions,
  type Contribution,
  createRegistry,
  DEFAULT_SURFACE_LAYOUT,
  moveInOrder,
  RegistryErrorCode,
  resolveContributions,
  withVisibility,
} from "./registry.js";

/**
 * Registry unit tests (issue #3, Definition of Done: ordering, `when` filtering, user override
 * precedence). The three named surfaces all reduce to this file — if the rules here are wrong,
 * the status bar and the palette are wrong in the same way at the same time.
 */

interface Ctx {
  signedIn: boolean;
}

const item = (
  id: string,
  priority: number,
  when?: (ctx: Ctx) => boolean,
): Contribution<string, Ctx> =>
  when ? { id, priority, when, render: id } : { id, priority, render: id };

const ids = (resolved: Contribution<string, Ctx>[]) => resolved.map((c) => c.id);
const SIGNED_IN: Ctx = { signedIn: true };

describe("resolveContributions", () => {
  it("orders by ascending priority when the user has saved no arrangement", () => {
    const resolved = resolveContributions([item("b", 20), item("a", 10)], SIGNED_IN);
    expect(ids(resolved)).toEqual(["a", "b"]);
  });

  it("breaks a priority tie on id, so registration order cannot leak into the sequence", () => {
    const forwards = resolveContributions([item("zulu", 10), item("alpha", 10)], SIGNED_IN);
    const backwards = resolveContributions([item("alpha", 10), item("zulu", 10)], SIGNED_IN);
    expect(ids(forwards)).toEqual(["alpha", "zulu"]);
    expect(ids(backwards)).toEqual(ids(forwards));
  });

  it("omits a contribution whose predicate is false", () => {
    const resolved = resolveContributions(
      [item("always", 10), item("signed-out-only", 20, (ctx) => !ctx.signedIn)],
      SIGNED_IN,
    );
    expect(ids(resolved)).toEqual(["always"]);
  });

  it("includes that same contribution once the context changes", () => {
    const resolved = resolveContributions(
      [item("always", 10), item("signed-out-only", 20, (ctx) => !ctx.signedIn)],
      { signedIn: false },
    );
    expect(ids(resolved)).toEqual(["always", "signed-out-only"]);
  });

  it("treats a predicate that throws as not visible rather than propagating", () => {
    const broken = item("broken", 10, () => {
      throw new Error("a plugin blew up");
    });
    const resolved = resolveContributions([broken, item("fine", 20)], SIGNED_IN);
    expect(ids(resolved)).toEqual(["fine"]);
  });

  it("puts the user's saved order ahead of registered priority", () => {
    const resolved = resolveContributions([item("a", 10), item("b", 20)], SIGNED_IN, {
      order: ["b", "a"],
      hidden: [],
    });
    expect(ids(resolved)).toEqual(["b", "a"]);
  });

  it("sorts a contribution the saved order never named after the ones it did, by priority", () => {
    const resolved = resolveContributions(
      [item("added-later", 1), item("a", 10), item("b", 20)],
      SIGNED_IN,
      { order: ["b", "a"], hidden: [] },
    );
    expect(ids(resolved)).toEqual(["b", "a", "added-later"]);
  });

  it("ignores an id in the saved order that nothing registers, so an uninstalled item cannot blank the surface", () => {
    const resolved = resolveContributions([item("a", 10)], SIGNED_IN, {
      order: ["gone", "a"],
      hidden: [],
    });
    expect(ids(resolved)).toEqual(["a"]);
  });

  it("drops the ids the user hid", () => {
    const resolved = resolveContributions([item("a", 10), item("b", 20)], SIGNED_IN, {
      order: [],
      hidden: ["a"],
    });
    expect(ids(resolved)).toEqual(["b"]);
  });

  it("hides an item the user hid even when their saved order still names it", () => {
    const resolved = resolveContributions([item("a", 10), item("b", 20)], SIGNED_IN, {
      order: ["a", "b"],
      hidden: ["a"],
    });
    expect(ids(resolved)).toEqual(["b"]);
  });

  it("returns everything visible for the default layout", () => {
    const resolved = resolveContributions(
      [item("a", 10), item("b", 20)],
      SIGNED_IN,
      DEFAULT_SURFACE_LAYOUT,
    );
    expect(ids(resolved)).toEqual(["a", "b"]);
  });
});

describe("arrangeContributions", () => {
  it("keeps the items a predicate would hide, because a customization list is not the surface", () => {
    const arranged = arrangeContributions([
      item("always", 20),
      item("signed-out-only", 10, (ctx) => !ctx.signedIn),
    ]);
    expect(ids(arranged)).toEqual(["signed-out-only", "always"]);
  });

  it("keeps the items the user hid, so a hidden item can still be brought back", () => {
    const arranged = arrangeContributions([item("a", 10), item("b", 20)], {
      order: ["b", "a"],
      hidden: ["a"],
    });
    expect(ids(arranged)).toEqual(["b", "a"]);
  });

  it("does not reorder the array it was given", () => {
    const source = [item("b", 20), item("a", 10)];
    arrangeContributions(source);
    expect(ids(source)).toEqual(["b", "a"]);
  });
});

describe("moveInOrder", () => {
  it("swaps an id with the one before it", () => {
    expect(moveInOrder(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
  });

  it("swaps an id with the one after it", () => {
    expect(moveInOrder(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
  });

  it("leaves the order alone at either end, so a first/last item is a no-op rather than a wrap", () => {
    expect(moveInOrder(["a", "b"], "a", -1)).toEqual(["a", "b"]);
    expect(moveInOrder(["a", "b"], "b", 1)).toEqual(["a", "b"]);
  });

  it("leaves the order alone for an id it does not contain", () => {
    expect(moveInOrder(["a", "b"], "c", -1)).toEqual(["a", "b"]);
  });
});

describe("withVisibility", () => {
  it("adds an id to hidden without disturbing the saved order", () => {
    expect(withVisibility({ order: ["a", "b"], hidden: [] }, "a", false)).toEqual({
      order: ["a", "b"],
      hidden: ["a"],
    });
  });

  it("removes an id from hidden when it is shown again", () => {
    expect(withVisibility({ order: [], hidden: ["a", "b"] }, "a", true)).toEqual({
      order: [],
      hidden: ["b"],
    });
  });

  it("does not list an id twice when it is hidden again", () => {
    const once = withVisibility({ order: [], hidden: [] }, "a", false);
    expect(withVisibility(once, "a", false).hidden).toEqual(["a"]);
  });
});

describe("createRegistry", () => {
  it("resolves what was registered", () => {
    const registry = createRegistry<string, Ctx>("status-bar");
    registry.register(item("a", 10));
    registry.register(item("b", 20));
    expect(ids(registry.resolve(SIGNED_IN))).toEqual(["a", "b"]);
  });

  it("rejects a duplicate id and leaves the first registration in place", () => {
    const registry = createRegistry<string, Ctx>("status-bar");
    registry.register(item("a", 10));
    const second = registry.register({ id: "a", priority: 99, render: "impostor" });
    expect(second).toEqual({ ok: false, error: RegistryErrorCode.DuplicateId });
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]?.render).toBe("a");
  });

  it("rejects an id a saved arrangement could not round-trip", () => {
    const registry = createRegistry<string, Ctx>("status-bar");
    for (const bad of ["", "Status.Tasks", "status tasks", "status.", "a".repeat(65)]) {
      expect(registry.register({ id: bad, priority: 10, render: bad })).toEqual({
        ok: false,
        error: RegistryErrorCode.InvalidId,
      });
    }
    expect(registry.list()).toHaveLength(0);
  });

  it("keeps two registries made by the same factory independent", () => {
    const commands = createRegistry<string, Ctx>("commands");
    const statusItems = createRegistry<string, Ctx>("status-bar");
    commands.register(item("settings.secrets", 10));
    expect(statusItems.list()).toHaveLength(0);
    expect(commands.surface).toBe("commands");
    expect(statusItems.surface).toBe("status-bar");
  });

  it("removes a registration, so an uninstalled plugin stops contributing (#93)", () => {
    const registry = createRegistry<string, Ctx>("status-bar");
    registry.register(item("a", 10));
    registry.register(item("b", 20));

    expect(registry.unregister("a")).toBe(true);
    expect(ids(registry.resolve(SIGNED_IN))).toEqual(["b"]);
  });

  it("says so when there was nothing to remove, rather than pretending it removed something", () => {
    const registry = createRegistry<string, Ctx>("status-bar");
    expect(registry.unregister("never-registered")).toBe(false);
  });

  it("lets an id be registered again once it has been removed, which is what an upgrade is", () => {
    const registry = createRegistry<string, Ctx>("status-bar");
    registry.register(item("a", 10));
    registry.unregister("a");

    const second = registry.register({ id: "a", priority: 99, render: "replacement" });

    expect(second.ok).toBe(true);
    expect(registry.list()[0]?.render).toBe("replacement");
  });

  it("applies the user's arrangement through the registry, not only the pure function", () => {
    const registry = createRegistry<string, Ctx>("status-bar");
    registry.register(item("a", 10));
    registry.register(item("b", 20));
    registry.register(item("c", 30));
    expect(ids(registry.resolve(SIGNED_IN, { order: ["c"], hidden: ["a"] }))).toEqual(["c", "b"]);
  });
});
