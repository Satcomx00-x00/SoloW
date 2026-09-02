/// <reference types="bun-types" />
import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { encryptSecret, integration, repository, secret, workspace } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { ctxFor } from "./test-fixtures.js";
import { type MirrorSyncRequester, requestWorkspaceSync } from "./workspace.js";

/**
 * Asking the poll to run now, and the three answers it can honestly give.
 *
 * The assertion that carries the design is that **none of them throw**. The caller is a button on
 * the status bar, and "we could not ask" is a state it can render — where a rejected promise
 * surfaces as a red toast reading "Internal error", which sends someone looking for a fault in
 * their provider when the only thing wrong is that the orchestrator is not running.
 *
 * The handoff is stubbed rather than reached: what is under test is this function's reading of
 * the answer, not the transport, which `orchestrator-client.ts` owns and the E2E suite exercises.
 */

let wired = true;
let requestFails = false;
const requests: Array<{ workspaceId: string }> = [];

const client: MirrorSyncRequester = {
  isWired: () => wired,
  requestMirrorSync: async (input) => {
    requests.push(input);
    if (requestFails) throw new Error("connect ECONNREFUSED 127.0.0.1:5001");
  },
};

let db: TestDb;

beforeAll(() => {
  process.env.SOLOW_SECRET_KEY ??= Buffer.alloc(32, 9).toString("base64");
});

beforeEach(() => {
  db = createTestDb();
  wired = true;
  requestFails = false;
  requests.length = 0;
});

/** A Workspace, and `linked` repositories attached to a real Integration. */
async function seed(linked: number): Promise<string> {
  const [ws] = await db
    .insert(workspace)
    .values({ name: "acme", ownerUserId: "owner" })
    .returning();
  const workspaceId = ws?.id ?? "";
  if (linked === 0) return workspaceId;

  const [token] = await db
    .insert(secret)
    .values({
      workspaceId,
      name: "pat",
      kind: "scm_pat",
      ciphertext: encryptSecret("glpat-fixture"),
    })
    .returning();
  const [connected] = await db
    .insert(integration)
    .values({ workspaceId, provider: "github", secretId: token?.id ?? "" })
    .returning();
  for (let i = 0; i < linked; i++) {
    await db.insert(repository).values({
      workspaceId,
      name: `repo-${i}`,
      source: "remote_url",
      location: `https://example.test/acme/repo-${i}.git`,
      integrationId: connected?.id ?? null,
      externalFullName: `acme/repo-${i}`,
    });
  }
  return workspaceId;
}

describe("requestWorkspaceSync", () => {
  it("hands the request over and says how many repositories it covers", async () => {
    const workspaceId = await seed(3);

    const result = await requestWorkspaceSync(ctxFor(db, workspaceId), client);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ accepted: true, repositories: 3 });
    // The tenant is stated by the server from the session, never taken from the caller.
    expect(requests).toEqual([{ workspaceId }]);
  });

  it("answers rather than throws when there is no engine to ask", async () => {
    wired = false;
    const workspaceId = await seed(2);

    const result = await requestWorkspaceSync(ctxFor(db, workspaceId), client);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A local run with no orchestrator. Saying so is the point: a spinner that resolved into
    // silence would be indistinguishable from a sync that worked.
    expect(result.data).toEqual({ accepted: false, repositories: 2 });
    expect(requests).toEqual([]);
  });

  it("answers rather than throws when the engine is unreachable", async () => {
    requestFails = true;
    const workspaceId = await seed(1);

    const result = await requestWorkspaceSync(ctxFor(db, workspaceId), client);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ accepted: false, repositories: 1 });
    // It did try — the refusal is the engine's, not a guess made without asking.
    expect(requests).toHaveLength(1);
  });

  it("counts only repositories a poll has anything to do for", async () => {
    const workspaceId = await seed(2);
    // A purely local repository has no provider to read from, so it is not part of a sync.
    await db.insert(repository).values({
      workspaceId,
      name: "local-only",
      source: "local_path",
      location: "/srv/repos/local-only",
    });

    const result = await requestWorkspaceSync(ctxFor(db, workspaceId), client);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.repositories).toBe(2);
  });

  it("never counts another Workspace's repositories", async () => {
    const mine = await seed(1);
    await seed(4);

    const result = await requestWorkspaceSync(ctxFor(db, mine), client);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.repositories).toBe(1);
  });
});
