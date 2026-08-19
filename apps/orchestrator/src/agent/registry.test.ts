/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { AgentRegistry } from "./registry.js";
import type { AgentHandle } from "./runner.js";

/**
 * Live agent registry (tasks TASK-014 / TASK-022). The registry is what lets a terminal reach a
 * running agent, so the thing worth pinning down is that it reaches *only* the right one: keys
 * carry the Workspace, and an entry disappears the moment its run ends.
 */

function fakeHandle(): AgentHandle & { inputs: string[]; stopped: boolean } {
  const state = {
    inputs: [] as string[],
    stopped: false,
    outcome: Promise.resolve({ kind: "completed" as const }),
    async send(text: string) {
      state.inputs.push(text);
      return true;
    },
    async stop() {
      state.stopped = true;
    },
  };
  return state;
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
