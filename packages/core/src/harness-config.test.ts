import { describe, expect, test } from "bun:test";
import {
  mergeHarnessSettings,
  NO_HARNESS_CONFIG,
  resolveHarnessConfigLaunch,
} from "./harness-config.js";

describe("resolveHarnessConfigLaunch", () => {
  test("no config launches with nothing added", () => {
    expect(resolveHarnessConfigLaunch(null, "claude_code", [])).toEqual({
      ok: true,
      data: NO_HARNESS_CONFIG,
    });
  });

  test("Claude Code settings travel as --settings, never as env", () => {
    const content = { model: "opus", permissions: { allow: ["Bash(ls)"] } };
    const r = resolveHarnessConfigLaunch({ harness: "claude_code", content }, "claude_code", []);
    expect(r).toEqual({ ok: true, data: { env: {}, settings: content } });
  });

  test("opencode config travels as OPENCODE_CONFIG_CONTENT", () => {
    const content = { theme: "dark" };
    const r = resolveHarnessConfigLaunch({ harness: "opencode", content }, "opencode", []);
    expect(r).toEqual({
      ok: true,
      data: { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(content) }, settings: null },
    });
  });

  test("a config for another harness is refused, not half-applied", () => {
    const r = resolveHarnessConfigLaunch({ harness: "opencode", content: {} }, "claude_code", []);
    expect(r.ok).toBe(false);
  });

  test("the running catalog row's credential variables are reserved at launch", () => {
    const content = { env: { MY_PROVIDER_KEY: "x" } };
    const config = { harness: "claude_code" as const, content };
    expect(resolveHarnessConfigLaunch(config, "claude_code", []).ok).toBe(true);
    const r = resolveHarnessConfigLaunch(config, "claude_code", ["MY_PROVIDER_KEY"]);
    expect(r).toEqual({ ok: false, error: "env.MY_PROVIDER_KEY is owned by SoloW" });
  });
});

describe("mergeHarnessSettings", () => {
  test("keeps the operator's hooks and appends the app's", () => {
    const user = { hooks: { PreToolUse: [{ matcher: "Edit" }] }, model: "sonnet" };
    const app = { hooks: { PreToolUse: [{ matcher: "Bash" }] } };
    expect(mergeHarnessSettings(user, app)).toEqual({
      hooks: { PreToolUse: [{ matcher: "Edit" }, { matcher: "Bash" }] },
      model: "sonnet",
    });
  });

  test("the app's scalar wins", () => {
    expect(mergeHarnessSettings({ a: 1, b: { c: 1 } }, { b: { c: 2 } })).toEqual({
      a: 1,
      b: { c: 2 },
    });
  });
});
