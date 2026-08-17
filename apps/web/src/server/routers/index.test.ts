/// <reference types="bun-types" />

import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { workspace } from "@gatecontrol/db";
import { createTestDb, type TestDb } from "@gatecontrol/db/testing";
import { RATE_LIMITS, resetRateLimits } from "../rate-limit.js";
import type { BaseContext } from "../trpc.js";
import { appRouter } from "./index.js";

/**
 * tRPC integration tests (task TASK-012). Exercises the full Parse → Authorize → Ownership →
 * DTO discipline against a real (in-memory) SQLite DB: auth, flag guard, cross-Workspace
 * isolation, input validation, write rate limiting, and the secret write-only contract.
 */

async function seedWs(db: TestDb, name: string): Promise<string> {
  const [row] = await db
    .insert(workspace)
    .values({ name, ownerUserId: `owner-${name}` })
    .returning();
  if (!row) throw new Error("failed to seed workspace");
  return row.id;
}

function ctx(
  db: TestDb,
  workspaceId: string | null,
  opts?: { flag?: boolean; userId?: string },
): BaseContext {
  const flag = opts?.flag ?? true;
  return {
    db,
    session: workspaceId ? { workspaceId, userId: opts?.userId ?? "user-1" } : null,
    ...(flag ? { flagOverrides: { "ff-core-program": true } } : {}),
  };
}

function caller(
  db: TestDb,
  workspaceId: string | null,
  opts?: { flag?: boolean; userId?: string },
) {
  return appRouter.createCaller(ctx(db, workspaceId, opts));
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

/** Full fixture chain for a task: secret → agent/executor profile → repo → issue. */
async function taskFixtures(db: TestDb, wsId: string) {
  const c = caller(db, wsId);
  const secret = await c.secret.set({ name: "sub", kind: "subscription_token", value: "tok" });
  const agent = await c.profile.agent.create({
    name: "Claude",
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
  const issue = await c.issue.create({ title: "Fix latch" });
  return { c, agentId: agent.id, executorId: executor.id, repoId: repo.id, issueId: issue.id };
}

describe("tRPC router integration", () => {
  let db: TestDb;

  beforeAll(() => {
    process.env.GATECONTROL_SECRET_KEY ??= Buffer.alloc(32, 5).toString("base64");
  });

  beforeEach(() => {
    db = createTestDb();
    resetRateLimits();
  });

  it("rejects unauthenticated calls with UNAUTHORIZED", async () => {
    const c = caller(db, null);
    expect(await errCode(() => c.issue.list({}))).toBe("UNAUTHORIZED");
  });

  it("blocks every procedure when the flag is OFF (kill switch)", async () => {
    const wsId = await seedWs(db, "acme");
    const c = caller(db, wsId, { flag: false });
    expect(await errCode(() => c.issue.list({}))).toBe("FORBIDDEN");
  });

  it("creates and reads an issue through the full pipeline", async () => {
    const wsId = await seedWs(db, "acme");
    const c = caller(db, wsId);
    const created = await c.issue.create({ title: "Gate motor whines" });
    const fetched = await c.issue.get({ id: created.id });
    expect(fetched.title).toBe("Gate motor whines");
    expect(fetched.taskCount).toBe(0);
  });

  it("rejects invalid input with BAD_REQUEST (Zod parse)", async () => {
    const wsId = await seedWs(db, "acme");
    const c = caller(db, wsId);
    expect(await errCode(() => c.issue.create({ title: "" }))).toBe("BAD_REQUEST");
  });

  it("enforces cross-Workspace isolation — B cannot read A's issue", async () => {
    const wsA = await seedWs(db, "workspace-a");
    const wsB = await seedWs(db, "workspace-b");
    const issueA = await caller(db, wsA).issue.create({ title: "A only" });
    expect(await errCode(() => caller(db, wsB).issue.get({ id: issueA.id }))).toBe("NOT_FOUND");
    // A still sees its own.
    expect((await caller(db, wsA).issue.get({ id: issueA.id })).title).toBe("A only");
  });

  it("secret.set returns metadata only — never echoes the value", async () => {
    const wsId = await seedWs(db, "acme");
    const c = caller(db, wsId);
    const ref = await c.secret.set({ name: "api", kind: "api_key", value: "sk-ant-secret" });
    expect(ref).toEqual({ id: ref.id, name: "api", kind: "api_key" });
    expect(JSON.stringify(ref)).not.toContain("sk-ant-secret");
  });

  it("rate-limits secret.set per Owner past the window limit", async () => {
    const wsId = await seedWs(db, "acme");
    const c = caller(db, wsId);
    const { limit } = RATE_LIMITS["secret.set"];
    for (let i = 0; i < limit; i++) {
      await c.secret.set({ name: `s${i}`, kind: "api_key", value: "v" });
    }
    expect(await errCode(() => c.secret.set({ name: "over", kind: "api_key", value: "v" }))).toBe(
      "TOO_MANY_REQUESTS",
    );
  });

  it("creates a task and moves it through legal transitions, rejecting illegal ones", async () => {
    const wsId = await seedWs(db, "acme");
    const { c, agentId, executorId, repoId, issueId } = await taskFixtures(db, wsId);

    const task = await c.task.create({
      issueId,
      title: "Investigate latch",
      agentProfileId: agentId,
      executorProfileId: executorId,
      repositoryId: repoId,
    });
    expect(task.state).toBe("backlog");

    const moved = await c.task.move({ id: task.id, to: "ready" });
    expect(moved.state).toBe("ready");

    // ready→done is not a legal transition (only ready→running / ready→backlog are).
    expect(await errCode(() => c.task.move({ id: task.id, to: "done" }))).toBe("BAD_REQUEST");
  });

  it("scopes task.create ownership — cannot attach to another Workspace's issue", async () => {
    const wsA = await seedWs(db, "workspace-a");
    const wsB = await seedWs(db, "workspace-b");
    const fx = await taskFixtures(db, wsA);
    // B builds its own profiles/repo but points at A's issue id.
    const b = await taskFixtures(db, wsB);
    expect(
      await errCode(() =>
        b.c.task.create({
          issueId: fx.issueId, // A's issue
          title: "cross-tenant",
          agentProfileId: b.agentId,
          executorProfileId: b.executorId,
          repositoryId: b.repoId,
        }),
      ),
    ).not.toBe("OK");
  });
});
