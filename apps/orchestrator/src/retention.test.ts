import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encryptSecret,
  executorProfile,
  harnessCatalog,
  harnessProfile,
  issue,
  repository,
  secret,
  session,
  sessionEvent,
  task,
  workspace,
  worktree,
} from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { $ } from "bun";
import { eq } from "drizzle-orm";
import { createLocalExecutor } from "./executor/local.js";
import type { Executor } from "./executor/types.js";
import { retentionSweep } from "./retention.js";

/**
 * History retention (Decision 0025): what the sweep takes back, when, and what it leaves.
 *
 * Against a real git repository, because the whole point is a worktree directory on disk: a
 * sweep that only wrote rows would be the one that reports "removed" over a directory still
 * holding the branch checked out — which is the fault this design exists to avoid.
 */

const WS = "ws-retention";
const DAY = 24 * 60 * 60 * 1000;
const WINDOW = 7 * DAY;

let root: string;
let repoDir: string;
let executor: Executor;

beforeAll(async () => {
  process.env.SOLOW_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
  root = mkdtempSync(join(tmpdir(), "solow-retention-"));
  repoDir = join(root, "repo");
  await $`git init -q -b main ${repoDir}`.quiet();
  await $`git -C ${repoDir} config user.email t@example.com`.quiet();
  await $`git -C ${repoDir} config user.name t`.quiet();
  writeFileSync(join(repoDir, "README.md"), "hello\n");
  await $`git -C ${repoDir} add -A`.quiet();
  await $`git -C ${repoDir} commit -q -m init`.quiet();
  executor = createLocalExecutor(root);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A worktree the way the lifecycle leaves one: a real checkout, a row that says so. */
async function seedWorktree(db: TestDb, taskId: string): Promise<string> {
  const path = join(root, `wt-${taskId}`);
  await $`git -C ${repoDir} worktree add -q -b br-${taskId} ${path}`.quiet();
  await db.insert(worktree).values({
    workspaceId: WS,
    taskId,
    repositoryId: "repo-1",
    path,
    branch: `br-${taskId}`,
    status: "active",
  });
  return path;
}

async function seed(
  db: TestDb,
  taskId: string,
  opts: { state: "done" | "failed"; deletedAt?: string; updatedAt?: string; sessionState?: string },
) {
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, WS));
  if (!ws) {
    await db.insert(workspace).values({ id: WS, name: WS, ownerUserId: "u1" });
    await db.insert(secret).values({
      id: "sec",
      workspaceId: WS,
      name: "token",
      kind: "subscription_token",
      ciphertext: encryptSecret("sk-test"),
    });
    await db.insert(harnessCatalog).values({
      id: "cat",
      workspaceId: WS,
      key: "claude_code",
      displayName: "Claude Code",
      protocol: "claude_code_stream_json",
      command: "claude",
      subscriptionEnvVar: "X",
      meteredEnvVar: "Y",
    });
    await db.insert(harnessProfile).values({
      id: "ap",
      workspaceId: WS,
      name: "p",
      agentCatalogId: "cat",
      authMode: "subscription",
      secretId: "sec",
    });
    await db
      .insert(executorProfile)
      .values({ id: "ex", workspaceId: WS, name: "l", kind: "local" });
    await db.insert(issue).values({ id: "iss", workspaceId: WS, title: "i" });
    await db.insert(repository).values({
      id: "repo-1",
      workspaceId: WS,
      name: "repo",
      source: "local_path",
      location: repoDir,
    });
  }
  await db.insert(task).values({
    id: taskId,
    workspaceId: WS,
    issueId: "iss",
    title: taskId,
    state: opts.state,
    agentProfileId: "ap",
    executorProfileId: "ex",
    ...(opts.deletedAt ? { deletedAt: opts.deletedAt } : {}),
    ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
  });
  const sessionId = `sess-${taskId}`;
  await db.insert(session).values({
    id: sessionId,
    workspaceId: WS,
    taskId,
    state: (opts.sessionState ?? "resumable") as "resumable",
    harnessSessionId: `claude-${taskId}`,
  });
  await db.insert(sessionEvent).values({
    id: `ev-${taskId}`,
    workspaceId: WS,
    sessionId,
    seq: 0,
    kind: "notice",
    payload: { kind: "notice", text: "hi" },
    at: new Date().toISOString(),
  });
  return sessionId;
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

describe("retentionSweep", () => {
  it("purges a Task deleted longer ago than the window, worktree first, rows after", async () => {
    const db = createTestDb();
    await seed(db, "old-deleted", { state: "failed", deletedAt: ago(WINDOW + DAY) });
    const path = await seedWorktree(db, "old-deleted");

    const report = await retentionSweep({ db, host: executor, retentionMs: WINDOW });

    expect(report).toEqual({ purged: 1, expired: 0 });
    expect(existsSync(path)).toBe(false);
    expect((await $`git -C ${repoDir} worktree list`.quiet()).stdout.toString()).not.toContain(
      "old-deleted",
    );
    expect(await db.select().from(task).where(eq(task.id, "old-deleted"))).toHaveLength(0);
    expect(await db.select().from(session).where(eq(session.taskId, "old-deleted"))).toHaveLength(
      0,
    );
  });

  it("leaves a Task deleted inside the window alone — it is still restorable", async () => {
    const db = createTestDb();
    await seed(db, "fresh-deleted", { state: "failed", deletedAt: ago(DAY) });
    const path = await seedWorktree(db, "fresh-deleted");

    const report = await retentionSweep({ db, host: executor, retentionMs: WINDOW });

    expect(report).toEqual({ purged: 0, expired: 0 });
    expect(existsSync(path)).toBe(true);
    expect(await db.select().from(task).where(eq(task.id, "fresh-deleted"))).toHaveLength(1);
    await $`git -C ${repoDir} worktree remove --force ${path}`.quiet();
  });

  it("expires a Done Task's worktree after the window, keeping its record and closing its Session", async () => {
    const db = createTestDb();
    await seed(db, "old-done", { state: "done", updatedAt: ago(WINDOW + DAY) });
    const path = await seedWorktree(db, "old-done");

    const report = await retentionSweep({ db, host: executor, retentionMs: WINDOW });

    expect(report).toEqual({ purged: 0, expired: 1 });
    expect(existsSync(path)).toBe(false);
    // Readable for as long as the Task exists; only the conversation's continuation is gone.
    expect(await db.select().from(task).where(eq(task.id, "old-done"))).toHaveLength(1);
    expect(
      await db.select().from(sessionEvent).where(eq(sessionEvent.sessionId, "sess-old-done")),
    ).toHaveLength(1);
    const [row] = await db.select().from(worktree).where(eq(worktree.taskId, "old-done"));
    expect(row?.status).toBe("removed");
    const [sess] = await db.select().from(session).where(eq(session.id, "sess-old-done"));
    expect(sess?.state).toBe("closed");
  });

  it("agrees with a worktree already gone by hand, and is idempotent", async () => {
    const db = createTestDb();
    await seed(db, "gone", { state: "done", updatedAt: ago(WINDOW + DAY) });
    const path = await seedWorktree(db, "gone");
    await $`git -C ${repoDir} worktree remove --force ${path}`.quiet();

    expect(await retentionSweep({ db, host: executor, retentionMs: WINDOW })).toEqual({
      purged: 0,
      expired: 1,
    });
    expect(await retentionSweep({ db, host: executor, retentionMs: WINDOW })).toEqual({
      purged: 0,
      expired: 0,
    });
  });

  it("never touches a Task with a Session still active, however old its marks", async () => {
    const db = createTestDb();
    await seed(db, "live", {
      state: "failed",
      deletedAt: ago(WINDOW + DAY),
      sessionState: "active",
    });
    const path = await seedWorktree(db, "live");

    expect(await retentionSweep({ db, host: executor, retentionMs: WINDOW })).toEqual({
      purged: 0,
      expired: 0,
    });
    expect(existsSync(path)).toBe(true);
    await $`git -C ${repoDir} worktree remove --force ${path}`.quiet();
  });
});
