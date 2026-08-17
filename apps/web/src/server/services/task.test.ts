import { describe, expect, it } from "vitest";
import { TaskErrorCode, type TaskState } from "@gatecontrol/contracts";
import { buildCreateTaskPayload, canTransitionTask, isLaunchable } from "./task.js";

describe("canTransitionTask", () => {
  it("allows the core loop transitions", () => {
    expect(canTransitionTask("backlog", "ready").ok).toBe(true);
    expect(canTransitionTask("ready", "running").ok).toBe(true);
    expect(canTransitionTask("running", "review").ok).toBe(true);
    expect(canTransitionTask("review", "done").ok).toBe(true);
    expect(canTransitionTask("running", "parked").ok).toBe(true);
    expect(canTransitionTask("parked", "running").ok).toBe(true);
    expect(canTransitionTask("failed", "running").ok).toBe(true); // retry
    expect(canTransitionTask("review", "running").ok).toBe(true); // request_changes
    expect(canTransitionTask("review", "ready").ok).toBe(true); // reject
  });

  it("rejects illegal transitions with a typed error", () => {
    const cases: [TaskState, TaskState][] = [
      ["backlog", "running"],
      ["ready", "done"],
      ["done", "running"],
      ["running", "done"],
      ["parked", "review"],
    ];
    for (const [from, to] of cases) {
      const r = canTransitionTask(from, to);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe(TaskErrorCode.IllegalTransition);
    }
  });
});

describe("buildCreateTaskPayload", () => {
  it("stamps workspaceId and starts at backlog", () => {
    const r = buildCreateTaskPayload(
      {
        issueId: "i1",
        title: "T",
        agentProfileId: "a1",
        executorProfileId: "e1",
        repositoryId: "r1",
      },
      { workspaceId: "w1" },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.workspaceId).toBe("w1");
      expect(r.data.state).toBe("backlog");
    }
  });
});

describe("isLaunchable", () => {
  it("only ready is launchable", () => {
    expect(isLaunchable("ready")).toBe(true);
    expect(isLaunchable("backlog")).toBe(false);
    expect(isLaunchable("running")).toBe(false);
  });
});
