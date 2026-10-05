/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { encryptSecret, integration, project, projectItem, secret } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { workspaceCounts } from "./counts.js";
import { listIssues } from "./issue.js";
import { ctxFor, seedIssue, seedWorkspaceGraph } from "./test-fixtures.js";

let db: TestDb;
let acme: string;

beforeEach(async () => {
  db = createTestDb();
  acme = (await seedWorkspaceGraph(db, "acme")).workspaceId;
});

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
