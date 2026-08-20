import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { encryptSecret, repository, secret, workspace } from "@gatecontrol/db";
import { createTestDb, type TestDb } from "@gatecontrol/db/testing";
import { eq } from "drizzle-orm";
import type { RequestContext } from "./context.js";
import {
  connectIntegration,
  importIssues,
  importRepository,
  listExternalIssues,
  listExternalRepositories,
  syncRepositorySignals,
} from "./integration.js";

/**
 * DAL tests against a scripted fixture GitLab server (Principle VI — no live API in CI),
 * exercising `@gatecontrol/scm`'s real `GitlabProvider` through it rather than mocking the
 * provider layer. Centred on the bug an adversarial review caught before merge: GitLab's issue
 * `iid` restarts per project, so two Repositories linked to one Integration must not collide.
 *
 * Deliberately named `*.regression.ts`, not `*.test.ts`: this suite needs real network I/O
 * against `server`, but the workspace preloads happy-dom globally (bunfig.toml) for React
 * component tests, and happy-dom's `fetch` polyfill cannot parse Bun.serve's responses over
 * loopback (a happy-dom/Bun compat bug — HPE_UNEXPECTED_CONTENT_LENGTH — reproducible with no
 * GateControl code involved). `integration.test.ts` runs this file in an isolated subprocess,
 * with a bunfig that preloads only the `server-only` stub, not happy-dom.
 */

let server: ReturnType<typeof Bun.serve>;
const PROJECTS: Record<string, { issues: unknown[]; mrs: unknown[]; branches: unknown[] }> = {
  "group/project-a": {
    issues: [
      {
        iid: 1,
        title: "Project A's first issue",
        description: "from A",
        state: "opened",
        web_url: "a/issues/1",
      },
    ],
    mrs: [],
    branches: [{ name: "main", default: true, commit: { id: "a1", committed_date: null } }],
  },
  "group/project-b": {
    issues: [
      {
        iid: 1,
        title: "Project B's first issue — unrelated to A's",
        description: "from B",
        state: "opened",
        web_url: "b/issues/1",
      },
    ],
    mrs: [],
    branches: [{ name: "main", default: true, commit: { id: "b1", committed_date: null } }],
  },
};

beforeAll(() => {
  process.env.GATECONTROL_SECRET_KEY ??= Buffer.alloc(32, 4).toString("base64");
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/v4/user") return Response.json({ username: "fixture" });
      if (url.pathname === "/api/v4/projects") {
        return Response.json(
          Object.keys(PROJECTS).map((path) => ({
            name: path.split("/").at(-1),
            path_with_namespace: path,
            description: null,
            default_branch: "main",
            visibility: "private",
            web_url: `u/${path}`,
            http_url_to_repo: `http://localhost:${server.port}/${path}.git`,
          })),
        );
      }
      for (const [path, data] of Object.entries(PROJECTS)) {
        const encoded = encodeURIComponent(path);
        if (url.pathname === `/api/v4/projects/${encoded}/issues`)
          return Response.json(data.issues);
        if (url.pathname === `/api/v4/projects/${encoded}/merge_requests`)
          return Response.json(data.mrs);
        if (url.pathname === `/api/v4/projects/${encoded}/repository/branches`)
          return Response.json(data.branches);
      }
      return new Response("unmapped", { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop();
});

let db: TestDb;

beforeEach(() => {
  db = createTestDb();
});

async function seedImportedRepos(): Promise<{
  ctx: RequestContext;
  repoAId: string;
  repoBId: string;
  integrationId: string;
}> {
  const [ws] = await db
    .insert(workspace)
    .values({ name: "acme", ownerUserId: "owner-1" })
    .returning();
  if (!ws) throw new Error("failed to seed workspace");
  const ctx: RequestContext = { db, workspaceId: ws.id, userId: "user-1" };

  const [sec] = await db
    .insert(secret)
    .values({
      workspaceId: ws.id,
      name: "gitlab-pat",
      kind: "scm_pat",
      ciphertext: encryptSecret("glpat-fixture"),
    })
    .returning();
  if (!sec) throw new Error("failed to seed secret");

  const connected = await connectIntegration(ctx, {
    provider: "gitlab",
    secretId: sec.id,
    baseUrl: `http://localhost:${server.port}`,
    writeBackEnabled: false,
  });
  if (!connected.ok) throw new Error("failed to connect integration");

  const repoA = await importRepository(ctx, {
    integrationId: connected.data.id,
    externalFullName: "group/project-a",
  });
  const repoB = await importRepository(ctx, {
    integrationId: connected.data.id,
    externalFullName: "group/project-b",
  });
  if (!repoA.ok || !repoB.ok) throw new Error("failed to import repositories");

  return {
    ctx,
    repoAId: repoA.data.id,
    repoBId: repoB.data.id,
    integrationId: connected.data.id,
  };
}

describe("importRepository", () => {
  it("creates the Repository from the provider's own clone URL", async () => {
    const { repoAId } = await seedImportedRepos();
    const [row] = await db.select().from(repository).where(eq(repository.id, repoAId));

    expect(row?.name).toBe("project-a");
    expect(row?.externalFullName).toBe("group/project-a");
    // remote_url, not local_path: nothing was cloned here — the orchestrator does that, from
    // exactly this location, the first time a Task runs against it.
    expect(row?.source).toBe("remote_url");
    expect(row?.location).toBe(`http://localhost:${server.port}/group/project-a.git`);
    // The location is what ends up in .git/config; a token in it would live there forever.
    expect(row?.location).not.toContain("glpat-fixture");
  });

  it("is idempotent — a second import returns the same Repository, not a duplicate", async () => {
    const { ctx, repoAId, integrationId } = await seedImportedRepos();

    const again = await importRepository(ctx, {
      integrationId,
      externalFullName: "group/project-a",
    });
    expect(again.ok && again.data.id).toBe(repoAId);

    const rows = await db
      .select()
      .from(repository)
      .where(eq(repository.workspaceId, ctx.workspaceId));
    expect(rows).toHaveLength(2);
  });

  it("refuses a repository the token cannot see, rather than importing it blind", async () => {
    const { ctx, integrationId } = await seedImportedRepos();

    // Not in the provider's list for this token. Reading the clone URL from the provider rather
    // than from the caller is what makes this a NotFound instead of a repository GateControl
    // would go and try to clone on someone's behalf.
    const result = await importRepository(ctx, {
      integrationId,
      externalFullName: "someone-else/private",
    });
    expect(result).toEqual({ ok: false, error: "NOT_FOUND" });
  });

  it("takes a name override, for the same repository reached through a second Integration", async () => {
    const { ctx } = await seedImportedRepos();
    const [sec] = await db
      .insert(secret)
      .values({
        workspaceId: ctx.workspaceId,
        name: "gitlab-pat-other-host",
        kind: "scm_pat",
        ciphertext: encryptSecret("glpat-fixture-3"),
      })
      .returning();
    if (!sec) throw new Error("failed to seed secret");
    const second = await connectIntegration(ctx, {
      provider: "gitlab",
      secretId: sec.id,
      baseUrl: `http://localhost:${server.port}`,
      writeBackEnabled: false,
    });
    if (!second.ok) throw new Error("failed to connect second integration");

    // Two Integrations exposing the same `group/project-a` is exactly the case the override is
    // for: without it the Workspace would hold two Repositories both called "project-a".
    const named = await importRepository(ctx, {
      integrationId: second.data.id,
      externalFullName: "group/project-a",
      name: "project-a-on-the-other-host",
    });
    expect(named.ok && named.data.name).toBe("project-a-on-the-other-host");
    expect(named.ok && named.data.externalFullName).toBe("group/project-a");
  });

  it("refuses an Integration from another Workspace (Principle V)", async () => {
    const { integrationId } = await seedImportedRepos();
    const [otherWs] = await db
      .insert(workspace)
      .values({ name: "intruder", ownerUserId: "owner-4" })
      .returning();
    if (!otherWs) throw new Error("failed to seed workspace");

    const intruder: RequestContext = { db, workspaceId: otherWs.id, userId: "user-3" };
    const result = await importRepository(intruder, {
      integrationId,
      externalFullName: "group/project-a",
    });
    expect(result).toEqual({ ok: false, error: "NOT_FOUND" });
  });
});

describe("importIssues — two Repositories sharing one Integration (regression)", () => {
  it("imports both projects' iid=1 as distinct Issues, not a collision", async () => {
    const { ctx, repoAId, repoBId } = await seedImportedRepos();

    const importedA = await importIssues(ctx, { repositoryId: repoAId, externalIds: ["1"] });
    const importedB = await importIssues(ctx, { repositoryId: repoBId, externalIds: ["1"] });

    expect(importedA.ok && importedA.data[0]?.title).toBe("Project A's first issue");
    expect(importedB.ok && importedB.data[0]?.title).toBe(
      "Project B's first issue — unrelated to A's",
    );
    // The bug: B's import used to silently return A's row instead of creating its own.
    expect(importedA.ok && importedB.ok && importedA.data[0]?.id).not.toBe(
      importedB.ok && importedB.data[0]?.id,
    );
    expect(importedB.ok && importedB.data[0]?.repositoryId).toBe(repoBId);
  });

  it("does not flag project B's un-imported issue as alreadyImported after importing A's", async () => {
    const { ctx, repoAId, repoBId } = await seedImportedRepos();

    await importIssues(ctx, { repositoryId: repoAId, externalIds: ["1"] });
    const preview = await listExternalIssues(ctx, { repositoryId: repoBId });

    expect(preview.ok && preview.data[0]?.alreadyImported).toBe(false);
  });

  it("re-importing the same id for the same repository is a real no-op", async () => {
    const { ctx, repoAId } = await seedImportedRepos();

    const first = await importIssues(ctx, { repositoryId: repoAId, externalIds: ["1"] });
    const second = await importIssues(ctx, { repositoryId: repoAId, externalIds: ["1"] });

    expect(first.ok && second.ok && first.data[0]?.id).toBe(second.ok && second.data[0]?.id);
  });
});

describe("syncRepositorySignals — branches scoped per Repository", () => {
  it("does not mix up two Repositories' branches sharing an Integration", async () => {
    const { ctx, repoAId, repoBId } = await seedImportedRepos();

    const syncedA = await syncRepositorySignals(ctx, { repositoryId: repoAId });
    const syncedB = await syncRepositorySignals(ctx, { repositoryId: repoBId });

    expect(syncedA.ok && syncedA.data.branches[0]?.headSha).toBe("a1");
    expect(syncedB.ok && syncedB.data.branches[0]?.headSha).toBe("b1");
  });
});

describe("listExternalRepositories — the link picker's source of truth", () => {
  it("returns the repositories the token can see, keyed on the provider's full name", async () => {
    const { ctx, integrationId } = await seedImportedRepos();
    const listed = await listExternalRepositories(ctx, { integrationId });

    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data.map((r) => r.fullName).sort()).toEqual([
      "group/project-a",
      "group/project-b",
    ]);
  });

  it("flags an already-imported repository instead of hiding it", async () => {
    // seedImportedRepos imports BOTH projects, so both must come back flagged — a picker that
    // silently dropped them would look broken to someone re-checking last week's import.
    const { ctx, integrationId } = await seedImportedRepos();
    const listed = await listExternalRepositories(ctx, { integrationId });

    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data.every((r) => r.alreadyImported)).toBe(true);
  });

  it("does not flag a repository imported under a different Integration", async () => {
    const { ctx, integrationId } = await seedImportedRepos();

    // A second Integration (same fixture host) has imported nothing of its own.
    const [sec] = await db
      .insert(secret)
      .values({
        workspaceId: ctx.workspaceId,
        name: "gitlab-pat-2",
        kind: "scm_pat",
        ciphertext: encryptSecret("glpat-fixture-2"),
      })
      .returning();
    if (!sec) throw new Error("failed to seed second secret");
    const second = await connectIntegration(ctx, {
      provider: "gitlab",
      secretId: sec.id,
      baseUrl: `http://localhost:${server.port}`,
      writeBackEnabled: false,
    });
    if (!second.ok) throw new Error("failed to connect second integration");

    const listed = await listExternalRepositories(ctx, { integrationId: second.data.id });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    // Same names, different Integration — importing is per-Integration, so nothing is flagged.
    expect(listed.data.some((r) => r.alreadyImported)).toBe(false);
    expect(integrationId).not.toBe(second.data.id);
  });

  it("refuses an Integration from another Workspace (Principle V)", async () => {
    const { integrationId } = await seedImportedRepos();
    const [otherWs] = await db
      .insert(workspace)
      .values({ name: "other", ownerUserId: "owner-2" })
      .returning();
    if (!otherWs) throw new Error("failed to seed workspace");

    const intruder: RequestContext = { db, workspaceId: otherWs.id, userId: "user-2" };
    const listed = await listExternalRepositories(intruder, { integrationId });
    expect(listed.ok).toBe(false);
  });
});
