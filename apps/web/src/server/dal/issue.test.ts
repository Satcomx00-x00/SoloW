import { beforeEach, describe, expect, it } from "bun:test";
import { workspace } from "@gatecontrol/db";
import { createTestDb, type TestDb } from "@gatecontrol/db/testing";
import type { RequestContext } from "./context.js";
import { createIssueRecord, getIssueById, listIssues } from "./issue.js";

/** Insert a workspace row (Issues FK-reference it) and return its id. */
async function seedWorkspace(db: TestDb, name: string): Promise<string> {
  const [row] = await db
    .insert(workspace)
    .values({ name, ownerUserId: `owner-${name}` })
    .returning();
  if (!row) throw new Error("failed to seed workspace");
  return row.id;
}

function ctxFor(db: TestDb, workspaceId: string): RequestContext {
  return { db, workspaceId, userId: "user-1" };
}

describe("issue DAL", () => {
  let db: TestDb;

  beforeEach(() => {
    db = createTestDb();
  });

  it("createIssueRecord then getIssueById returns it with taskCount 0", async () => {
    const wsId = await seedWorkspace(db, "acme");
    const ctx = ctxFor(db, wsId);

    const created = await createIssueRecord(ctx, {
      title: "Fix the gate latch",
      description: "The latch sticks in the rain",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.data.title).toBe("Fix the gate latch");
    expect(created.data.description).toBe("The latch sticks in the rain");
    expect(created.data.status).toBe("open");
    expect(created.data.taskCount).toBe(0);

    const fetched = await getIssueById(ctx, created.data.id);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.data).toEqual(created.data);
    expect(fetched.data.taskCount).toBe(0);
  });

  it("createIssueRecord persists a null description when omitted", async () => {
    const ctx = ctxFor(db, await seedWorkspace(db, "acme"));
    const created = await createIssueRecord(ctx, { title: "No details" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.description).toBeNull();
  });

  it("getIssueById returns NOT_FOUND for an unknown id", async () => {
    const ctx = ctxFor(db, await seedWorkspace(db, "acme"));
    const res = await getIssueById(ctx, "does-not-exist");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("NOT_FOUND");
  });

  it("listIssues returns the created issues for the workspace", async () => {
    const ctx = ctxFor(db, await seedWorkspace(db, "acme"));
    const a = await createIssueRecord(ctx, { title: "First" });
    const b = await createIssueRecord(ctx, { title: "Second" });
    expect(a.ok && b.ok).toBe(true);

    const res = await listIssues(ctx, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.length).toBe(2);
    const titles = res.data.map((i) => i.title).sort();
    expect(titles).toEqual(["First", "Second"]);
    for (const dto of res.data) expect(dto.taskCount).toBe(0);
  });

  it("listIssues filters by title query", async () => {
    const ctx = ctxFor(db, await seedWorkspace(db, "acme"));
    await createIssueRecord(ctx, { title: "Gate motor whines" });
    await createIssueRecord(ctx, { title: "Keypad unresponsive" });

    const res = await listIssues(ctx, { query: "motor" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.length).toBe(1);
    expect(res.data[0]?.title).toBe("Gate motor whines");
  });

  // Cross-workspace isolation (constitution Principle V): a ctx scoped to workspace A
  // must never be able to read a row that belongs to workspace B.
  it("enforces cross-workspace isolation for getIssueById", async () => {
    const wsA = await seedWorkspace(db, "workspace-a");
    const wsB = await seedWorkspace(db, "workspace-b");
    const ctxA = ctxFor(db, wsA);
    const ctxB = ctxFor(db, wsB);

    const issueA = await createIssueRecord(ctxA, { title: "A's issue" });
    const issueB = await createIssueRecord(ctxB, { title: "B's issue" });
    expect(issueA.ok && issueB.ok).toBe(true);
    if (!issueA.ok || !issueB.ok) return;

    // A tries to read B's issue by id -> NOT_FOUND, not a leak.
    const leak = await getIssueById(ctxA, issueB.data.id);
    expect(leak.ok).toBe(false);
    if (leak.ok) return;
    expect(leak.error).toBe("NOT_FOUND");

    // Each workspace still sees only its own issue.
    const ownA = await getIssueById(ctxA, issueA.data.id);
    expect(ownA.ok).toBe(true);
  });

  it("listIssues is scoped to the calling workspace only", async () => {
    const wsA = await seedWorkspace(db, "workspace-a");
    const wsB = await seedWorkspace(db, "workspace-b");
    await createIssueRecord(ctxFor(db, wsA), { title: "A only" });
    await createIssueRecord(ctxFor(db, wsB), { title: "B one" });
    await createIssueRecord(ctxFor(db, wsB), { title: "B two" });

    const listA = await listIssues(ctxFor(db, wsA), {});
    expect(listA.ok).toBe(true);
    if (!listA.ok) return;
    expect(listA.data.map((i) => i.title)).toEqual(["A only"]);

    const listB = await listIssues(ctxFor(db, wsB), {});
    expect(listB.ok).toBe(true);
    if (!listB.ok) return;
    expect(listB.data.length).toBe(2);
  });
});
