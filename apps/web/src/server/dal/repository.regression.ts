import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { encryptSecret, secret, workspace } from "@gatecontrol/db";
import { createTestDb, type TestDb } from "@gatecontrol/db/testing";
import type { RequestContext } from "./context.js";
import { connectIntegration, importRepository } from "./integration.js";
import { listRepositoryLabels } from "./repository.js";

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

beforeAll(() => {
  process.env.GATECONTROL_SECRET_KEY ??= Buffer.alloc(32, 4).toString("base64");
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
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
        return Response.json([
          { name: "bug", color: "d73a4a", description: "Something isn't working" },
        ]);
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
