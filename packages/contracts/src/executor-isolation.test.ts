import { describe, expect, it } from "bun:test";
import {
  preferredExecutorKind,
  quickTaskProfiles,
  runsUnattendedOnHost,
} from "./executor-isolation.js";

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

describe("quickTaskProfiles", () => {
  const harnesses = [
    { id: "h-new", createdAt: "2026-03-01T00:00:00.000Z" },
    { id: "h-old", createdAt: "2026-01-01T00:00:00.000Z" },
  ];
  const executors = [
    { id: "x-docker", kind: "docker" as const, createdAt: "2026-03-01T00:00:00.000Z" },
    { id: "x-local", kind: "local" as const, createdAt: "2026-01-01T00:00:00.000Z" },
  ];

  it("takes the stored defaults when there are some", () => {
    expect(
      quickTaskProfiles({
        stored: { harnessProfileId: "h-new", executorProfileId: "x-local" },
        harnesses,
        executors,
      }),
    ).toEqual({ agentProfileId: "h-new", executorProfileId: "x-local" });
  });

  it("otherwise takes the oldest harness, whatever order the list came in", () => {
    expect(quickTaskProfiles({ stored: null, harnesses, executors }).agentProfileId).toBe("h-old");
    const reversed = [...harnesses].reverse();
    expect(quickTaskProfiles({ stored: null, harnesses: reversed, executors }).agentProfileId).toBe(
      "h-old",
    );
  });

  it("otherwise prefers a Docker executor over an older local one", () => {
    expect(quickTaskProfiles({ stored: null, harnesses, executors }).executorProfileId).toBe(
      "x-docker",
    );
  });

  it("falls back to the oldest executor when none is a container", () => {
    const locals = [
      { id: "x-b", kind: "local" as const, createdAt: "2026-02-01T00:00:00.000Z" },
      { id: "x-a", kind: "local" as const, createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    expect(
      quickTaskProfiles({ stored: null, harnesses, executors: locals }).executorProfileId,
    ).toBe("x-a");
  });

  it("answers null for a kind the Workspace has none of", () => {
    expect(quickTaskProfiles({ stored: null, harnesses: [], executors: [] })).toEqual({
      agentProfileId: null,
      executorProfileId: null,
    });
  });
});
