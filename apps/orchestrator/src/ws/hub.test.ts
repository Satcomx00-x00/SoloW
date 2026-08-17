import { describe, expect, it } from "bun:test";
import type { TaskEvent } from "@gatecontrol/contracts";
import { EventHub } from "./hub.js";

describe("EventHub", () => {
  it("delivers to subscribers of a channel and unsubscribes", () => {
    const hub = new EventHub();
    const got: TaskEvent[] = [];
    const unsub = hub.subscribe("c1", (m) => got.push(m));
    const evt: TaskEvent = { kind: "status", taskId: "t", state: "running", at: new Date().toISOString() };
    hub.publish("c1", evt);
    hub.publish("other", evt); // different channel, ignored
    unsub();
    hub.publish("c1", evt); // after unsubscribe, ignored
    expect(got).toHaveLength(1);
  });

  it("scopes channels by workspace", () => {
    const hub = new EventHub();
    expect(hub.taskChannel("w1", "t1")).toBe("ws:w1:task:t1");
    expect(hub.taskChannel("w2", "t1")).not.toBe(hub.taskChannel("w1", "t1"));
  });
});
