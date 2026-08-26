/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import type { ProjectViewConfig } from "@gatecontrol/contracts";
import { DEFAULT_PROJECT_VIEW_CONFIG } from "@gatecontrol/contracts";
import { formatProjectFilter, parseProjectFilter } from "@gatecontrol/core";
import { encryptSecret, integration, project, projectView, secret } from "@gatecontrol/db";
import { createTestDb, type TestDb } from "@gatecontrol/db/testing";
import { eq } from "drizzle-orm";
import {
  createProjectView,
  deleteProjectView,
  listProjectViews,
  reorderProjectViews,
  updateProjectView,
} from "./project-view.js";
import { ctxFor, seedWorkspaceGraph } from "./test-fixtures.js";

/**
 * Saved views (issue #129, F23 FR-9).
 *
 * The claims worth a test are the ones a tab strip breaks on: a filter survives storage with
 * every clause intact, a rename does not silently revert a filter somebody else saved, the strip
 * cannot be reordered into an order that drops or duplicates a tab, and none of it is reachable
 * from another Workspace.
 */

let db: TestDb;
let acme: string;
let other: string;

async function seedProject(workspaceId: string, title = "Roadmap") {
  const [token] = await db
    .insert(secret)
    .values({
      workspaceId,
      name: `pat-${title}`,
      kind: "scm_pat",
      ciphertext: encryptSecret("ghp-not-a-real-token"),
    })
    .returning();
  const [connected] = await db
    .insert(integration)
    .values({ workspaceId, provider: "github", secretId: token?.id ?? "" })
    .returning();
  if (!connected) throw new Error("failed to seed integration");
  const [row] = await db
    .insert(project)
    .values({
      workspaceId,
      integrationId: connected.id,
      providerProjectId: `PVT_${title}`,
      title,
    })
    .returning();
  if (!row) throw new Error("failed to seed project");
  return row;
}

const configWith = (over: Partial<ProjectViewConfig> = {}): ProjectViewConfig => ({
  ...DEFAULT_PROJECT_VIEW_CONFIG,
  ...over,
});

async function seedView(workspaceId: string, projectId: string, name: string) {
  const created = await createProjectView(ctxFor(db, workspaceId), { projectId, name });
  if (!created.ok) throw new Error(`failed to seed view ${name}`);
  return created.data;
}

beforeEach(async () => {
  db = createTestDb();
  acme = (await seedWorkspaceGraph(db, "acme")).workspaceId;
  other = (await seedWorkspaceGraph(db, "other")).workspaceId;
});

describe("createProjectView", () => {
  it("stores a configuration and no items", async () => {
    // The property the feature rests on: a tab is a question, and the rows stay the Project's.
    const row = await seedProject(acme);
    const created = await createProjectView(ctxFor(db, acme), {
      projectId: row.id,
      name: "In review",
      config: configWith({ filter: parseProjectFilter('status:"In review"') }),
    });

    expect(created.ok).toBe(true);
    const stored = await db.select().from(projectView).where(eq(projectView.projectId, row.id));
    expect(stored).toHaveLength(1);
    expect(Object.keys(stored[0] ?? {})).not.toContain("itemId");
  });

  it("appends to the end of the strip rather than to the front", async () => {
    // A new tab landing before `Prioritized backlog` would move every tab people reach for.
    const row = await seedProject(acme);
    await seedView(acme, row.id, "Backlog");
    await seedView(acme, row.id, "Roadmap");

    expect((await listProjectViews(ctxFor(db, acme), row.id)).map((v) => v.name)).toEqual([
      "Backlog",
      "Roadmap",
    ]);
  });

  it("defaults to the whole table when no configuration is given", async () => {
    const row = await seedProject(acme);
    const created = await seedView(acme, row.id, "Everything");

    expect(created.config).toEqual(DEFAULT_PROJECT_VIEW_CONFIG);
  });

  it("refuses a Project in another Workspace (Principle V)", async () => {
    const row = await seedProject(acme);

    const created = await createProjectView(ctxFor(db, other), { projectId: row.id, name: "Mine" });

    expect(created.ok).toBe(false);
    expect(await listProjectViews(ctxFor(db, other), row.id)).toHaveLength(0);
  });
});

describe("a filter through storage", () => {
  it("round-trips every clause", async () => {
    // The acceptance criterion, end to end: typed, parsed, written, read back, printed. A clause
    // lost anywhere on that path is a saved view that quietly shows the wrong rows.
    const text = 'status:"In progress" assignee:@me -label:blocked iteration:@current upload';
    const row = await seedProject(acme);
    const created = await createProjectView(ctxFor(db, acme), {
      projectId: row.id,
      name: "My items",
      config: configWith({ filter: parseProjectFilter(text) }),
    });
    expect(created.ok).toBe(true);

    const [read] = await listProjectViews(ctxFor(db, acme), row.id);

    expect(read?.config.filter).toEqual(parseProjectFilter(text));
    expect(formatProjectFilter(read?.config.filter ?? { terms: [] })).toBe(text);
  });

  it("degrades a filter it cannot parse to no clauses, not to a tab that will not render", async () => {
    // Written by a newer build, or edited by hand. Showing more rows than intended is visible
    // and correctable; showing none looks exactly like an empty project.
    const row = await seedProject(acme);
    const view = await seedView(acme, row.id, "Odd");
    await db
      .update(projectView)
      .set({ filter: { terms: [{ kind: "witchcraft" }] } as never })
      .where(eq(projectView.id, view.id));

    const [read] = await listProjectViews(ctxFor(db, acme), row.id);

    expect(read?.config.filter).toEqual({ terms: [] });
  });

  it("keeps an explicit empty column set apart from 'every column'", async () => {
    // Null is every column; `[]` is a view whose author hid all of them. Conflating the two
    // would make one of those two views a lie.
    const row = await seedProject(acme);
    const hidden = await createProjectView(ctxFor(db, acme), {
      projectId: row.id,
      name: "Titles only",
      config: configWith({ visibleFieldIds: [] }),
    });
    const all = await seedView(acme, row.id, "Everything");

    expect(hidden.ok && hidden.data.config.visibleFieldIds).toEqual([]);
    expect(all.config.visibleFieldIds).toBeNull();
  });
});

describe("updateProjectView", () => {
  it("renames without touching the configuration", async () => {
    // A shared tab: the person renaming it is not necessarily the person whose filter it is.
    const row = await seedProject(acme);
    const view = await createProjectView(ctxFor(db, acme), {
      projectId: row.id,
      name: "Doing",
      config: configWith({ filter: parseProjectFilter("status:Doing"), layout: "roadmap" }),
    });
    if (!view.ok) throw new Error("seed failed");

    const renamed = await updateProjectView(ctxFor(db, acme), {
      viewId: view.data.id,
      name: "In progress",
    });

    expect(renamed.ok && renamed.data.name).toBe("In progress");
    expect(renamed.ok && renamed.data.config).toEqual(view.data.config);
  });

  it("reconfigures without touching the name", async () => {
    const row = await seedProject(acme);
    const view = await seedView(acme, row.id, "Roadmap");

    const moved = await updateProjectView(ctxFor(db, acme), {
      viewId: view.id,
      config: configWith({ layout: "roadmap" }),
    });

    expect(moved.ok && moved.data.name).toBe("Roadmap");
    expect(moved.ok && moved.data.config.layout).toBe("roadmap");
  });

  it("is refused from another Workspace (Principle V)", async () => {
    const row = await seedProject(acme);
    const view = await seedView(acme, row.id, "Backlog");

    expect(
      (await updateProjectView(ctxFor(db, other), { viewId: view.id, name: "Theirs" })).ok,
    ).toBe(false);
  });
});

describe("reorderProjectViews", () => {
  it("puts the strip in the order given", async () => {
    const row = await seedProject(acme);
    const first = await seedView(acme, row.id, "Backlog");
    const second = await seedView(acme, row.id, "Roadmap");

    const reordered = await reorderProjectViews(ctxFor(db, acme), {
      projectId: row.id,
      viewIds: [second.id, first.id],
    });

    expect(reordered.ok && reordered.data.map((v) => v.name)).toEqual(["Roadmap", "Backlog"]);
    expect((await listProjectViews(ctxFor(db, acme), row.id)).map((v) => v.name)).toEqual([
      "Roadmap",
      "Backlog",
    ]);
  });

  it("refuses an order that leaves a tab out", async () => {
    // The failure this prevents: a tab with no position of its own, sorted wherever its stale
    // position happens to land — the strip silently reordering itself on the next read.
    const row = await seedProject(acme);
    const first = await seedView(acme, row.id, "Backlog");
    await seedView(acme, row.id, "Roadmap");

    const partial = await reorderProjectViews(ctxFor(db, acme), {
      projectId: row.id,
      viewIds: [first.id],
    });

    expect(partial.ok).toBe(false);
  });

  it("refuses a repeated id", async () => {
    const row = await seedProject(acme);
    const first = await seedView(acme, row.id, "Backlog");
    await seedView(acme, row.id, "Roadmap");

    const doubled = await reorderProjectViews(ctxFor(db, acme), {
      projectId: row.id,
      viewIds: [first.id, first.id],
    });

    expect(doubled.ok).toBe(false);
  });

  it("refuses a Project in another Workspace (Principle V)", async () => {
    const row = await seedProject(acme);
    const view = await seedView(acme, row.id, "Backlog");

    const stolen = await reorderProjectViews(ctxFor(db, other), {
      projectId: row.id,
      viewIds: [view.id],
    });

    expect(stolen.ok).toBe(false);
  });
});

describe("deleteProjectView", () => {
  it("removes the tab and leaves the rest of the strip", async () => {
    const row = await seedProject(acme);
    const first = await seedView(acme, row.id, "Backlog");
    await seedView(acme, row.id, "Roadmap");

    expect((await deleteProjectView(ctxFor(db, acme), first.id)).ok).toBe(true);

    expect((await listProjectViews(ctxFor(db, acme), row.id)).map((v) => v.name)).toEqual([
      "Roadmap",
    ]);
  });

  it("is refused from another Workspace (Principle V)", async () => {
    const row = await seedProject(acme);
    const view = await seedView(acme, row.id, "Backlog");

    expect((await deleteProjectView(ctxFor(db, other), view.id)).ok).toBe(false);
    expect(await listProjectViews(ctxFor(db, acme), row.id)).toHaveLength(1);
  });
});
