/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { type EventPostDeps, handleEventPost } from "./events.js";

/**
 * `handleEventPost` is the one thing standing between the web app's `emit()` and the durable
 * engine (Decision 0004), so these assert the actual handoff: a well-formed POST really calls
 * `send()` with the parsed `{ name, data }`, and a malformed one is rejected before `send()` is
 * ever reached.
 *
 * `send` is injected (`EventPostDeps`) rather than exercised against the real `inngest`
 * singleton: that singleton snapshots `INNGEST_DEV`/`INNGEST_EVENT_KEY` once, at import time,
 * and `bun:test` loads every test file's imports into one shared module registry — another
 * suite file importing `../client.js` first (transitively, e.g. via `task-run.ts`) would freeze
 * the singleton into cloud mode before this file's own env setup ever ran. Injection sidesteps
 * that entirely and keeps the assertion to what this module actually owns: does a well-formed
 * envelope reach `send()` unchanged, and does a malformed one not reach it at all.
 */

const SECRET = "test-orchestrator-secret";

function post(body: unknown, authorization: string | null = `Bearer ${SECRET}`): Request {
  return new Request("http://orchestrator.local/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization === null ? {} : { authorization }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function fakeDeps(): { deps: EventPostDeps; calls: Array<{ name: string; data: unknown }> } {
  const calls: Array<{ name: string; data: unknown }> = [];
  return {
    calls,
    deps: {
      secret: SECRET,
      send: async (payload) => {
        calls.push(payload);
        return { ids: ["evt_test"] };
      },
    },
  };
}

describe("handleEventPost", () => {
  it("sends a well-formed event to the durable engine and acknowledges 202", async () => {
    const { deps, calls } = fakeDeps();
    const res = await handleEventPost(
      post({ name: "task.launch.requested", data: { taskId: "t-1", sessionId: "s-1" } }),
      deps,
    );

    expect(res.status).toBe(202);
    expect(calls).toEqual([
      { name: "task.launch.requested", data: { taskId: "t-1", sessionId: "s-1" } },
    ]);
  });

  it("rejects a body missing a name without reaching the engine", async () => {
    const { deps, calls } = fakeDeps();
    const res = await handleEventPost(post({ data: { taskId: "t-1" } }), deps);

    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("rejects a body whose data is not an object without reaching the engine", async () => {
    const { deps, calls } = fakeDeps();
    const res = await handleEventPost(post({ name: "task.launch.requested", data: "nope" }), deps);

    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("rejects invalid JSON without reaching the engine", async () => {
    const { deps, calls } = fakeDeps();
    const res = await handleEventPost(post("not json"), deps);

    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("reports a send failure as 502 rather than a silent drop", async () => {
    const { calls } = fakeDeps();
    const deps: EventPostDeps = {
      secret: SECRET,
      send: async () => {
        throw new Error("dev server unreachable");
      },
    };
    const res = await handleEventPost(
      post({ name: "task.launch.requested", data: { sessionId: "s-1" } }),
      deps,
    );

    expect(res.status).toBe(502);
    expect(await res.text()).toContain("dev server unreachable");
    expect(calls).toEqual([]);
  });

  describe("authentication (B3)", () => {
    const valid = { name: "task.launch.requested", data: { taskId: "t-1" } };

    it("refuses a request with no Authorization header", async () => {
      const { deps, calls } = fakeDeps();
      const res = await handleEventPost(post(valid, null), deps);

      expect(res.status).toBe(401);
      expect(calls).toEqual([]);
    });

    it("refuses a wrong secret and a non-Bearer scheme", async () => {
      const { deps, calls } = fakeDeps();

      expect((await handleEventPost(post(valid, "Bearer nope"), deps)).status).toBe(401);
      expect((await handleEventPost(post(valid, `Basic ${SECRET}`), deps)).status).toBe(401);
      expect((await handleEventPost(post(valid, SECRET), deps)).status).toBe(401);
      expect(calls).toEqual([]);
    });

    it("authenticates before reading the body, so garbage gets 401 not 400", async () => {
      const { deps } = fakeDeps();
      const res = await handleEventPost(post("not json", null), deps);

      expect(res.status).toBe(401);
    });

    it("fails closed when no secret is configured, even for a matching empty header", async () => {
      const { deps, calls } = fakeDeps();
      const unconfigured: EventPostDeps = { ...deps, secret: undefined };

      expect((await handleEventPost(post(valid), unconfigured)).status).toBe(503);
      expect((await handleEventPost(post(valid, "Bearer "), unconfigured)).status).toBe(503);
      expect(calls).toEqual([]);
    });
  });
});
