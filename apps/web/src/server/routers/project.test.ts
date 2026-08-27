/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { encryptSecret, integration, project as projectTable, secret } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { seedWorkspaceGraph } from "../dal/test-fixtures.js";
import type { BaseContext } from "../trpc.js";
import { appRouter } from "./index.js";

// The secret store reads SOLOW_SECRET_KEY lazily (via the validated env module), so the
// mirrored-Project fixture that encrypts a PAT needs it set before that runs.
process.env.SOLOW_SECRET_KEY ??= Buffer.alloc(32, 13).toString("base64");

/**
 * Local Projects, end to end through the router (spec F23, Decision 0018's reversal, user
 * request 2026-08-27).
 *
 * The DAL's own tests (`../dal/project-local.test.ts`) prove the membership mechanics; what this
 * file proves is that the four procedures are wired to them correctly, including the
 * cross-Workspace refusals the router's own scoping has to produce (Principle V).
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

/** A mirrored Project seeded directly — attachRepository must refuse it before touching a driver. */
async function seedMirroredProject(db: TestDb, workspaceId: string) {
  const [token] = await db
    .insert(secret)
    .values({
      workspaceId,
      name: "pat",
      kind: "scm_pat",
      ciphertext: encryptSecret("ghp-not-a-real-token"),
    })
    .returning();
  const [connected] = await db
    .insert(integration)
    .values({ workspaceId, provider: "github", secretId: token?.id ?? "" })
    .returning();
  if (!connected) throw new Error("failed to seed integration");
  const [row] = await db
    .insert(projectTable)
    .values({
      workspaceId,
      integrationId: connected.id,
      providerProjectId: "PVT_x",
      title: "Mirrored",
    })
    .returning();
  if (!row) throw new Error("failed to seed mirrored project");
  return row;
}

describe("local Project procedures", () => {
  let db: TestDb;

  beforeEach(() => {
    db = createTestDb();
  });

  it("createLocal creates a Project with source local and no provider board", async () => {
    const g = await seedWorkspaceGraph(db, "acme");
    const api = caller(db, g.workspaceId);

    const created = await api.project.createLocal({ title: "Roadmap" });

    expect(created.source).toBe("local");
    expect(created.integrationId).toBeNull();
    expect(created.providerProjectId).toBeNull();
    expect(created.itemCount).toBe(0);
  });

  it("attachRepository backfills existing Issues, repositories reports it, and detachRepository undoes it", async () => {
    const g = await seedWorkspaceGraph(db, "acme");
    const api = caller(db, g.workspaceId);
    const proj = await api.project.createLocal({ title: "Roadmap" });
    await api.issue.create({ title: "Gate stuck", repositoryId: g.repositoryId, labels: [] });
    await api.issue.create({ title: "Latch loose", repositoryId: g.repositoryId, labels: [] });

    const attached = await api.project.attachRepository({
      projectId: proj.id,
      repositoryId: g.repositoryId,
    });
    expect(attached.issueCount).toBe(2);

    const repos = await api.project.repositories({ projectId: proj.id });
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({ repositoryId: g.repositoryId, issueCount: 2 });

    // A local Project's board is a standing decision, not a synced snapshot: an Issue created
    // after the attach must join automatically too (`issue.create` calling
    // `attachIssueToLocalProjects`).
    await api.issue.create({ title: "New arrival", repositoryId: g.repositoryId, labels: [] });
    const afterArrival = await api.project.repositories({ projectId: proj.id });
    expect(afterArrival[0]?.issueCount).toBe(3);

    const detached = await api.project.detachRepository({
      projectId: proj.id,
      repositoryId: g.repositoryId,
    });
    expect(detached).toEqual({ projectId: proj.id, repositoryId: g.repositoryId });
    expect(await api.project.repositories({ projectId: proj.id })).toHaveLength(0);
  });

  it("attachRepository refuses a mirrored Project with PROJECT_NOT_LOCAL", async () => {
    const g = await seedWorkspaceGraph(db, "acme");
    const api = caller(db, g.workspaceId);
    const mirrored = await seedMirroredProject(db, g.workspaceId);

    const message = await errMessage(() =>
      api.project.attachRepository({ projectId: mirrored.id, repositoryId: g.repositoryId }),
    );
    expect(message).toBe("PROJECT_NOT_LOCAL");
  });

  it("attachRepository refuses a duplicate attach with PROJECT_REPOSITORY_ALREADY_ATTACHED", async () => {
    const g = await seedWorkspaceGraph(db, "acme");
    const api = caller(db, g.workspaceId);
    const proj = await api.project.createLocal({ title: "Roadmap" });
    await api.project.attachRepository({ projectId: proj.id, repositoryId: g.repositoryId });

    const message = await errMessage(() =>
      api.project.attachRepository({ projectId: proj.id, repositoryId: g.repositoryId }),
    );
    expect(message).toBe("PROJECT_REPOSITORY_ALREADY_ATTACHED");
  });

  it("attachRepository refuses another Workspace's Repository, and vice versa (Principle V)", async () => {
    const acme = await seedWorkspaceGraph(db, "acme");
    const intruder = await seedWorkspaceGraph(db, "intruder");
    const acmeApi = caller(db, acme.workspaceId);
    const proj = await acmeApi.project.createLocal({ title: "Roadmap" });

    // Acme cannot attach a Repository it does not own.
    expect(
      await errCode(() =>
        acmeApi.project.attachRepository({
          projectId: proj.id,
          repositoryId: intruder.repositoryId,
        }),
      ),
    ).toBe("NOT_FOUND");

    // The intruder cannot attach Acme's Repository to Acme's Project either.
    const intruderApi = caller(db, intruder.workspaceId);
    expect(
      await errCode(() =>
        intruderApi.project.attachRepository({
          projectId: proj.id,
          repositoryId: acme.repositoryId,
        }),
      ),
    ).toBe("NOT_FOUND");
  });
});

/**
 * Deleting a Project (user request 2026-08-27): removes SoloW's own row and everything that
 * belongs to it, but never the Issues it held — same guarantee as `detachRepository`, one level
 * up. Proved end to end through the router for both kinds of Project, since `deleteProject`
 * itself is provider-agnostic and neither this router procedure nor `attachRepository`'s own
 * `PROJECT_NOT_LOCAL` refusal applies to it.
 */
describe("delete", () => {
  let db: TestDb;

  beforeEach(() => {
    db = createTestDb();
  });

  it("deletes a local Project and leaves its Issues in place, unassigned", async () => {
    const g = await seedWorkspaceGraph(db, "acme");
    const api = caller(db, g.workspaceId);
    const proj = await api.project.createLocal({ title: "Roadmap" });
    await api.project.attachRepository({ projectId: proj.id, repositoryId: g.repositoryId });
    const issue = await api.issue.create({
      title: "Gate stuck",
      repositoryId: g.repositoryId,
      labels: [],
    });

    const result = await api.project.delete({ projectId: proj.id });

    expect(result).toEqual({ id: proj.id });
    expect(await errCode(() => api.project.get({ projectId: proj.id }))).toBe("NOT_FOUND");
    // The Issue is untouched, and the same call that used to require a Project (issue.list
    // filtered by it) still finds it — it is simply nobody's row any more.
    expect(await api.issue.get({ id: issue.id })).toMatchObject({ id: issue.id });
  });

  it("deletes a mirrored Project the same way — SoloW's mirror, never the provider", async () => {
    const g = await seedWorkspaceGraph(db, "acme");
    const api = caller(db, g.workspaceId);
    const mirrored = await seedMirroredProject(db, g.workspaceId);

    const result = await api.project.delete({ projectId: mirrored.id });

    expect(result).toEqual({ id: mirrored.id });
    expect(await errCode(() => api.project.get({ projectId: mirrored.id }))).toBe("NOT_FOUND");
  });

  it("refuses to delete another Workspace's Project (Principle V)", async () => {
    const acme = await seedWorkspaceGraph(db, "acme");
    const intruder = await seedWorkspaceGraph(db, "intruder");
    const acmeApi = caller(db, acme.workspaceId);
    const proj = await acmeApi.project.createLocal({ title: "Roadmap" });

    const intruderApi = caller(db, intruder.workspaceId);
    expect(await errCode(() => intruderApi.project.delete({ projectId: proj.id }))).toBe(
      "NOT_FOUND",
    );
    // Untouched: Acme can still see it.
    expect(await acmeApi.project.get({ projectId: proj.id })).toMatchObject({ id: proj.id });
  });
});
