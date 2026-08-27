import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { encryptSecret, integration, issue, repository, secret, workspace } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
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
 * exercising `@solow/scm`'s real `GitlabProvider` through it rather than mocking the
 * provider layer. Centred on the bug an adversarial review caught before merge: GitLab's issue
 * `iid` restarts per project, so two Repositories linked to one Integration must not collide.
 *
 * Deliberately named `*.regression.ts`, not `*.test.ts`: this suite needs real network I/O
 * against `server`, but the workspace preloads happy-dom globally (bunfig.toml) for React
 * component tests, and happy-dom's `fetch` polyfill cannot parse Bun.serve's responses over
 * loopback (a happy-dom/Bun compat bug — HPE_UNEXPECTED_CONTENT_LENGTH — reproducible with no
 * SoloW code involved). `integration.test.ts` runs this file in an isolated subprocess,
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
  process.env.SOLOW_SECRET_KEY ??= Buffer.alloc(32, 4).toString("base64");
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
    integrationId: connected.data.integration.id,
    externalFullName: "group/project-a",
  });
  const repoB = await importRepository(ctx, {
    integrationId: connected.data.integration.id,
    externalFullName: "group/project-b",
  });
  if (!repoA.ok || !repoB.ok) throw new Error("failed to import repositories");

  return {
    ctx,
    repoAId: repoA.data.id,
    repoBId: repoB.data.id,
    integrationId: connected.data.integration.id,
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
    // than from the caller is what makes this a NotFound instead of a repository SoloW
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
    // Inserted directly rather than through `connectIntegration`: that now auto-imports every
    // repository it can see (including `group/project-a`, under its default name) the moment it
    // connects, which would make the `importRepository` call below hit the idempotent
    // already-imported path and return that default name instead of applying the override. This
    // test is about the override, not the auto-sync cascade, so its Integration is seeded the
    // same direct-insert way `deleteIntegration`'s tests already do.
    const [secondRow] = await db
      .insert(integration)
      .values({
        workspaceId: ctx.workspaceId,
        provider: "gitlab",
        secretId: sec.id,
        baseUrl: `http://localhost:${server.port}`,
        writeBackEnabled: false,
      })
      .returning();
    if (!secondRow) throw new Error("failed to seed second integration");

    // Two Integrations exposing the same `group/project-a` is exactly the case the override is
    // for: without it the Workspace would hold two Repositories both called "project-a".
    const named = await importRepository(ctx, {
      integrationId: secondRow.id,
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
    // Repositories are inserted directly here rather than through `importRepository`: that now
    // auto-imports a Repository's Issues as soon as it is created (this track's item 2), which
    // would import B's issue before this test ever calls `importIssues` for A — erasing the
    // "un-imported" starting state the regression is about. Direct insert keeps this test
    // isolated to what it actually protects: `listExternalIssues` scoping "already imported" by
    // Repository, not by Integration.
    const [ws] = await db
      .insert(workspace)
      .values({ name: "acme-manual-import", ownerUserId: "owner-6" })
      .returning();
    if (!ws) throw new Error("failed to seed workspace");
    const ctx: RequestContext = { db, workspaceId: ws.id, userId: "user-1" };

    const [sec] = await db
      .insert(secret)
      .values({
        workspaceId: ws.id,
        name: "gitlab-pat-manual",
        kind: "scm_pat",
        ciphertext: encryptSecret("glpat-fixture-manual"),
      })
      .returning();
    if (!sec) throw new Error("failed to seed secret");
    const [integrationRow] = await db
      .insert(integration)
      .values({
        workspaceId: ws.id,
        provider: "gitlab",
        secretId: sec.id,
        baseUrl: `http://localhost:${server.port}`,
        writeBackEnabled: false,
      })
      .returning();
    if (!integrationRow) throw new Error("failed to seed integration");

    const [repoA] = await db
      .insert(repository)
      .values({
        workspaceId: ws.id,
        name: "project-a",
        source: "remote_url",
        location: `http://localhost:${server.port}/group/project-a.git`,
        integrationId: integrationRow.id,
        externalFullName: "group/project-a",
      })
      .returning();
    const [repoB] = await db
      .insert(repository)
      .values({
        workspaceId: ws.id,
        name: "project-b",
        source: "remote_url",
        location: `http://localhost:${server.port}/group/project-b.git`,
        integrationId: integrationRow.id,
        externalFullName: "group/project-b",
      })
      .returning();
    if (!repoA || !repoB) throw new Error("failed to seed repositories");

    await importIssues(ctx, { repositoryId: repoA.id, externalIds: ["1"] });
    const preview = await listExternalIssues(ctx, { repositoryId: repoB.id });

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
    // Inserted directly, not through `connectIntegration`: that now auto-imports every visible
    // repository the instant it connects, which would give this "second Integration" its own
    // copies of project-a/b too — the opposite of the "has imported nothing of its own" premise
    // this test needs.
    const [secondRow] = await db
      .insert(integration)
      .values({
        workspaceId: ctx.workspaceId,
        provider: "gitlab",
        secretId: sec.id,
        baseUrl: `http://localhost:${server.port}`,
        writeBackEnabled: false,
      })
      .returning();
    if (!secondRow) throw new Error("failed to seed second integration");

    const listed = await listExternalRepositories(ctx, { integrationId: secondRow.id });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    // Same names, different Integration — importing is per-Integration, so nothing is flagged.
    expect(listed.data.some((r) => r.alreadyImported)).toBe(false);
    expect(integrationId).not.toBe(secondRow.id);
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

/**
 * A GitLab fixture server for exactly one `it()`, deliberately not the shared module-level
 * `server`/`PROJECTS` above: these tests assert on exact repository/issue *counts*, and sharing
 * the fixture every other describe block in this file already uses would make those counts a
 * function of unrelated tests' fixtures too. `cloneUrl: null` is how a test forces
 * `insertRepositoryRow` to fail — `repository.location` is `NOT NULL` (schema.ts), and GitLab's
 * `http_url_to_repo` is where `cloneUrl` comes from (`packages/scm/src/gitlab.ts`).
 */
function buildFixtureServer(
  projects: { path: string; cloneUrl: "valid" | null; issues?: unknown[] }[],
): ReturnType<typeof Bun.serve> {
  let srv: ReturnType<typeof Bun.serve>;
  srv = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/v4/user") return Response.json({ username: "fixture" });
      if (url.pathname === "/api/v4/projects") {
        return Response.json(
          projects.map((p) => ({
            name: p.path.split("/").at(-1),
            path_with_namespace: p.path,
            description: null,
            default_branch: "main",
            visibility: "private",
            web_url: `u/${p.path}`,
            http_url_to_repo:
              p.cloneUrl === null ? null : `http://localhost:${srv.port}/${p.path}.git`,
          })),
        );
      }
      for (const p of projects) {
        const encoded = encodeURIComponent(p.path);
        if (url.pathname === `/api/v4/projects/${encoded}/issues`)
          return Response.json(p.issues ?? []);
        if (url.pathname === `/api/v4/projects/${encoded}/merge_requests`) return Response.json([]);
        if (url.pathname === `/api/v4/projects/${encoded}/repository/branches`)
          return Response.json([]);
      }
      return new Response("unmapped", { status: 404 });
    },
  });
  return srv;
}

/** Seed a fresh Workspace + Secret, ready to `connectIntegration` against `baseUrl`. */
async function seedWorkspaceAndSecret(
  name: string,
  baseUrl: string,
): Promise<{ ctx: RequestContext; secretId: string; baseUrl: string }> {
  const [ws] = await db.insert(workspace).values({ name, ownerUserId: "owner-auto" }).returning();
  if (!ws) throw new Error("failed to seed workspace");
  const ctx: RequestContext = { db, workspaceId: ws.id, userId: "user-1" };
  const [sec] = await db
    .insert(secret)
    .values({
      workspaceId: ws.id,
      name: "gitlab-pat-auto",
      kind: "scm_pat",
      ciphertext: encryptSecret("glpat-auto-sync"),
    })
    .returning();
  if (!sec) throw new Error("failed to seed secret");
  return { ctx, secretId: sec.id, baseUrl };
}

describe("connectIntegration — automatic Repository and Issue sync", () => {
  it("imports every visible Repository and each one's Issues with no further calls", async () => {
    const fixture = buildFixtureServer([
      {
        path: "acme/one",
        cloneUrl: "valid",
        issues: [
          {
            iid: 1,
            title: "One's first issue",
            description: "d1",
            state: "opened",
            web_url: "one/issues/1",
          },
        ],
      },
      {
        path: "acme/two",
        cloneUrl: "valid",
        issues: [
          {
            iid: 1,
            title: "Two's first issue",
            description: "d2",
            state: "opened",
            web_url: "two/issues/1",
          },
        ],
      },
    ]);
    try {
      const seeded = await seedWorkspaceAndSecret(
        "acme-auto-happy",
        `http://localhost:${fixture.port}`,
      );

      const connected = await connectIntegration(seeded.ctx, {
        provider: "gitlab",
        secretId: seeded.secretId,
        baseUrl: seeded.baseUrl,
        writeBackEnabled: false,
      });

      expect(connected.ok).toBe(true);
      if (!connected.ok) return;
      expect(
        connected.data.autoSyncedRepositories
          .map((r) => ({
            externalFullName: r.externalFullName,
            status: r.status,
            issuesImported: r.issuesImported,
          }))
          .sort((a, b) => a.externalFullName.localeCompare(b.externalFullName)),
      ).toEqual([
        { externalFullName: "acme/one", status: "imported", issuesImported: 1 },
        { externalFullName: "acme/two", status: "imported", issuesImported: 1 },
      ]);

      // "No further calls" (the test's title): the rows are already in the database, not just
      // reported in the mutation's return value.
      const repos = await db
        .select()
        .from(repository)
        .where(eq(repository.workspaceId, seeded.ctx.workspaceId));
      expect(repos.map((r) => r.externalFullName).sort()).toEqual(["acme/one", "acme/two"]);
      const issues = await db
        .select()
        .from(issue)
        .where(eq(issue.workspaceId, seeded.ctx.workspaceId));
      expect(issues.map((i) => i.title).sort()).toEqual(["One's first issue", "Two's first issue"]);
    } finally {
      fixture.stop();
    }
  });

  it("keeps the Repositories that import cleanly when one of the batch fails", async () => {
    const fixture = buildFixtureServer([
      { path: "acme/good-one", cloneUrl: "valid" },
      // No clone URL: fails the NOT NULL constraint on `repository.location`, standing in for
      // any malformed-provider-data failure a real account could hand back for one repository.
      { path: "acme/bad", cloneUrl: null },
      { path: "acme/good-two", cloneUrl: "valid" },
    ]);
    try {
      const seeded = await seedWorkspaceAndSecret(
        "acme-auto-partial",
        `http://localhost:${fixture.port}`,
      );

      const connected = await connectIntegration(seeded.ctx, {
        provider: "gitlab",
        secretId: seeded.secretId,
        baseUrl: seeded.baseUrl,
        writeBackEnabled: false,
      });

      // The mutation itself still succeeds — the Integration connected; only one Repository in
      // its automatic sync failed, and that is reported, not raised.
      expect(connected.ok).toBe(true);
      if (!connected.ok) return;
      const byName = new Map(
        connected.data.autoSyncedRepositories.map((r) => [r.externalFullName, r]),
      );
      expect(byName.get("acme/good-one")?.status).toBe("imported");
      expect(byName.get("acme/good-two")?.status).toBe("imported");
      const bad = byName.get("acme/bad");
      expect(bad?.status).toBe("failed");
      expect(bad?.error).toBeTruthy();
      expect(bad?.error ?? "").not.toContain("glpat-auto-sync");

      // The two that succeeded are actually there — a caught exception on the third must not
      // have rolled back or skipped the ones before it.
      const repos = await db
        .select()
        .from(repository)
        .where(eq(repository.workspaceId, seeded.ctx.workspaceId));
      expect(repos.map((r) => r.externalFullName).sort()).toEqual([
        "acme/good-one",
        "acme/good-two",
      ]);
    } finally {
      fixture.stop();
    }
  });

  it("caps automatic import at 20 repositories, leaving the rest to the manual picker", async () => {
    const projects = Array.from({ length: 25 }, (_, i) => ({
      path: `acme/repo-${String(i).padStart(2, "0")}`,
      cloneUrl: "valid" as const,
      issues: [
        {
          iid: 1,
          title: `repo-${String(i).padStart(2, "0")}'s issue`,
          description: null,
          state: "opened",
          web_url: `repo-${i}/issues/1`,
        },
      ],
    }));
    const fixture = buildFixtureServer(projects);
    try {
      const seeded = await seedWorkspaceAndSecret(
        "acme-auto-cap",
        `http://localhost:${fixture.port}`,
      );

      const connected = await connectIntegration(seeded.ctx, {
        provider: "gitlab",
        secretId: seeded.secretId,
        baseUrl: seeded.baseUrl,
        writeBackEnabled: false,
      });
      expect(connected.ok).toBe(true);
      if (!connected.ok) return;

      const imported = connected.data.autoSyncedRepositories.filter((r) => r.status === "imported");
      const skipped = connected.data.autoSyncedRepositories.filter(
        (r) => r.status === "skipped_over_cap",
      );
      expect(imported).toHaveLength(20);
      expect(skipped).toHaveLength(5);

      const repos = await db
        .select()
        .from(repository)
        .where(eq(repository.workspaceId, seeded.ctx.workspaceId));
      expect(repos).toHaveLength(20);

      // Additive, not a replacement: a Repository the cap left out is still reachable — and
      // still auto-imports its own Issues — through the always-available manual path.
      const stillOut = skipped[0];
      if (!stillOut) throw new Error("expected at least one skipped repository");
      const manual = await importRepository(seeded.ctx, {
        integrationId: connected.data.integration.id,
        externalFullName: stillOut.externalFullName,
      });
      expect(manual.ok).toBe(true);

      const reposAfter = await db
        .select()
        .from(repository)
        .where(eq(repository.workspaceId, seeded.ctx.workspaceId));
      expect(reposAfter).toHaveLength(21);
      if (!manual.ok) return;
      const issuesForManual = await db
        .select()
        .from(issue)
        .where(eq(issue.repositoryId, manual.data.id));
      expect(issuesForManual).toHaveLength(1);
    } finally {
      fixture.stop();
    }
  });
});
