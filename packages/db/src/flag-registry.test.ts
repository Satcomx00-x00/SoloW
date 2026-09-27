/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { FLAGS, type FlagKey, flagKeys, isEnabled, isFlagKey } from "./flag-registry.js";

/**
 * The flag registry's own contract (constitution v1.5.0).
 *
 * This file exists because the registry had no test at all while it was the single source of
 * "is this capability available", read on every tRPC entry point and at every orchestrator run
 * start. Flipping the default to ON made that gap expensive: three separate places were deciding
 * the same question with hand-written expressions, and the flip revealed they did not agree.
 *
 * So the assertions here are about the *rule*, not about any one flag — a new flag added next
 * year is covered by them the day it is registered.
 */

describe("the flag registry", () => {
  it("defaults every registered flag ON", () => {
    /*
     * The drift guard, and the reason this test is worth more than it looks.
     *
     * A flag declared `default: false` would work perfectly, ship quietly, and reintroduce the
     * posture the constitution abandoned — a capability nobody can reach until they find a
     * terminal. Nothing else in the codebase would complain, because "off" is a legal value
     * everywhere. This is the only thing standing between that and main.
     */
    const off = flagKeys().filter((key) => !FLAGS[key].default);
    expect(off).toEqual([]);
  });

  it("keeps the key, the record and the map in step", () => {
    // A registry entry filed under a key that disagrees with its own `key` field would make
    // `flagKeys()` and `FLAGS[key].key` two different vocabularies.
    for (const key of flagKeys()) {
      expect(FLAGS[key].key).toBe(key);
      expect(FLAGS[key].granularity).toBe("workspace");
      expect(FLAGS[key].description.length).toBeGreaterThan(0);
    }
    expect(flagKeys()).toEqual(Object.keys(FLAGS) as FlagKey[]);
  });

  it("narrows an arbitrary string to a registered key, and refuses one that is not", () => {
    expect(isFlagKey("ff-core-program")).toBe(true);
    // Neither a typo nor a plausible-looking future flag is a key until it is registered — this
    // is what stops an unbounded set of rows being written into `enabled_flags`.
    expect(isFlagKey("ff-core-programme")).toBe(false);
    expect(isFlagKey("")).toBe(false);
    expect(isFlagKey("__proto__")).toBe(false);
  });
});

describe("isEnabled", () => {
  const ctx = (overrides?: Partial<Record<FlagKey, boolean>>) => ({
    workspaceId: "ws-1",
    ...(overrides ? { overrides } : {}),
  });

  it("answers the registry default when the Workspace has said nothing", () => {
    for (const key of flagKeys()) {
      expect(isEnabled(key, ctx())).toBe(FLAGS[key].default);
      // An empty override map is the same statement as no map at all: a Workspace row whose
      // `enabled_flags` is `{}` has not turned anything off.
      expect(isEnabled(key, ctx({}))).toBe(FLAGS[key].default);
    }
  });

  it("lets an explicit false override the default — the kill switch", () => {
    /*
     * The whole reason the flip is safe. With defaults ON, "off" can only be expressed as a
     * stored `false`; if this ever stopped winning over the default there would be no way to
     * turn a misbehaving capability off at all, and the flag would be decoration.
     */
    expect(isEnabled("ff-core-program", ctx({ "ff-core-program": false }))).toBe(false);
    expect(isEnabled("ff-workflows", ctx({ "ff-workflows": false }))).toBe(false);
  });

  it("lets an explicit true override, so a Workspace pinned on stays on", () => {
    // Redundant against today's defaults, deliberately: it pins that an override is read as a
    // value rather than as "something was said here", which is what a later default flip in the
    // other direction would depend on.
    expect(isEnabled("ff-mcp", ctx({ "ff-mcp": true }))).toBe(true);
  });

  it("does not let one flag's override decide another's", () => {
    const overrides = { "ff-workflows": false } as const;
    expect(isEnabled("ff-workflows", ctx(overrides))).toBe(false);
    expect(isEnabled("ff-core-program", ctx(overrides))).toBe(true);
  });

  it("ignores an override that is not a boolean, rather than coercing it", () => {
    /*
     * `enabled_flags` is JSON on a row a person can edit. A `"false"` string coerces to `true`
     * under `Boolean()` and to `false` under a `=== "false"` check, and both are guesses about
     * what someone meant. The registry treats a non-boolean as nothing said and falls through to
     * the default, which is the only answer that does not invent intent.
     */
    const bad = { "ff-mcp": "false" } as unknown as Partial<Record<FlagKey, boolean>>;
    expect(isEnabled("ff-mcp", ctx(bad))).toBe(FLAGS["ff-mcp"].default);
  });
});
