import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { encryptSecret, secret, workspace } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import type { RequestContext } from "./context.js";
import { connectIntegration, importRepository } from "./integration.js";
import { listRepositoryLabels, seedDefaultLabels } from "./repository.js";

/**
 * `listRepositoryLabels`'s full path, end to end, against a scripted fixture GitHub server
 * (Principle VI — no live API in CI): resolve the linked Integration, decrypt its credential,
 * and read back the real labels `GithubProvider.listLabels` (packages/scm) returns.
 *
 * Deliberately named `*.regression.ts`, not `*.test.ts` — same reason as `integration.
 * regression.ts`: this suite needs real network I/O and happy-dom's `fetch` polyfill (preloaded
 * globally for React component tests) cannot parse Bun.serve's responses over loopback.
 * `repository.test.ts` runs this file in an isolated subprocess with a bunfig that skips the
 * happy-dom preload.
 */

let server: ReturnType<typeof Bun.serve>;
let receivedMethods: string[] = [];
let existingLabels: Array<{ name: string; color: string; description: string | null }> = [];

beforeAll(() => {
  process.env.SOLOW_SECRET_KEY ??= Buffer.alloc(32, 4).toString("base64");
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      receivedMethods.push(req.method);
      if (url.pathname === "/api/v3/user") return Response.json({ login: "fixture" });
      if (url.pathname === "/api/v3/user/repos") {
        return Response.json([
          {
            name: "gate",
            full_name: "acme/gate",
            description: null,
            default_branch: "main",
            private: true,
            html_url: "u/acme/gate",
            clone_url: `http://localhost:${server.port}/acme/gate.git`,
          },
        ]);
      }
      if (url.pathname === "/api/v3/repos/acme/gate/labels") {
        if (req.method === "GET") return Response.json(existingLabels);
        if (req.method === "POST") {
          const body = (await req.json()) as { name: string; color: string; description: string };
          existingLabels.push(body);
          return Response.json(body, { status: 201 });
        }
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
  receivedMethods = [];
  existingLabels = [{ name: "bug", color: "d73a4a", description: "Something isn't working" }];
});

describe("listRepositoryLabels", () => {
  it("resolves the linked Integration's credential and returns the fixture server's real labels", async () => {
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
        name: "github-pat",
        kind: "scm_pat",
        ciphertext: encryptSecret("gh-pat-fixture"),
      })
      .returning();
    if (!sec) throw new Error("failed to seed secret");

    const connected = await connectIntegration(ctx, {
      provider: "github",
      secretId: sec.id,
      baseUrl: `http://localhost:${server.port}`,
      writeBackEnabled: false,
    });
    if (!connected.ok) throw new Error("failed to connect integration");

    // `connectIntegration` auto-syncs every visible repository (issue #15's "connecting an
    // Integration should automatically fetch all its repositories") — `importRepository` is
    // idempotent on (integration, externalFullName), so calling it again either way still
    // resolves the same Repository, whether or not the auto-sync already created it.
    const imported = await importRepository(ctx, {
      integrationId: connected.data.integration.id,
      externalFullName: "acme/gate",
    });
    if (!imported.ok) throw new Error("failed to import repository");

    const labels = await listRepositoryLabels(ctx, imported.data.id);

    expect(labels).toEqual({
      ok: true,
      data: [{ name: "bug", color: "#d73a4a", description: "Something isn't working" }],
    });
  });
});

/**
 * `seedDefaultLabels`'s full path against the same fixture server, over real HTTP with real
 * JSON bodies — the class of test that would have caught `provisionProjectStructure`'s GET/POST
 * bug (see `gitlab-projects.ts`'s own regression comment): a mocked `fetch` module can be told to
 * accept any verb and never notice a write silently became a read.
 */
describe("seedDefaultLabels", () => {
  it("creates only the taxonomy labels the fixture repository is missing, over a real POST", async () => {
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
        name: "github-pat",
        kind: "scm_pat",
        ciphertext: encryptSecret("gh-pat-fixture"),
      })
      .returning();
    if (!sec) throw new Error("failed to seed secret");

    const connected = await connectIntegration(ctx, {
      provider: "github",
      secretId: sec.id,
      baseUrl: `http://localhost:${server.port}`,
      writeBackEnabled: false,
    });
    if (!connected.ok) throw new Error("failed to connect integration");

    const imported = await importRepository(ctx, {
      integrationId: connected.data.integration.id,
      externalFullName: "acme/gate",
    });
    if (!imported.ok) throw new Error("failed to import repository");

    receivedMethods = [];
    const result = await seedDefaultLabels(ctx, imported.data.id);

    if (!result.ok) throw new Error(`seedDefaultLabels failed: ${result.error}`);
    // The fixture already carries "bug" (matched case-insensitively, not one of the taxonomy's
    // own names) — everything else is missing and must have actually landed.
    expect(result.data.existing).toEqual([]);
    expect(result.data.created.length).toBeGreaterThan(20);
    expect(result.data.created).toContain("type/feat");
    expect(result.data.created).toContain("prio/p0");
    expect(receivedMethods.filter((m) => m === "POST").length).toBe(result.data.created.length);

    // What the fixture server actually now holds — not just what the DAL claims it created.
    expect(existingLabels.some((l) => l.name === "type/feat")).toBe(true);
    expect(existingLabels.some((l) => l.name === "bug")).toBe(true);
  });

  it("is idempotent — running it again creates nothing", async () => {
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
        name: "github-pat",
        kind: "scm_pat",
        ciphertext: encryptSecret("gh-pat-fixture"),
      })
      .returning();
    if (!sec) throw new Error("failed to seed secret");

    const connected = await connectIntegration(ctx, {
      provider: "github",
      secretId: sec.id,
      baseUrl: `http://localhost:${server.port}`,
      writeBackEnabled: false,
    });
    if (!connected.ok) throw new Error("failed to connect integration");

    const imported = await importRepository(ctx, {
      integrationId: connected.data.integration.id,
      externalFullName: "acme/gate",
    });
    if (!imported.ok) throw new Error("failed to import repository");

    await seedDefaultLabels(ctx, imported.data.id);
    const second = await seedDefaultLabels(ctx, imported.data.id);

    if (!second.ok) throw new Error(`seedDefaultLabels failed: ${second.error}`);
    expect(second.data.created).toEqual([]);
  });
});

/**
 * The same two paths, against a scripted fixture **GitLab** server this time.
 *
 * Everything up through `repository.regression.ts` above had only ever been exercised against
 * GitHub — this suite is where GitLab's own driver first gets the same end-to-end proof, real
 * HTTP round trips included, per the user's own request (2026-08-27) to start testing the GitLab
 * side of the backend rather than assuming it behaves like GitHub's because the interface is
 * shared. It is exactly this suite that would have caught `provisionProjectStructure`'s GET/POST
 * bug, had it existed here first.
 */
describe("the same two paths, against GitLab", () => {
  let gitlabServer: ReturnType<typeof Bun.serve>;
  let gitlabMethods: string[] = [];
  let gitlabLabels: Array<{ name: string; color: string; description: string }> = [];

  beforeAll(() => {
    gitlabServer = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        gitlabMethods.push(req.method);
        if (url.pathname === "/api/v4/user") return Response.json({ username: "fixture" });
        if (url.pathname === "/api/v4/projects") {
          return Response.json([
            {
              path_with_namespace: "acme/gate",
              name: "gate",
              description: null,
              default_branch: "main",
              visibility: "private",
              web_url: `http://localhost:${gitlabServer.port}/acme/gate`,
              http_url_to_repo: `http://localhost:${gitlabServer.port}/acme/gate.git`,
            },
          ]);
        }
        if (url.pathname === "/api/v4/projects/acme%2Fgate/labels") {
          if (req.method === "GET") return Response.json(gitlabLabels);
          if (req.method === "POST") {
            const body = (await req.json()) as { name: string; color: string; description: string };
            gitlabLabels.push(body);
            return Response.json(body, { status: 201 });
          }
        }
        return new Response("unmapped", { status: 404 });
      },
    });
  });

  afterAll(() => {
    gitlabServer.stop();
  });

  beforeEach(() => {
    gitlabMethods = [];
    gitlabLabels = [{ name: "bug", color: "#d73a4a", description: "Something isn't working" }];
  });

  async function connectAndImport(ctx: RequestContext) {
    const [sec] = await db
      .insert(secret)
      .values({
        workspaceId: ctx.workspaceId,
        name: "gitlab-pat",
        kind: "scm_pat",
        ciphertext: encryptSecret("glpat-fixture"),
      })
      .returning();
    if (!sec) throw new Error("failed to seed secret");

    const connected = await connectIntegration(ctx, {
      provider: "gitlab",
      secretId: sec.id,
      baseUrl: `http://localhost:${gitlabServer.port}`,
      writeBackEnabled: false,
    });
    if (!connected.ok) throw new Error("failed to connect integration");

    const imported = await importRepository(ctx, {
      integrationId: connected.data.integration.id,
      externalFullName: "acme/gate",
    });
    if (!imported.ok) throw new Error("failed to import repository");
    return imported.data;
  }

  it("reads a real GitLab repository's labels through the same DAL path GitHub uses", async () => {
    const [ws] = await db
      .insert(workspace)
      .values({ name: "acme-gl", ownerUserId: "owner-1" })
      .returning();
    if (!ws) throw new Error("failed to seed workspace");
    const ctx: RequestContext = { db, workspaceId: ws.id, userId: "user-1" };

    const repo = await connectAndImport(ctx);
    const labels = await listRepositoryLabels(ctx, repo.id);

    expect(labels).toEqual({
      ok: true,
      data: [{ name: "bug", color: "#d73a4a", description: "Something isn't working" }],
    });
  });

  it("seeds the default taxonomy onto a real GitLab repository over a real POST", async () => {
    const [ws] = await db
      .insert(workspace)
      .values({ name: "acme-gl", ownerUserId: "owner-1" })
      .returning();
    if (!ws) throw new Error("failed to seed workspace");
    const ctx: RequestContext = { db, workspaceId: ws.id, userId: "user-1" };

    const repo = await connectAndImport(ctx);
    gitlabMethods = [];
    const result = await seedDefaultLabels(ctx, repo.id);

    if (!result.ok) throw new Error(`seedDefaultLabels failed: ${result.error}`);
    expect(result.data.existing).toEqual([]);
    expect(result.data.created).toContain("type/feat");
    expect(result.data.created).toContain("status/todo");
    expect(gitlabMethods.filter((m) => m === "POST").length).toBe(result.data.created.length);
    expect(gitlabLabels.some((l) => l.name === "size/xl")).toBe(true);
  });
});
