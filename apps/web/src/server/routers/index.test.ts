/// <reference types="bun-types" />

import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { taskCheckoutBranch } from "@gatecontrol/core";
import { verifyStreamTicket } from "@gatecontrol/core/stream";
import { ensureDefaultAgentCatalog, issue as issueTable, workspace } from "@gatecontrol/db";
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

/** Full fixture chain for a task: secret → agent catalog → agent/executor profile → repo → issue. */
async function taskFixtures(db: TestDb, wsId: string) {
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
  // Issue #15 removed issue.create — every real Issue is imported, so a fixture inserts one
  // directly rather than going through the (now nonexistent) tRPC mutation.
  const [issue] = await db
    .insert(issueTable)
    .values({ workspaceId: wsId, title: "Fix latch" })
    .returning();
  if (!issue) throw new Error("failed to seed issue");
  return { c, agentId: agent.id, executorId: executor.id, repoId: repo.id, issueId: issue.id };
}

describe("tRPC router integration", () => {
  let db: TestDb;

  beforeAll(() => {
    process.env.GATECONTROL_SECRET_KEY ??= Buffer.alloc(32, 5).toString("base64");
    process.env.GATECONTROL_STREAM_SECRET ??= "test-stream-secret";
    process.env.GATECONTROL_AUTH_SECRET ??= "test-auth-secret";
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

  it("reads a seeded issue through issue.get (no issue.create — issue #15)", async () => {
    const wsId = await seedWs(db, "acme");
    const [row] = await db
      .insert(issueTable)
      .values({ workspaceId: wsId, title: "Gate motor whines" })
      .returning();
    if (!row) throw new Error("failed to seed issue");

    const fetched = await caller(db, wsId).issue.get({ id: row.id });
    expect(fetched.title).toBe("Gate motor whines");
    expect(fetched.taskCount).toBe(0);
    expect(fetched.source).toBe("local");
  });

  it("rejects invalid input with BAD_REQUEST (Zod parse) — via issue.get, not create", async () => {
    const wsId = await seedWs(db, "acme");
    const c = caller(db, wsId);
    // idSchema requires a non-empty string; issue.create no longer exists to validate instead.
    expect(await errCode(() => c.issue.get({ id: "" }))).toBe("BAD_REQUEST");
  });

  it("enforces cross-Workspace isolation — B cannot read A's issue", async () => {
    const wsA = await seedWs(db, "workspace-a");
    const wsB = await seedWs(db, "workspace-b");
    const [issueA] = await db
      .insert(issueTable)
      .values({ workspaceId: wsA, title: "A only" })
      .returning();
    if (!issueA) throw new Error("failed to seed issue");
    expect(await errCode(() => caller(db, wsB).issue.get({ id: issueA.id }))).toBe("NOT_FOUND");
    // A still sees its own.
    expect((await caller(db, wsA).issue.get({ id: issueA.id })).title).toBe("A only");
  });

  it("secret.set returns metadata only — never echoes the value", async () => {
    const wsId = await seedWs(db, "acme");
    const c = caller(db, wsId);
    const result = await c.secret.set({ name: "api", kind: "api_key", value: "sk-ant-secret" });
    expect(result).toEqual({
      secret: { id: result.secret.id, name: "api", kind: "api_key", usedBy: [] },
      resumedTaskCount: 0,
    });
    expect(JSON.stringify(result)).not.toContain("sk-ant-secret");
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
      repositories: [{ repositoryId: repoId }],
    });
    expect(task.state).toBe("backlog");

    const moved = await c.task.move({ id: task.id, to: "ready" });
    expect(moved.state).toBe("ready");

    // ready→done is not a legal transition (only ready→running / ready→backlog are).
    expect(await errCode(() => c.task.move({ id: task.id, to: "done" }))).toBe("BAD_REQUEST");
  });

  it("mints a stream ticket whose claims carry the caller's own Workspace (TASK-018)", async () => {
    const wsId = await seedWs(db, "acme");
    const c = caller(db, wsId);
    const { url, expiresAt } = await c.stream.ticket({});

    const ticket = new URL(url).searchParams.get("ticket") ?? "";
    const verified = verifyStreamTicket(ticket, process.env["GATECONTROL_STREAM_SECRET"] ?? "", 0);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.claims.workspaceId).toBe(wsId);
    expect(verified.claims.taskId).toBeNull();
    expect(Date.parse(expiresAt)).toBeGreaterThan(0);
  });

  it("refuses a stream ticket for another Workspace's Task (Principle V)", async () => {
    const wsA = await seedWs(db, "workspace-a");
    const wsB = await seedWs(db, "workspace-b");
    const fx = await taskFixtures(db, wsA);
    const taskA = await fx.c.task.create({
      issueId: fx.issueId,
      title: "A's task",
      agentProfileId: fx.agentId,
      executorProfileId: fx.executorId,
      repositories: [{ repositoryId: fx.repoId }],
    });

    expect(await errCode(() => caller(db, wsB).stream.ticket({ taskId: taskA.id }))).toBe(
      "NOT_FOUND",
    );
    expect(await errCode(() => fx.c.stream.ticket({ taskId: taskA.id }))).toBe("OK");
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
          repositories: [{ repositoryId: b.repoId }],
        }),
      ),
    ).not.toBe("OK");
  });

  /**
   * Multi-repository Tasks at the API boundary (issue #7 AC-1). The DAL is where the rows are
   * written; what these ask is whether the boundary lets a Task reach it pointing at a tenant
   * it cannot see, and whether the set can be replaced afterwards.
   */
  describe("attaching Repositories to a Task (issue #7)", () => {
    it("creates a Task attached to two Repositories, in the order given", async () => {
      const wsId = await seedWs(db, "acme");
      const fx = await taskFixtures(db, wsId);
      const second = await fx.c.repository.connect({
        name: "shared-lib",
        source: "local_path",
        location: "/srv/shared-lib",
      });

      const task = await fx.c.task.create({
        issueId: fx.issueId,
        title: "Cross-repository change",
        agentProfileId: fx.agentId,
        executorProfileId: fx.executorId,
        repositories: [
          { repositoryId: fx.repoId, baseRef: "main" },
          { repositoryId: second.id, checkoutBranch: "feature/lib" },
        ],
      });

      expect(task.repositories.map((r) => r.repositoryId)).toEqual([fx.repoId, second.id]);
      expect(task.repositories.map((r) => r.position)).toEqual([0, 1]);
      expect(task.repositories[1]?.checkoutBranch).toBe("feature/lib");
    });

    it("refuses an array containing another Workspace's Repository, and writes nothing", async () => {
      // One cross-tenant id must fail the whole create — attaching the rest would leave a Task
      // half pointed at a tenant it cannot see (Principle V).
      const wsA = await seedWs(db, "workspace-a");
      const wsB = await seedWs(db, "workspace-b");
      const fx = await taskFixtures(db, wsA);
      const b = await taskFixtures(db, wsB);

      expect(
        await errCode(() =>
          b.c.task.create({
            issueId: b.issueId,
            title: "cross-tenant repository",
            agentProfileId: b.agentId,
            executorProfileId: b.executorId,
            repositories: [{ repositoryId: b.repoId }, { repositoryId: fx.repoId }],
          }),
        ),
      ).toBe("NOT_FOUND");
      expect(await b.c.task.list({})).toEqual([]);
    });

    it("replaces the whole set on a Task that has not started", async () => {
      const wsId = await seedWs(db, "acme");
      const fx = await taskFixtures(db, wsId);
      const second = await fx.c.repository.connect({
        name: "shared-lib",
        source: "local_path",
        location: "/srv/shared-lib",
      });
      const task = await fx.c.task.create({
        issueId: fx.issueId,
        title: "Repointed",
        agentProfileId: fx.agentId,
        executorProfileId: fx.executorId,
        repositories: [{ repositoryId: fx.repoId }],
      });

      const updated = await fx.c.task.setRepositories({
        taskId: task.id,
        repositories: [{ repositoryId: fx.repoId }, { repositoryId: second.id }],
      });

      expect(updated.repositories.map((r) => r.repositoryId)).toEqual([fx.repoId, second.id]);
      const reread = await fx.c.task.get({ id: task.id });
      expect(reread.repositories).toHaveLength(2);
    });

    it("refuses to re-point a Task that is already running", async () => {
      const wsId = await seedWs(db, "acme");
      const fx = await taskFixtures(db, wsId);
      const task = await fx.c.task.create({
        issueId: fx.issueId,
        title: "Running",
        agentProfileId: fx.agentId,
        executorProfileId: fx.executorId,
        repositories: [{ repositoryId: fx.repoId }],
      });
      await fx.c.task.move({ id: task.id, to: "ready" });
      await fx.c.task.move({ id: task.id, to: "running" });

      expect(
        await errCode(() =>
          fx.c.task.setRepositories({
            taskId: task.id,
            repositories: [{ repositoryId: fx.repoId, checkoutBranch: "somewhere-else" }],
          }),
        ),
      ).not.toBe("OK");
    });

    it("refuses a repeated attachment with a 400, not the unique index with a 500", async () => {
      // The Task id is an input to setRepositories, so a caller can spell out the branch the
      // omitted entry derives. Both rows then collide on `(task, repository, branch)` — and the
      // refusal used to arrive as SQLite's constraint text inside an INTERNAL_SERVER_ERROR,
      // which is exactly the outcome validating the list up front exists to prevent.
      const wsId = await seedWs(db, "acme");
      const fx = await taskFixtures(db, wsId);
      const task = await fx.c.task.create({
        issueId: fx.issueId,
        title: "Repointed",
        agentProfileId: fx.agentId,
        executorProfileId: fx.executorId,
        repositories: [{ repositoryId: fx.repoId }],
      });

      expect(
        await errCode(() =>
          fx.c.task.setRepositories({
            taskId: task.id,
            repositories: [
              { repositoryId: fx.repoId },
              { repositoryId: fx.repoId, checkoutBranch: taskCheckoutBranch(task.id) },
            ],
          }),
        ),
      ).toBe("BAD_REQUEST");
      // And the Task still has the attachment it had, which the rolled-back write never touched.
      expect((await fx.c.task.get({ id: task.id })).repositories).toHaveLength(1);
    });

    it("refuses another Workspace's Repository on setRepositories too", async () => {
      const wsA = await seedWs(db, "workspace-a");
      const wsB = await seedWs(db, "workspace-b");
      const fx = await taskFixtures(db, wsA);
      const b = await taskFixtures(db, wsB);
      const task = await b.c.task.create({
        issueId: b.issueId,
        title: "B's task",
        agentProfileId: b.agentId,
        executorProfileId: b.executorId,
        repositories: [{ repositoryId: b.repoId }],
      });

      expect(
        await errCode(() =>
          b.c.task.setRepositories({
            taskId: task.id,
            repositories: [{ repositoryId: fx.repoId }],
          }),
        ),
      ).toBe("NOT_FOUND");
    });
  });

  describe("executor profile configuration (issue #73)", () => {
    it("AC-2: rejects a configuration that does not match its kind, at the API boundary", async () => {
      const wsId = await seedWs(db, "acme");
      const c = caller(db, wsId);
      expect(
        await errCode(() =>
          // Docker without an image: the boundary refuses it rather than storing a profile no
          // driver could ever run.
          c.profile.executor.create({ name: "Container", config: { kind: "docker" } as never }),
        ),
      ).toBe("BAD_REQUEST");
    });

    it("AC-3: rejects an inline credential in place of a secret reference", async () => {
      const wsId = await seedWs(db, "acme");
      const c = caller(db, wsId);
      expect(
        await errCode(() =>
          c.profile.executor.create({
            name: "Build box",
            config: {
              kind: "ssh",
              host: "build-01",
              user: "ci",
              keySecretId: "sec_1",
              privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
            } as never,
          }),
        ),
      ).toBe("BAD_REQUEST");
    });

    it("AC-6: rejects a profile env that names a billing-guard variable", async () => {
      const wsId = await seedWs(db, "acme");
      const c = caller(db, wsId);
      expect(
        await errCode(() =>
          c.profile.executor.create({
            name: "Sneaky",
            config: { kind: "local", env: { ANTHROPIC_API_KEY: "sk-metered" } },
          }),
        ),
      ).toBe("BAD_REQUEST");
    });

    it("stores the configuration and derives the kind column from it", async () => {
      const wsId = await seedWs(db, "acme");
      const c = caller(db, wsId);
      const created = await c.profile.executor.create({
        name: "Container",
        config: { kind: "docker", image: "oven/bun:1.3", env: { CI: "1" } },
      });
      expect(created.kind).toBe("docker");
      expect(created.config).toEqual({
        kind: "docker",
        image: "oven/bun:1.3",
        mounts: [],
        env: { CI: "1" },
      });
    });

    it("updates a configuration in place, moving the kind with it", async () => {
      const wsId = await seedWs(db, "acme");
      const c = caller(db, wsId);
      const created = await c.profile.executor.create({ name: "Local" });
      const updated = await c.profile.executor.update({
        id: created.id,
        config: { kind: "docker", image: "oven/bun:1.3" },
      });
      expect(updated.kind).toBe("docker");
      expect(updated.name).toBe("Local");
    });

    it("scopes an update to the Workspace (Principle V)", async () => {
      const wsA = await seedWs(db, "workspace-a");
      const wsB = await seedWs(db, "workspace-b");
      const a = await caller(db, wsA).profile.executor.create({ name: "A local" });
      expect(
        await errCode(() => caller(db, wsB).profile.executor.update({ id: a.id, name: "stolen" })),
      ).toBe("NOT_FOUND");
    });
  });
});
