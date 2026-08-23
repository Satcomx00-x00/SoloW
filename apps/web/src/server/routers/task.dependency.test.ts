/// <reference types="bun-types" />

import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { TaskDependencyErrorCode, type TaskState } from "@gatecontrol/contracts";
import {
  buildDependencyGraph,
  type DependencyGraph,
  parseDependencyCycleMessage,
} from "@gatecontrol/core";
import { ensureDefaultAgentCatalog, issue as issueTable, workspace } from "@gatecontrol/db";
import { createTestDb, type TestDb } from "@gatecontrol/db/testing";
import { dispatch } from "../mcp/protocol.js";
import { resetRateLimits } from "../rate-limit.js";
import type { BaseContext } from "../trpc.js";
import { appRouter } from "./index.js";

/**
 * Task dependency integration tests (issue #6) against a real in-memory SQLite database, so the
 * edge table, its unique index and the workspace scoping are exercised rather than described.
 *
 * The graph reasoning itself is unit-tested in `@gatecontrol/core`; what is proved here is that
 * the router reaches for it before writing, and that *every* automated start path goes through
 * the same gate — the invariant the issue says will otherwise be missed by whichever path is
 * added next.
 */

function ctx(db: TestDb, workspaceId: string): BaseContext {
  return {
    db,
    session: { workspaceId, userId: "user-1" },
    flagOverrides: { "ff-core-program": true },
  };
}

function caller(db: TestDb, workspaceId: string) {
  return appRouter.createCaller(ctx(db, workspaceId));
}

async function seedWs(db: TestDb, name: string): Promise<string> {
  const [row] = await db
    .insert(workspace)
    .values({ name, ownerUserId: `owner-${name}` })
    .returning();
  if (!row) throw new Error("failed to seed workspace");
  return row.id;
}

/** Is `start` reachable from itself by walking `blocked_by` edges? A cycle, in other words. */
function findsCycleFrom(graph: DependencyGraph, start: string): boolean {
  const seen = new Set<string>();
  const stack = [...(graph.get(start) ?? [])];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) continue;
    if (node === start) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    stack.push(...(graph.get(node) ?? []));
  }
  return false;
}

/** Run a call and return the TRPCError code, or "OK" if it resolved. */
async function errCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "OK";
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
}

/** Run a call and return the TRPCError message, or "OK" if it resolved. */
async function errMessage(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "OK";
  } catch (e) {
    return (e as { message?: string }).message ?? String(e);
  }
}

/** A Workspace with everything a Task needs, plus a `newTask` shorthand. */
async function fixture(db: TestDb, name: string) {
  const wsId = await seedWs(db, name);
  const c = caller(db, wsId);
  const agentCatalogId = await ensureDefaultAgentCatalog(db, wsId);
  const { secret } = await c.secret.set({ name: "sub", kind: "subscription_token", value: "tok" });
  const agent = await c.profile.agent.create({
    name: "Claude",
    agentCatalogId,
    authMode: "subscription",
    secretId: secret.id,
    concurrencyCap: 3,
  });
  const executor = await c.profile.executor.create({ name: "Local" });
  const repo = await c.repository.connect({
    name: "repo",
    source: "local_path",
    location: "/srv/repo",
  });
  const [issue] = await db
    .insert(issueTable)
    .values({ workspaceId: wsId, title: "Fix latch" })
    .returning();
  if (!issue) throw new Error("failed to seed issue");

  const newTask = async (title: string) =>
    await c.task.create({
      issueId: issue.id,
      title,
      agentProfileId: agent.id,
      executorProfileId: executor.id,
      repositories: [{ repositoryId: repo.id }],
    });

  return { wsId, c, newTask };
}

/** Walk a Task through legal transitions — the only way a state is reached in these tests. */
async function walk(
  c: ReturnType<typeof caller>,
  id: string,
  states: readonly TaskState[],
): Promise<void> {
  for (const to of states) await c.task.move({ id, to });
}

describe("task dependencies", () => {
  let db: TestDb;

  beforeAll(() => {
    process.env.GATECONTROL_SECRET_KEY ??= Buffer.alloc(32, 5).toString("base64");
    process.env.GATECONTROL_STREAM_SECRET ??= "test-stream-secret";
    process.env.GATECONTROL_AUTH_SECRET ??= "test-auth-secret";
    // Launch hands the run to the orchestrator; dev mode logs-and-returns so these tests can
    // exercise the start paths without a workflow engine running.
    process.env.GATECONTROL_DEV_OWNER ??= "on";
  });

  beforeEach(() => {
    db = createTestDb();
    resetRateLimits();
  });

  describe("AC-1 — declaring that a Task is blocked by others", () => {
    it("records an edge and reports the blocker's title and state", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const a = await newTask("Wire the latch");
      const b = await newTask("Order the servo");

      const after = await c.task.addDependency({ taskId: a.id, blockedByTaskId: b.id });
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({
        taskId: a.id,
        blockedByTaskId: b.id,
        blockedByTitle: "Order the servo",
        blockedByState: "backlog",
      });
    });

    it("accepts several blockers for one Task", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const a = await newTask("A");
      const b = await newTask("B");
      const d = await newTask("D");

      await c.task.addDependency({ taskId: a.id, blockedByTaskId: b.id });
      const after = await c.task.addDependency({ taskId: a.id, blockedByTaskId: d.id });
      expect(after.map((e) => e.blockedByTaskId).sort()).toEqual([b.id, d.id].sort());
    });

    it("treats re-declaring an existing dependency as a no-op, not a duplicate", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const a = await newTask("A");
      const b = await newTask("B");

      await c.task.addDependency({ taskId: a.id, blockedByTaskId: b.id });
      const after = await c.task.addDependency({ taskId: a.id, blockedByTaskId: b.id });
      expect(after).toHaveLength(1);
    });

    it("withdraws a dependency, and refuses to withdraw one that is not there", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const a = await newTask("A");
      const b = await newTask("B");

      await c.task.addDependency({ taskId: a.id, blockedByTaskId: b.id });
      expect(await c.task.removeDependency({ taskId: a.id, blockedByTaskId: b.id })).toEqual([]);
      expect(
        await errCode(() => c.task.removeDependency({ taskId: a.id, blockedByTaskId: b.id })),
      ).toBe("NOT_FOUND");
    });
  });

  describe("AC-2 — a cycle is refused, and the offending path is named", () => {
    it("refuses the edge that would close a two-cycle and writes nothing", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const a = await newTask("A");
      const b = await newTask("B");
      await c.task.addDependency({ taskId: a.id, blockedByTaskId: b.id });

      const message = await errMessage(() =>
        c.task.addDependency({ taskId: b.id, blockedByTaskId: a.id }),
      );
      expect(message.startsWith(`${TaskDependencyErrorCode.Cycle}: `)).toBe(true);
      expect(parseDependencyCycleMessage(message)).toEqual([b.id, a.id, b.id]);
      // The refusal is a refusal: B has no dependencies.
      expect(await c.task.dependencies({ taskId: b.id })).toEqual([]);
    });

    it("names every hop of a longer cycle", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const a = await newTask("A");
      const b = await newTask("B");
      const d = await newTask("D");
      await c.task.addDependency({ taskId: a.id, blockedByTaskId: b.id });
      await c.task.addDependency({ taskId: b.id, blockedByTaskId: d.id });

      const message = await errMessage(() =>
        c.task.addDependency({ taskId: d.id, blockedByTaskId: a.id }),
      );
      expect(parseDependencyCycleMessage(message)).toEqual([d.id, a.id, b.id, d.id]);
      expect(await c.task.dependencies({ taskId: d.id })).toEqual([]);
    });

    it("refuses a Task that would block itself", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const a = await newTask("A");

      const message = await errMessage(() =>
        c.task.addDependency({ taskId: a.id, blockedByTaskId: a.id }),
      );
      expect(parseDependencyCycleMessage(message)).toEqual([a.id, a.id]);
      expect(await c.task.dependencies({ taskId: a.id })).toEqual([]);
    });

    it("lets only one of two concurrent adds through, so a race cannot persist a cycle", async () => {
      // The check and the insert used to be two statements: both calls read the empty graph,
      // both passed the check, and both inserted — leaving A ← B and B ← A, two Tasks that can
      // never start and can never reach done to unblock each other. Fired together on purpose;
      // the second handler must see the first one's edge.
      const { c, newTask } = await fixture(db, "acme");
      const a = await newTask("A");
      const b = await newTask("B");

      const settled = await Promise.allSettled([
        c.task.addDependency({ taskId: a.id, blockedByTaskId: b.id }),
        c.task.addDependency({ taskId: b.id, blockedByTaskId: a.id }),
      ]);
      expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);

      const edges = await c.task.dependencies({});
      expect(edges).toHaveLength(1);
      const rejected = settled.find((r) => r.status === "rejected");
      expect(
        String((rejected as PromiseRejectedResult).reason.message).startsWith(
          `${TaskDependencyErrorCode.Cycle}: `,
        ),
      ).toBe(true);
    });

    it("keeps a three-way race acyclic too", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const x = await newTask("X");
      const y = await newTask("Y");
      const z = await newTask("Z");

      await Promise.allSettled([
        c.task.addDependency({ taskId: x.id, blockedByTaskId: y.id }),
        c.task.addDependency({ taskId: y.id, blockedByTaskId: z.id }),
        c.task.addDependency({ taskId: z.id, blockedByTaskId: x.id }),
      ]);

      // Whichever two landed, the third closed the ring and must have been refused — so the
      // surviving graph is a chain, and every one of the three Tasks still has a way to start.
      const edges = await c.task.dependencies({});
      expect(edges).toHaveLength(2);
      const graph = buildDependencyGraph(edges);
      for (const id of [x.id, y.id, z.id]) expect(findsCycleFrom(graph, id)).toBe(false);
    });

    it("still accepts a diamond, which only looks like a cycle", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const a = await newTask("A");
      const b = await newTask("B");
      const d = await newTask("D");
      const e = await newTask("E");

      await c.task.addDependency({ taskId: a.id, blockedByTaskId: b.id });
      await c.task.addDependency({ taskId: a.id, blockedByTaskId: d.id });
      await c.task.addDependency({ taskId: b.id, blockedByTaskId: e.id });
      const after = await c.task.addDependency({ taskId: d.id, blockedByTaskId: e.id });
      expect(after.map((edge) => edge.blockedByTaskId)).toEqual([e.id]);
    });
  });

  describe("AC-3 — a blocked Task is not started by any automated path", () => {
    it("refuses task.launch even when the Task is ready and under its concurrency cap", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const a = await newTask("Blocked");
      const b = await newTask("Blocker");
      await c.task.addDependency({ taskId: a.id, blockedByTaskId: b.id });
      await walk(c, a.id, ["ready"]);

      expect(await errMessage(() => c.task.launch({ id: a.id }))).toBe(
        TaskDependencyErrorCode.Blocked,
      );
      expect(await errCode(() => c.task.launch({ id: a.id }))).toBe("BAD_REQUEST");
      expect((await c.task.get({ id: a.id })).state).toBe("ready");
    });

    it("refuses task.retry on a failed Task whose predecessor is still outstanding", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const a = await newTask("Blocked");
      const b = await newTask("Blocker");
      // A ran once and failed before the dependency was declared.
      await walk(c, a.id, ["ready", "running", "failed"]);
      await c.task.addDependency({ taskId: a.id, blockedByTaskId: b.id });

      expect(await errMessage(() => c.task.retry({ id: a.id }))).toBe(
        TaskDependencyErrorCode.Blocked,
      );
      expect((await c.task.get({ id: a.id })).state).toBe("failed");
    });

    it("refuses task.move into running, but still allows moves that are not starts", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const a = await newTask("Blocked");
      const b = await newTask("Blocker");
      await c.task.addDependency({ taskId: a.id, blockedByTaskId: b.id });

      expect((await c.task.move({ id: a.id, to: "ready" })).state).toBe("ready");
      expect(await errMessage(() => c.task.move({ id: a.id, to: "running" }))).toBe(
        TaskDependencyErrorCode.Blocked,
      );
      expect((await c.task.move({ id: a.id, to: "backlog" })).state).toBe("backlog");
    });

    it("launches a Task with no dependencies, so the gate is not blocking everything", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const a = await newTask("Free");
      await walk(c, a.id, ["ready"]);

      expect((await c.task.launch({ id: a.id })).state).toBe("running");
    });

    it("refuses task_launch called over MCP, and leaves the Task where it was", async () => {
      // AC-3 says "any automated path", and MCP is the path an agent takes. Driven through the
      // real JSON-RPC dispatcher rather than by asserting the tool names exist: the claim is that
      // the MCP surface *inherits* the gate, and a list of procedure keys would still be correct
      // if MCP dispatched somewhere else entirely.
      const { wsId, c, newTask } = await fixture(db, "acme");
      const a = await newTask("Blocked");
      const b = await newTask("Blocker");
      await c.task.addDependency({ taskId: a.id, blockedByTaskId: b.id });
      await walk(c, a.id, ["ready"]);

      const refused = await dispatch(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "task_launch", arguments: { id: a.id } },
        },
        { ctx: ctx(db, wsId), scope: "read_write" },
      );
      expect(refused?.error?.message).toBe(TaskDependencyErrorCode.Blocked);
      expect((await c.task.get({ id: a.id })).state).toBe("ready");

      // And the same tool starts an unblocked Task, so the refusal is the gate and not the tool.
      const free = await newTask("Free");
      await walk(c, free.id, ["ready"]);
      const started = await dispatch(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "task_launch", arguments: { id: free.id } },
        },
        { ctx: ctx(db, wsId), scope: "read_write" },
      );
      expect(started?.error).toBeUndefined();
      expect((await c.task.get({ id: free.id })).state).toBe("running");
    });

    it("refuses a review decision that would resume a blocked Task, and records nothing", async () => {
      // `review.decide`'s request_changes puts the Task back into `running` — a resume is a
      // start, so the same refusal `task.move` gives has to arrive here too. Otherwise one state
      // change is refused on the board and permitted through a procedure that is also an MCP tool.
      const { c, newTask } = await fixture(db, "acme");
      const a = await newTask("Under review");
      const b = await newTask("Blocker");
      await walk(c, a.id, ["ready"]);
      await c.task.launch({ id: a.id });
      await walk(c, a.id, ["review"]);
      const [session] = await c.session.listForTask({ taskId: a.id });
      if (!session) throw new Error("launch recorded no session");
      await c.task.addDependency({ taskId: a.id, blockedByTaskId: b.id });

      expect(
        await errMessage(() =>
          c.review.decide({
            sessionId: session.id,
            decision: "request_changes",
            feedback: "tighten the latch",
          }),
        ),
      ).toBe(TaskDependencyErrorCode.Blocked);
      expect((await c.task.get({ id: a.id })).state).toBe("review");
      // Refused before anything was written: no decision is left behind for the Owner to undo.
      expect((await c.session.get({ sessionId: session.id })).review).toBeNull();

      // A decision that is not a start is untouched by the gate — rejecting sends it back to Ready.
      expect((await c.review.decide({ sessionId: session.id, decision: "reject" })).decision).toBe(
        "reject",
      );
      expect((await c.task.get({ id: a.id })).state).toBe("ready");
    });
  });

  describe("AC-4 — the Task becomes launchable once every predecessor is done", () => {
    it("opens the gate the moment the last blocker reaches done", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const a = await newTask("Blocked");
      const b = await newTask("Blocker");
      await c.task.addDependency({ taskId: a.id, blockedByTaskId: b.id });
      await walk(c, a.id, ["ready"]);
      expect(await errMessage(() => c.task.launch({ id: a.id }))).toBe(
        TaskDependencyErrorCode.Blocked,
      );

      await walk(c, b.id, ["ready", "running", "review", "done"]);

      // Readiness is derived, so nothing had to run to clear a flag.
      const deps = await c.task.dependencies({ taskId: a.id });
      expect(deps[0]?.blockedByState).toBe("done");
      expect((await c.task.launch({ id: a.id })).state).toBe("running");
    });

    it("keeps the gate shut while any one of several blockers is outstanding", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const a = await newTask("Blocked");
      const b = await newTask("First");
      const d = await newTask("Second");
      await c.task.addDependency({ taskId: a.id, blockedByTaskId: b.id });
      await c.task.addDependency({ taskId: a.id, blockedByTaskId: d.id });
      await walk(c, a.id, ["ready"]);

      await walk(c, b.id, ["ready", "running", "review", "done"]);
      expect(await errMessage(() => c.task.launch({ id: a.id }))).toBe(
        TaskDependencyErrorCode.Blocked,
      );

      await walk(c, d.id, ["ready", "running", "review", "done"]);
      expect((await c.task.launch({ id: a.id })).state).toBe("running");
    });
  });

  describe("AC-5 — edges are Workspace-scoped (Principle V)", () => {
    it("refuses an edge pointing at another Workspace's Task and writes nothing", async () => {
      const a = await fixture(db, "workspace-a");
      const b = await fixture(db, "workspace-b");
      const mine = await b.newTask("Mine");
      const theirs = await a.newTask("Theirs");

      expect(
        await errCode(() =>
          b.c.task.addDependency({ taskId: mine.id, blockedByTaskId: theirs.id }),
        ),
      ).toBe("NOT_FOUND");
      expect(await b.c.task.dependencies({ taskId: mine.id })).toEqual([]);
      // And the same refusal in the other direction — a foreign Task cannot be given a blocker.
      expect(
        await errCode(() =>
          b.c.task.addDependency({ taskId: theirs.id, blockedByTaskId: mine.id }),
        ),
      ).toBe("NOT_FOUND");
    });

    it("never shows one Workspace another's edges", async () => {
      const a = await fixture(db, "workspace-a");
      const b = await fixture(db, "workspace-b");
      const a1 = await a.newTask("A1");
      const a2 = await a.newTask("A2");
      await a.c.task.addDependency({ taskId: a1.id, blockedByTaskId: a2.id });

      expect(await b.c.task.dependencies({})).toEqual([]);
      expect(await a.c.task.dependencies({})).toHaveLength(1);
    });

    it("does not let another Workspace's cycle refuse a legal edge here", async () => {
      const a = await fixture(db, "workspace-a");
      const b = await fixture(db, "workspace-b");
      const a1 = await a.newTask("A1");
      const a2 = await a.newTask("A2");
      await a.c.task.addDependency({ taskId: a1.id, blockedByTaskId: a2.id });

      // Same shape, other tenant: B declares b1 <- b2 and then b2 <- b1 would be a cycle, but
      // B's first edge must not be refused because A's graph happens to hold the mirror of it.
      const b1 = await b.newTask("B1");
      const b2 = await b.newTask("B2");
      expect(await b.c.task.addDependency({ taskId: b2.id, blockedByTaskId: b1.id })).toHaveLength(
        1,
      );
      expect(
        await errCode(() => b.c.task.addDependency({ taskId: b1.id, blockedByTaskId: b2.id })),
      ).toBe("BAD_REQUEST");
    });
  });
});
