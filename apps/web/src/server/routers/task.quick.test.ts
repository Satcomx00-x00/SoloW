/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { TaskErrorCode } from "@solow/contracts";
import { issue as issueTable, repository, session as sessionTable, workspace } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { eq } from "drizzle-orm";
import { seedWorkspaceGraph } from "../dal/test-fixtures.js";
import type { BaseContext } from "../trpc.js";
import { appRouter } from "./index.js";
import { quickTaskTitle } from "./task.js";

// Dev-owner: the enqueue logs instead of needing an orchestrator.
process.env["SOLOW_DEV_OWNER"] = "on";

const caller = (db: TestDb, workspaceId: string) =>
  appRouter.createCaller({
    db,
    session: { workspaceId, userId: "user-1" },
    flagOverrides: { "ff-core-program": true },
  } satisfies BaseContext);

describe("quickTaskTitle", () => {
  it("uses the first non-empty line", () => {
    expect(quickTaskTitle("\n  Fix the login bug  \nIt 500s on Safari")).toBe("Fix the login bug");
  });

  it("cuts a long sentence on a word boundary and says so", () => {
    const title = quickTaskTitle("word ".repeat(60));
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toContain("wor…");
  });
});

describe("task.quickStart", () => {
  let db: TestDb;

  beforeEach(() => {
    db = createTestDb();
  });

  it("creates the Issue and the Task together and starts the run", async () => {
    const fx = await seedWorkspaceGraph(db, "quick");
    const c = caller(db, fx.workspaceId);

    const out = await c.task.quickStart({ prompt: "Add a farewell() helper" });

    expect(out.task.state).toBe("running");
    expect(out.task.issueId).toBe(out.issueId);
    expect(out.task.agentProfileId).toBe(fx.agentProfileId);
    expect(out.task.repositories[0]?.repositoryId).toBe(fx.repositoryId);
    const [issue] = await db.select().from(issueTable).where(eq(issueTable.id, out.issueId));
    expect(issue?.source).toBe("local");
    expect(issue?.description).toBe("Add a farewell() helper");
    const sessions = await db
      .select()
      .from(sessionTable)
      .where(eq(sessionTable.taskId, out.task.id));
    expect(sessions).toHaveLength(1);
  });

  it("asks which repository when there are several and none is named", async () => {
    const fx = await seedWorkspaceGraph(db, "several");
    await db
      .insert(repository)
      .values({ workspaceId: fx.workspaceId, name: "other", source: "local_path", location: "/x" });
    const c = caller(db, fx.workspaceId);

    await expect(c.task.quickStart({ prompt: "Do it" })).rejects.toThrow(
      TaskErrorCode.QuickNeedsRepository,
    );
    // Refused before any write.
    expect(await db.select().from(issueTable)).toHaveLength(0);

    const out = await c.task.quickStart({ prompt: "Do it", repositoryId: fx.repositoryId });
    expect(out.task.state).toBe("running");
  });

  it("writes nothing when the Workspace has no profiles", async () => {
    const [ws] = await db
      .insert(workspace)
      .values({ name: "bare", ownerUserId: "owner-bare" })
      .returning();
    if (!ws) throw new Error("seed");
    await db
      .insert(repository)
      .values({ workspaceId: ws.id, name: "r", source: "local_path", location: "/r" });

    await expect(caller(db, ws.id).task.quickStart({ prompt: "Do it" })).rejects.toThrow(
      TaskErrorCode.QuickNeedsProfiles,
    );
    expect(await db.select().from(issueTable)).toHaveLength(0);
  });

  it("refuses a repository from another Workspace", async () => {
    const mine = await seedWorkspaceGraph(db, "mine");
    const theirs = await seedWorkspaceGraph(db, "theirs");
    await expect(
      caller(db, mine.workspaceId).task.quickStart({
        prompt: "Do it",
        repositoryId: theirs.repositoryId,
      }),
    ).rejects.toThrow();
    expect(await db.select().from(issueTable)).toHaveLength(0);
  });
});
