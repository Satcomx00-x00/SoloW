/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { AgentRegistry } from "./registry.js";
import type { AgentHandle } from "./runner.js";

/**
 * Live agent registry (tasks TASK-014 / TASK-022). The registry is what lets a terminal reach a
 * running agent, so the thing worth pinning down is that it reaches *only* the right one: keys
 * carry the Workspace, and an entry disappears the moment its run ends.
 */

function fakeHandle(): AgentHandle & {
  inputs: string[];
  stopped: boolean;
  answers: Array<{ requestId: string; optionId: string }>;
} {
  const state = {
    inputs: [] as string[],
    stopped: false,
    answers: [] as Array<{ requestId: string; optionId: string }>,
    outcome: Promise.resolve({ kind: "completed" as const }),
    workspacePath: Promise.resolve<string | null>("/wt/task-1"),
    async send(text: string) {
      state.inputs.push(text);
      return true;
    },
    async respondPermission(requestId: string, optionId: string) {
      state.answers.push({ requestId, optionId });
      return "answered" as const;
    },
    async stop() {
      state.stopped = true;
    },
  };
  return state;
}

/** A runner whose protocol has no permission channel — Claude Code's stream-JSON, in practice. */
function handleWithoutPermissions(): AgentHandle {
  return {
    outcome: Promise.resolve({ kind: "completed" as const }),
    workspacePath: Promise.resolve<string | null>("/wt/task-1"),
    async send() {
      return true;
    },
    async stop() {},
  };
}

describe("AgentRegistry", () => {
  it("routes input to the agent of the named Task", async () => {
    const registry = new AgentRegistry();
    const a = fakeHandle();
    const b = fakeHandle();
    registry.register("ws-a", { taskId: "task-1", sessionId: "s1", handle: a });
    registry.register("ws-a", { taskId: "task-2", sessionId: "s2", handle: b });

    expect(await registry.send("ws-a", "task-1", "keep going")).toBe(true);
    expect(a.inputs).toEqual(["keep going"]);
    expect(b.inputs).toEqual([]);
  });

  it("does not reach another Workspace's agent under the same Task id", async () => {
    // Ids are opaque; nothing stops two Workspaces holding the same string. The tenant key is
    // what separates them, so a lookup with the wrong Workspace must find nothing (Principle V).
    const registry = new AgentRegistry();
    const theirs = fakeHandle();
    registry.register("ws-b", { taskId: "task-1", sessionId: "s1", handle: theirs });

    expect(await registry.send("ws-a", "task-1", "steer")).toBe(false);
    expect(await registry.stop("ws-a", "task-1")).toBe(false);
    expect(theirs.inputs).toEqual([]);
    expect(theirs.stopped).toBe(false);
  });

  it("reports that nothing was delivered when no agent is running", async () => {
    const registry = new AgentRegistry();
    expect(await registry.send("ws-a", "task-1", "hello")).toBe(false);
    expect(await registry.stop("ws-a", "task-1")).toBe(false);
  });

  it("stops the agent it holds", async () => {
    const registry = new AgentRegistry();
    const handle = fakeHandle();
    registry.register("ws-a", { taskId: "task-1", sessionId: "s1", handle });

    expect(await registry.stop("ws-a", "task-1")).toBe(true);
    expect(handle.stopped).toBe(true);
  });

  it("routes a permission answer to the agent of the named Task (issue #58, AC-4)", async () => {
    const registry = new AgentRegistry();
    const mine = fakeHandle();
    registry.register("ws-a", { taskId: "task-1", sessionId: "s1", handle: mine });

    expect(await registry.respondPermission("ws-a", "task-1", "req-1", "allow")).toBe("answered");
    expect(mine.answers).toEqual([{ requestId: "req-1", optionId: "allow" }]);
  });

  it("does not let one Workspace answer another's permission prompt (Principle V)", async () => {
    // Granting a file write on someone else's agent is a strictly worse version of steering it.
    const registry = new AgentRegistry();
    const theirs = fakeHandle();
    registry.register("ws-b", { taskId: "task-1", sessionId: "s1", handle: theirs });

    // Indistinguishable from no agent at all, deliberately: a client must not learn that
    // another Workspace has a Task of that id (Principle V).
    expect(await registry.respondPermission("ws-a", "task-1", "req-1", "allow")).toBe("no_agent");
    expect(theirs.answers).toEqual([]);
  });

  it("reports that a permission answer reached nothing when the protocol has no channel", async () => {
    const registry = new AgentRegistry();
    registry.register("ws-a", {
      taskId: "task-1",
      sessionId: "s1",
      handle: handleWithoutPermissions(),
    });

    // Two different nothings: a live agent whose protocol has no permission channel, and no
    // agent at all. The operator's terminal says something true about each.
    expect(await registry.respondPermission("ws-a", "task-1", "req-1", "allow")).toBe(
      "no_permission_channel",
    );
    expect(await registry.respondPermission("ws-a", "task-9", "req-1", "allow")).toBe("no_agent");
  });

  it("deregistering removes the entry", async () => {
    const registry = new AgentRegistry();
    const handle = fakeHandle();
    const deregister = registry.register("ws-a", { taskId: "task-1", sessionId: "s1", handle });

    deregister();
    expect(registry.size).toBe(0);
    expect(await registry.send("ws-a", "task-1", "too late")).toBe(false);
  });

  it("a late deregister does not unhook the retry that replaced it", async () => {
    // A retried Task registers a new run while the old one is still unwinding; if the old
    // deregister removed by key alone it would silently orphan the live agent.
    const registry = new AgentRegistry();
    const first = fakeHandle();
    const second = fakeHandle();
    const deregisterFirst = registry.register("ws-a", {
      taskId: "task-1",
      sessionId: "s1",
      handle: first,
    });
    registry.register("ws-a", { taskId: "task-1", sessionId: "s2", handle: second });

    deregisterFirst();
    expect(await registry.send("ws-a", "task-1", "still steering")).toBe(true);
    expect(second.inputs).toEqual(["still steering"]);
  });
});
