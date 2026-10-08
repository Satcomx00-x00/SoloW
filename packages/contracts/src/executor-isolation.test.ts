import { describe, expect, it } from "bun:test";
import { preferredExecutorKind, runsUnattendedOnHost } from "./executor-isolation.js";

describe("preferredExecutorKind", () => {
  it("starts from the container when there is one, and the host only when there is not", () => {
    expect(preferredExecutorKind(true)).toBe("docker");
    expect(preferredExecutorKind(false)).toBe("local");
  });
});

describe("runsUnattendedOnHost", () => {
  it("is true only for never-ask on the local executor", () => {
    expect(runsUnattendedOnHost("local", "bypassPermissions")).toBe(true);
    expect(runsUnattendedOnHost("local", "acceptEdits")).toBe(false);
    expect(runsUnattendedOnHost("local", "plan")).toBe(false);
    expect(runsUnattendedOnHost("docker", "bypassPermissions")).toBe(false);
    expect(runsUnattendedOnHost(undefined, "bypassPermissions")).toBe(false);
    expect(runsUnattendedOnHost("local", undefined)).toBe(false);
  });
});
