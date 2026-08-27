/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { encryptSecret, integration, project, projectItem, secret, task } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { listIssues } from "./issue.js";
import { projectIdForIssue } from "./project.js";
import { listTasks } from "./task.js";
import { ctxFor, seedIssue, seedWorkspaceGraph } from "./test-fixtures.js";

/**
 * Project scoping (F23, the Project-as-top-level rearrangement).
 *
 * The interface now reads every board and every issue list *inside* a Project, so the data has to
 * be scoped too. A project-scoped screen fed by an unscoped query would show the whole Workspace
 * under a project's name — the one thing a scoped screen must never do, and the kind of mistake
 * that looks correct on a workspace with a single project.
 *
 * The other half is the escape hatch: an Issue in no Project must stay reachable, or it takes the
 * Tasks under it out of reach with it.
 */

let db: TestDb;
let acme: string;
/** The profiles a Task needs, handed over by the fixture rather than looked up again. */
let _profiles: { agentProfileId: string; executorProfileId: string };

beforeEach(async () => {
  process.env.SOLOW_SECRET_KEY ??= Buffer.alloc(32, 9).toString("base64");
  db = createTestDb();
  const graph = await seedWorkspaceGraph(db, "acme");
  acme = graph.workspaceId;
  _profiles = {
    agentProfileId: graph.agentProfileId,
    executorProfileId: graph.executorProfileId,
  };
});

/** A Project with nothing in it yet. */
async function seedProject(title: string): Promise<string> {
  const [token] = await db
    .insert(secret)
    .values({
      workspaceId: acme,
      name: `pat-${title}`,
      kind: "scm_pat",
      ciphertext: encryptSecret("t"),
    })
    .returning();
  const [connected] = await db
    .insert(integration)
    .values({ workspaceId: acme, provider: "github", secretId: token?.id ?? "" })
    .returning();
  const [row] = await db
    .insert(project)
    .values({
      workspaceId: acme,
      integrationId: connected?.id ?? "",
      providerProjectId: `PVT_${title}`,
      title,
    })
    .returning();
  return row?.id ?? "";
}

async function addToProject(projectId: string, issueId: string, itemId: string): Promise<void> {
  await db
    .insert(projectItem)
    .values({ workspaceId: acme, projectId, issueId, providerItemId: itemId, position: 0 });
}

describe("listIssues, scoped to a project", () => {
  it("returns the project's issues and nothing else", async () => {
    const roadmap = await seedProject("Roadmap");
    const other = await seedProject("Other");
    const mine = await seedIssue(db, acme, { title: "In the roadmap" });
    const theirs = await seedIssue(db, acme, { title: "In another project" });
    const loose = await seedIssue(db, acme, { title: "In no project" });
    await addToProject(roadmap, mine.id, "it-1");
    await addToProject(other, theirs.id, "it-2");

    const result = await listIssues(ctxFor(db, acme), { projectId: roadmap });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items.map((i) => i.title)).toEqual(["In the roadmap"]);
    expect(result.data.items.map((i) => i.id)).not.toContain(loose.id);
  });

  it("counts an issue once when it sits in two projects", async () => {
    // A join instead of a subquery would duplicate the row here — and the status roll-up counts
    // Tasks per Issue, so a duplicated row reports work that does not exist.
    const a = await seedProject("A");
    const b = await seedProject("B");
    const shared = await seedIssue(db, acme, { title: "In both" });
    await addToProject(a, shared.id, "it-a");
    await addToProject(b, shared.id, "it-b");

    const result = await listIssues(ctxFor(db, acme), { projectId: a });

    expect(result.ok && result.data.items).toHaveLength(1);
  });

  it("returns nothing when asked for a project's issues and the unassigned ones at once", async () => {
    // A contradiction, and the honest answer to a contradiction is the empty set. Silently
    // dropping one of the two clauses would answer a question nobody asked.
    const roadmap = await seedProject("Roadmap");
    const inside = await seedIssue(db, acme, { title: "Inside" });
    await addToProject(roadmap, inside.id, "it-1");
    await seedIssue(db, acme, { title: "Outside" });

    const result = await listIssues(ctxFor(db, acme), { projectId: roadmap, unassigned: true });

    expect(result.ok && result.data.items).toHaveLength(0);
  });
});

describe("the unassigned escape hatch", () => {
  it("finds exactly the issues no project holds", async () => {
    // Without this the 5 issues imported before any project existed would have no screen at all,
    // and would take their Tasks out of reach with them.
    const roadmap = await seedProject("Roadmap");
    const held = await seedIssue(db, acme, { title: "Held" });
    await addToProject(roadmap, held.id, "it-1");
    await seedIssue(db, acme, { title: "Loose one" });
    await seedIssue(db, acme, { title: "Loose two" });

    const result = await listIssues(ctxFor(db, acme), { unassigned: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items.map((i) => i.title).sort()).toEqual(["Loose one", "Loose two"]);
  });

  it("lets an issue leave the hatch by being adopted, with nothing to migrate", async () => {
    const loose = await seedIssue(db, acme, { title: "Adopted later" });
    const before = await listIssues(ctxFor(db, acme), { unassigned: true });
    expect(before.ok && before.data.items).toHaveLength(1);

    const roadmap = await seedProject("Roadmap");
    await addToProject(roadmap, loose.id, "it-1");

    const after = await listIssues(ctxFor(db, acme), { unassigned: true });
    expect(after.ok && after.data.items).toHaveLength(0);
  });
});

describe("listTasks, scoped to a project", () => {
  /** A Task on an Issue — the board's row. */
  async function seedTask(issueId: string, title: string): Promise<void> {
    const graph = await db.select().from(project).limit(0);
    void graph;
    await db.insert(task).values({
      workspaceId: acme,
      issueId,
      title,
      state: "backlog",
      agentProfileId: (await ctxFor(db, acme).db.query.agentProfile.findFirst())?.id ?? "",
      executorProfileId: (await ctxFor(db, acme).db.query.executorProfile.findFirst())?.id ?? "",
    });
  }

  it("reaches a project through the task's issue, so nothing is stored on the task", async () => {
    // There is no `task.project_id`, and there should not be: a Task is work on an Issue, and
    // which Project holds that Issue is the Project's fact. A Task whose Issue is adopted later
    // appears on that board with nothing to migrate.
    const roadmap = await seedProject("Roadmap");
    const held = await seedIssue(db, acme, { title: "Held" });
    const loose = await seedIssue(db, acme, { title: "Loose" });
    await addToProject(roadmap, held.id, "it-1");
    await seedTask(held.id, "Inside the project");
    await seedTask(loose.id, "Outside every project");

    const scoped = await listTasks(ctxFor(db, acme), { projectId: roadmap });
    const loose_ = await listTasks(ctxFor(db, acme), { unassigned: true });

    expect(scoped.ok && scoped.data.items.map((t) => t.title)).toEqual(["Inside the project"]);
    expect(loose_.ok && loose_.data.items.map((t) => t.title)).toEqual(["Outside every project"]);
  });
});

describe("projectIdForIssue", () => {
  it("answers where a flat route's back link should go", async () => {
    const roadmap = await seedProject("Roadmap");
    const held = await seedIssue(db, acme, { title: "Held" });
    await addToProject(roadmap, held.id, "it-1");

    expect(await projectIdForIssue(ctxFor(db, acme), held.id)).toBe(roadmap);
  });

  it("answers null for an issue in no project, which is an ordinary answer", async () => {
    // Null is not a failure — it is exactly what the unassigned screen exists for, and the caller
    // renders that link instead of stranding the reader on a page with no way out.
    const loose = await seedIssue(db, acme, { title: "Loose" });

    expect(await projectIdForIssue(ctxFor(db, acme), loose.id)).toBeNull();
  });

  it("does not reach into another workspace", async () => {
    // Principle V, said out loud.
    const roadmap = await seedProject("Roadmap");
    const held = await seedIssue(db, acme, { title: "Held" });
    await addToProject(roadmap, held.id, "it-1");
    const other = (await seedWorkspaceGraph(db, "other")).workspaceId;

    expect(await projectIdForIssue(ctxFor(db, other), held.id)).toBeNull();
  });
});
