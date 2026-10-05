/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { encryptSecret, integration, project, projectItem, secret, task } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { workspaceCounts } from "./counts.js";
import { listIssues } from "./issue.js";
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

async function seedTask(
  issueId: string,
  state: "review" | "running",
  extra: { deletedAt?: string } = {},
): Promise<void> {
  await db
    .insert(task)
    .values({ workspaceId: acme, issueId, title: `${state} task`, state, ...profiles, ...extra });
}

async function hold(projectId: string, issueId: string, itemId: string): Promise<void> {
  await db
    .insert(projectItem)
    .values({ workspaceId: acme, projectId, issueId, providerItemId: itemId, position: 0 });
}

async function seedProject(workspaceId: string, title: string): Promise<string> {
  const [token] = await db
    .insert(secret)
    .values({ workspaceId, name: `pat-${title}`, kind: "scm_pat", ciphertext: encryptSecret("t") })
    .returning();
  const [connected] = await db
    .insert(integration)
    .values({ workspaceId, provider: "github", secretId: token?.id ?? "" })
    .returning();
  const [row] = await db
    .insert(project)
    .values({
      workspaceId,
      integrationId: connected?.id ?? "",
      providerProjectId: `PVT_${title}`,
      title,
    })
    .returning();
  return row?.id ?? "";
}

describe("workspaceCounts — unassigned issues", () => {
  it("counts exactly the issues the Unassigned page lists", async () => {
    const roadmap = await seedProject(acme, "Roadmap");
    const held = await seedIssue(db, acme, { title: "In the roadmap" });
    await seedIssue(db, acme, { title: "Loose one" });
    await seedIssue(db, acme, { title: "Loose two" });
    await db.insert(projectItem).values({
      workspaceId: acme,
      projectId: roadmap,
      issueId: held.id,
      providerItemId: "it-1",
      position: 0,
    });

    const counts = await workspaceCounts(ctxFor(db, acme));
    const page = await listIssues(ctxFor(db, acme), { unassigned: true });

    expect(counts.ok && page.ok).toBe(true);
    if (!counts.ok || !page.ok) return;
    expect(counts.data.unassignedIssues).toBe(2);
    expect(counts.data.unassignedIssues).toBe(page.data.items.length);
  });

  it("never counts another Workspace's issues", async () => {
    const other = (await seedWorkspaceGraph(db, "globex")).workspaceId;
    await seedIssue(db, other, { title: "Theirs" });
    await seedIssue(db, acme, { title: "Ours" });

    const counts = await workspaceCounts(ctxFor(db, acme));

    expect(counts.ok && counts.data.unassignedIssues).toBe(1);
  });
});

describe("workspaceCounts — tasks awaiting review", () => {
  it("counts review Tasks per Project through their Issue, leaving out other states", async () => {
    const roadmap = await seedProject(acme, "Roadmap");
    const quiet = await seedProject(acme, "Quiet");
    const issue = await seedIssue(db, acme, { title: "Held" });
    const other = await seedIssue(db, acme, { title: "Held quietly" });
    await hold(roadmap, issue.id, "it-1");
    await hold(quiet, other.id, "it-2");
    await seedTask(issue.id, "review");
    await seedTask(issue.id, "review");
    await seedTask(issue.id, "running");
    await seedTask(other.id, "running");

    const counts = await workspaceCounts(ctxFor(db, acme));

    expect(counts.ok && counts.data.reviewByProject).toEqual([{ projectId: roadmap, tasks: 2 }]);
  });

  it("counts a Task once in each Project that holds its Issue", async () => {
    const a = await seedProject(acme, "A");
    const b = await seedProject(acme, "B");
    const shared = await seedIssue(db, acme, { title: "In both" });
    await hold(a, shared.id, "it-a");
    await hold(b, shared.id, "it-b");
    await seedTask(shared.id, "review");

    const counts = await workspaceCounts(ctxFor(db, acme));

    expect(
      counts.ok &&
        [...counts.data.reviewByProject].sort((x, y) => x.projectId.localeCompare(y.projectId)),
    ).toEqual(
      [
        { projectId: a, tasks: 1 },
        { projectId: b, tasks: 1 },
      ].sort((x, y) => x.projectId.localeCompare(y.projectId)),
    );
  });

  it("leaves out deleted Tasks", async () => {
    const roadmap = await seedProject(acme, "Roadmap");
    const issue = await seedIssue(db, acme, { title: "Held" });
    await hold(roadmap, issue.id, "it-1");
    await seedTask(issue.id, "review", { deletedAt: new Date().toISOString() });

    const counts = await workspaceCounts(ctxFor(db, acme));

    expect(counts.ok && counts.data.reviewByProject).toEqual([]);
  });
});
