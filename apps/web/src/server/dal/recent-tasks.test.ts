/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { encryptSecret, integration, project, projectItem, secret, task } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { eq } from "drizzle-orm";
import { recordRecentTask } from "./preference.js";
import { listRecentTasks } from "./recent-tasks.js";
import { ctxFor, seedIssue, seedWorkspaceGraph } from "./test-fixtures.js";

let db: TestDb;
let acme: string;
let profiles: { agentProfileId: string; executorProfileId: string };

beforeEach(async () => {
  db = createTestDb();
  const graph = await seedWorkspaceGraph(db, "acme");
  acme = graph.workspaceId;
  profiles = { agentProfileId: graph.agentProfileId, executorProfileId: graph.executorProfileId };
});

async function seedTask(title: string): Promise<string> {
  const issue = await seedIssue(db, acme, { title: `Issue for ${title}` });
  const [row] = await db
    .insert(task)
    .values({ workspaceId: acme, issueId: issue.id, title, state: "backlog", ...profiles })
    .returning();
  return row?.id ?? "";
}

describe("listRecentTasks", () => {
  it("loads the recorded Tasks, most recent first", async () => {
    const ctx = ctxFor(db, acme);
    const first = await seedTask("Visited first");
    const second = await seedTask("Visited second");
    await recordRecentTask(ctx, first);
    await recordRecentTask(ctx, second);

    const recent = await listRecentTasks(ctx);

    expect(recent.ok && recent.data.map((r) => r.task.title)).toEqual([
      "Visited second",
      "Visited first",
    ]);
  });

  it("leaves out a Task deleted since it was visited", async () => {
    const ctx = ctxFor(db, acme);
    const kept = await seedTask("Kept");
    const gone = await seedTask("Gone");
    await recordRecentTask(ctx, kept);
    await recordRecentTask(ctx, gone);
    await db.update(task).set({ deletedAt: new Date().toISOString() }).where(eq(task.id, gone));

    const recent = await listRecentTasks(ctx);

    expect(recent.ok && recent.data.map((r) => r.task.title)).toEqual(["Kept"]);
  });

  it("is empty when nothing has been visited", async () => {
    const recent = await listRecentTasks(ctxFor(db, acme));
    expect(recent.ok && recent.data).toEqual([]);
  });
});

describe("listRecentTasks — where each one lives", () => {
  it("names the Project holding the Task's Issue, and null for one in none", async () => {
    const ctx = ctxFor(db, acme);
    const loose = await seedTask("Loose");
    const held = await seedTask("Held");
    const [heldRow] = await db.select().from(task).where(eq(task.id, held));
    const [token] = await db
      .insert(secret)
      .values({ workspaceId: acme, name: "pat", kind: "scm_pat", ciphertext: encryptSecret("t") })
      .returning();
    const [connected] = await db
      .insert(integration)
      .values({ workspaceId: acme, provider: "github", secretId: token?.id ?? "" })
      .returning();
    const [roadmap] = await db
      .insert(project)
      .values({
        workspaceId: acme,
        integrationId: connected?.id ?? "",
        providerProjectId: "PVT_roadmap",
        title: "Roadmap",
      })
      .returning();
    await db.insert(projectItem).values({
      workspaceId: acme,
      projectId: roadmap?.id ?? "",
      issueId: heldRow?.issueId ?? "",
      providerItemId: "it-1",
      position: 0,
    });
    await recordRecentTask(ctx, loose);
    await recordRecentTask(ctx, held);

    const recent = await listRecentTasks(ctx);

    expect(recent.ok && recent.data.map((r) => [r.task.title, r.project?.title ?? null])).toEqual([
      ["Held", "Roadmap"],
      ["Loose", null],
    ]);
  });
});
