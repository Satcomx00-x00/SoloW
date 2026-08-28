/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";

// `seedProject` encrypts a PAT, and the secret store reads SOLOW_SECRET_KEY lazily through the
// validated env module — so it has to be set before the first `encryptSecret` call. Set here
// rather than relied on from another test file's own setup: bun runs one process for the whole
// suite, file order is not guaranteed, and this file passing only when some other file happened
// to run first is precisely the bug that broke a release's CI run (see index.test.ts).
process.env.SOLOW_SECRET_KEY ??= Buffer.alloc(32, 12).toString("base64");

import {
  encryptSecret,
  integration,
  issue,
  project,
  projectField,
  projectItem,
  projectRepository,
  projectValue,
  projectView,
  repository,
  secret,
} from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { and, eq } from "drizzle-orm";
import { deleteIssue } from "./issue.js";
import {
  deleteProject,
  getProject,
  listProjectItems,
  listProjects,
  replaceProjectFields,
  setProjectSyncCursor,
} from "./project.js";
import { ctxFor, seedIssue, seedWorkspaceGraph } from "./test-fixtures.js";

/**
 * The project mirror (spec F23, issue #121).
 *
 * What is asserted here is mostly what happens when the mirror and the provider disagree — a
 * value whose field changed type, a field the provider stopped reporting, an Issue deleted out
 * from under a row. The happy path is a cache; the disagreements are the design.
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

beforeEach(async () => {
  db = createTestDb();
  acme = (await seedWorkspaceGraph(db, "acme")).workspaceId;
  other = (await seedWorkspaceGraph(db, "other")).workspaceId;
});

describe("getProject", () => {
  it("returns the project with its fields in position order", async () => {
    const row = await seedProject(acme);
    await replaceProjectFields(ctxFor(db, acme), row.id, [
      fieldInput({ providerFieldId: "f2", name: "Size", position: 1 }),
      fieldInput({ providerFieldId: "f1", name: "Status", position: 0 }),
    ]);

    const result = await getProject(ctxFor(db, acme), row.id);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.fields.map((f) => f.name)).toEqual(["Status", "Size"]);
  });

  it("is invisible to another Workspace (Principle V)", async () => {
    const row = await seedProject(acme);

    expect((await getProject(ctxFor(db, other), row.id)).ok).toBe(false);
    expect(await listProjects(ctxFor(db, other))).toHaveLength(0);
  });

  describe("a local Project — synthesized fields, end to end (user request 2026-08-28)", () => {
    async function seedLocalProjectWithIssue() {
      const [proj] = await db
        .insert(project)
        .values({
          workspaceId: acme,
          title: "Roadmap",
          integrationId: null,
          providerProjectId: null,
        })
        .returning();
      if (!proj) throw new Error("failed to seed local project");
      const [repo] = await db
        .insert(repository)
        .values({
          workspaceId: acme,
          name: "gate-firmware",
          source: "local_path",
          location: "/repo",
        })
        .returning();
      if (!repo) throw new Error("failed to seed repository");
      const iss = await seedIssue(db, acme, {
        repositoryId: repo.id,
        labels: ["status::doing", "prio/p1"],
        assignees: [{ login: "ada", name: "Ada", avatarUrl: null }],
        milestone: { externalId: "5", title: "v1", startDate: null, dueDate: "2026-09-01" },
        externalState: "open",
      });
      const [item] = await db
        .insert(projectItem)
        .values({ workspaceId: acme, projectId: proj.id, issueId: iss.id, providerItemId: iss.id })
        .returning();
      if (!item) throw new Error("failed to seed project item");
      return { projectId: proj.id, issueId: iss.id, repositoryName: repo.name };
    }

    it("getProject derives Status/Priority columns from the Issues it holds, not from project_field", async () => {
      const { projectId } = await seedLocalProjectWithIssue();

      const result = await getProject(ctxFor(db, acme), projectId);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.fields.map((f) => f.name)).toContain("Status");
      const status = result.data.fields.find((f) => f.name === "Status");
      expect(status?.options.map((o) => o.name)).toEqual(["doing"]);
      // The parity itself, through the real query path: nineteen columns, the same nineteen a
      // mirrored GitHub Project reports (user request 2026-08-28 — see
      // `project-local-fields.test.ts` for the name-by-name list this count stands for).
      expect(result.data.fields).toHaveLength(19);
      // Still true after this — this is what FR-21 actually promises.
      expect(
        await db.select().from(projectField).where(eq(projectField.projectId, projectId)),
      ).toHaveLength(0);
    });

    it("listProjectItems carries the same derived values on each row", async () => {
      const { projectId, issueId, repositoryName } = await seedLocalProjectWithIssue();

      const page = await listProjectItems(ctxFor(db, acme), { projectId, limit: 10 });

      expect(page.ok).toBe(true);
      if (!page.ok) return;
      const row = page.data.items.find((i) => i.issueId === issueId);
      expect(row?.values["local:status"]).toEqual({
        type: "single_select",
        optionId: "status::doing",
      });
      expect(row?.values["local:priority"]).toEqual({ type: "single_select", optionId: "prio/p1" });
      expect(row?.values["local:assignees"]).toEqual({
        type: "user",
        users: [{ login: "ada", name: "Ada", avatarUrl: null }],
      });
      expect(row?.values["local:milestone"]).toEqual({ type: "text", text: "v1" });
      expect(row?.values["local:repository"]).toEqual({ type: "text", text: repositoryName });
      // Still true — this is the invariant the whole feature has to hold without breaking.
      expect(
        await db.select().from(projectValue).where(eq(projectValue.workspaceId, acme)),
      ).toHaveLength(0);
    });
  });
});

function fieldInput(over: Partial<Parameters<typeof replaceProjectFields>[2][number]> = {}) {
  return {
    providerFieldId: "field-1",
    name: "Status",
    type: "single_select" as const,
    options: [{ id: "opt-todo", name: "Todo" }],
    iterations: [],
    position: 0,
    readOnly: false,
    readOnlyReason: null,
    ...over,
  };
}

describe("replaceProjectFields", () => {
  it("updates a renamed field rather than creating a second one", async () => {
    // The provider's id is the key; the name is a label people change.
    const row = await seedProject(acme);
    const ctx = ctxFor(db, acme);
    await replaceProjectFields(ctx, row.id, [fieldInput({ name: "Status" })]);
    await replaceProjectFields(ctx, row.id, [fieldInput({ name: "State" })]);

    const result = await getProject(ctx, row.id);

    expect(result.ok && result.data.fields).toHaveLength(1);
    expect(result.ok && result.data.fields[0]?.name).toBe("State");
  });

  it("drops a field the provider stopped reporting, and its values with it", async () => {
    // A value with no column is unreadable — there is nothing left to parse it against.
    const row = await seedProject(acme);
    const ctx = ctxFor(db, acme);
    await replaceProjectFields(ctx, row.id, [fieldInput()]);
    const [field] = await db.select().from(projectField).where(eq(projectField.projectId, row.id));
    const issueRow = await seedIssue(db, acme);
    const [item] = await db
      .insert(projectItem)
      .values({ workspaceId: acme, projectId: row.id, issueId: issueRow.id, providerItemId: "i1" })
      .returning();
    await db.insert(projectValue).values({
      workspaceId: acme,
      itemId: item?.id ?? "",
      fieldId: field?.id ?? "",
      value: { type: "single_select", optionId: "opt-todo" },
    });

    await replaceProjectFields(ctx, row.id, []);

    expect(
      await db.select().from(projectField).where(eq(projectField.projectId, row.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(projectValue)
        .where(eq(projectValue.itemId, item?.id ?? "")),
    ).toHaveLength(0);
  });

  it("records that the provider cannot hold a field, with its reason", async () => {
    // The sentence the table shows instead of an input whose save would fail (Decision 0018).
    const row = await seedProject(acme);
    const ctx = ctxFor(db, acme);
    await replaceProjectFields(ctx, row.id, [
      fieldInput({
        providerFieldId: "estimate",
        name: "Estimate",
        type: "number",
        readOnly: true,
        readOnlyReason: "GitLab weights need a paid tier",
      }),
    ]);

    const result = await getProject(ctx, row.id);

    expect(result.ok && result.data.fields[0]).toMatchObject({
      readOnly: true,
      readOnlyReason: "GitLab weights need a paid tier",
    });
  });
});

describe("listProjectItems", () => {
  async function seedRows(count: number) {
    const row = await seedProject(acme);
    const ctx = ctxFor(db, acme);
    await replaceProjectFields(ctx, row.id, [fieldInput()]);
    const [field] = await db.select().from(projectField).where(eq(projectField.projectId, row.id));
    const items = [];
    for (let i = 0; i < count; i++) {
      const issueRow = await seedIssue(db, acme, { title: `Issue ${i}` });
      const [item] = await db
        .insert(projectItem)
        .values({
          workspaceId: acme,
          projectId: row.id,
          issueId: issueRow.id,
          providerItemId: `i${i}`,
          position: i,
        })
        .returning();
      if (item) items.push(item);
    }
    return { project: row, field, items, ctx };
  }

  it("renders a value it cannot parse as an empty cell, not a broken row", async () => {
    // #121 AC-3, and the reason it matters: one bad value inside a virtualized grid must not
    // take the viewport with it.
    const { project: row, field, items, ctx } = await seedRows(2);
    await db.insert(projectValue).values({
      workspaceId: acme,
      itemId: items[0]?.id ?? "",
      fieldId: field?.id ?? "",
      value: { type: "number", number: 7 }, // the field is a single_select
    });
    await db.insert(projectValue).values({
      workspaceId: acme,
      itemId: items[1]?.id ?? "",
      fieldId: field?.id ?? "",
      value: { type: "single_select", optionId: "opt-todo" },
    });

    const page = await listProjectItems(ctx, { projectId: row.id, limit: 100 });

    expect(page.ok).toBe(true);
    if (!page.ok) return;
    // Both rows are present; only the unreadable cell is missing.
    expect(page.data.items).toHaveLength(2);
    expect(page.data.items[0]?.values).toEqual({});
    expect(page.data.items[1]?.values[field?.id ?? ""]).toEqual({
      type: "single_select",
      optionId: "opt-todo",
    });
  });

  it("pages on position, and stops when the last page is read", async () => {
    const { project: row, ctx } = await seedRows(5);

    const first = await listProjectItems(ctx, { projectId: row.id, limit: 2 });
    expect(first.ok && first.data.items).toHaveLength(2);
    expect(first.ok && first.data.total).toBe(5);
    expect(first.ok && first.data.nextCursor).toBe("1");

    const second = await listProjectItems(ctx, {
      projectId: row.id,
      limit: 2,
      cursor: first.ok ? (first.data.nextCursor ?? "") : "",
    });
    expect(second.ok && second.data.items.map((i) => i.position)).toEqual([2, 3]);

    const last = await listProjectItems(ctx, { projectId: row.id, limit: 10, cursor: "3" });
    expect(last.ok && last.data.items).toHaveLength(1);
    expect(last.ok && last.data.nextCursor).toBeNull();
  });

  it("refuses a project in another Workspace (Principle V)", async () => {
    const { project: row } = await seedRows(1);

    const page = await listProjectItems(ctxFor(db, other), { projectId: row.id, limit: 10 });

    expect(page.ok).toBe(false);
  });
});

/**
 * What the table nests and counts by (issue #127).
 *
 * The hierarchy itself is `@solow/core`'s and proven there. What has to be true here is
 * that the row carries the *provider's* facts — parent, repository, closed — rather than
 * SoloW's own status, because an epic's progress counted from a Status column would be a
 * percentage a team could rename.
 */
describe("listProjectItems, hierarchy", () => {
  async function seedRow(
    projectId: string,
    providerItemId: string,
    overrides: Parameters<typeof seedIssue>[2] = {},
  ) {
    const issueRow = await seedIssue(db, acme, overrides);
    await db
      .insert(projectItem)
      .values({ workspaceId: acme, projectId, issueId: issueRow.id, providerItemId });
    return issueRow;
  }

  it("carries the Issue's provider parent, repository and closed state onto the row", async () => {
    const row = await seedProject(acme);
    await seedRow(row.id, "i-epic", { externalId: "gh-1", externalState: "open" });
    await seedRow(row.id, "i-child", {
      externalId: "gh-2",
      externalParentId: "gh-1",
      externalState: "closed",
    });

    const page = await listProjectItems(ctxFor(db, acme), { projectId: row.id, limit: 10 });

    expect(page.ok).toBe(true);
    if (!page.ok) return;
    const child = page.data.items.find((i) => i.issueExternalId === "gh-2");
    expect(child?.parentExternalId).toBe("gh-1");
    expect(child?.closed).toBe(true);
    expect(page.data.items.find((i) => i.issueExternalId === "gh-1")?.closed).toBe(false);
  });

  it("reads an Issue the mirror was never told the state of as not closed", async () => {
    // Null is "nobody has said", which is not "finished". Counting it as done would move a
    // percentage on no evidence (AC-3).
    const row = await seedProject(acme);
    await seedRow(row.id, "i-1", { externalId: "gh-9" });

    const page = await listProjectItems(ctxFor(db, acme), { projectId: row.id, limit: 10 });

    expect(page.ok && page.data.items[0]?.closed).toBe(false);
    expect(page.ok && page.data.items[0]?.parentExternalId).toBeNull();
  });
});

describe("when an Issue is deleted", () => {
  it("removes its rows without removing the project (#121 AC-6)", async () => {
    // A project is a mirror of something on the provider. Deleting one Issue out of it is not a
    // reason to forget the mirror.
    const row = await seedProject(acme);
    const ctx = ctxFor(db, acme);
    await replaceProjectFields(ctx, row.id, [fieldInput()]);
    const [field] = await db.select().from(projectField).where(eq(projectField.projectId, row.id));
    const issueRow = await seedIssue(db, acme);
    const [item] = await db
      .insert(projectItem)
      .values({ workspaceId: acme, projectId: row.id, issueId: issueRow.id, providerItemId: "i1" })
      .returning();
    await db.insert(projectValue).values({
      workspaceId: acme,
      itemId: item?.id ?? "",
      fieldId: field?.id ?? "",
      value: { type: "single_select", optionId: "opt-todo" },
    });

    const deleted = await deleteIssue(ctx, { id: issueRow.id, force: false });

    expect(deleted.ok).toBe(true);
    expect(
      await db.select().from(projectItem).where(eq(projectItem.projectId, row.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(projectValue)
        .where(eq(projectValue.itemId, item?.id ?? "")),
    ).toHaveLength(0);
    // The project itself survives.
    expect((await getProject(ctx, row.id)).ok).toBe(true);
  });
});

describe("setProjectSyncCursor", () => {
  it("stores where a paged sync reached, so a restart resumes (#121 AC-5)", async () => {
    const row = await seedProject(acme);
    const ctx = ctxFor(db, acme);

    await setProjectSyncCursor(ctx, row.id, "page-3", "2026-08-25T10:00:00.000Z");

    const [stored] = await db
      .select()
      .from(project)
      .where(and(eq(project.workspaceId, acme), eq(project.id, row.id)));
    expect(stored?.syncCursor).toBe("page-3");
    expect(stored?.syncedAt).toBe("2026-08-25T10:00:00.000Z");
  });

  it("clears the cursor when a sync completes", async () => {
    const row = await seedProject(acme);
    const ctx = ctxFor(db, acme);
    await setProjectSyncCursor(ctx, row.id, "page-3");

    await setProjectSyncCursor(ctx, row.id, null, "2026-08-25T11:00:00.000Z");

    const [stored] = await db.select().from(project).where(eq(project.id, row.id));
    expect(stored?.syncCursor).toBeNull();
  });
});

describe("deleteProject", () => {
  it("deletes every row that belongs to the Project, but never its Issues (user request 2026-08-27)", async () => {
    const row = await seedProject(acme);
    const ctx = ctxFor(db, acme);
    const a = await seedIssue(db, acme, { title: "Kept A" });
    const b = await seedIssue(db, acme, { title: "Kept B" });

    const [field] = await db
      .insert(projectField)
      .values({
        workspaceId: acme,
        projectId: row.id,
        providerFieldId: "field-status",
        name: "Status",
        type: "single_select",
      })
      .returning();
    if (!field) throw new Error("failed to seed field");

    const [itemA] = await db
      .insert(projectItem)
      .values({ workspaceId: acme, projectId: row.id, issueId: a.id, providerItemId: "PVTI_a" })
      .returning();
    if (!itemA) throw new Error("failed to seed item");
    await db
      .insert(projectItem)
      .values({ workspaceId: acme, projectId: row.id, issueId: b.id, providerItemId: "PVTI_b" });
    await db.insert(projectValue).values({
      workspaceId: acme,
      itemId: itemA.id,
      fieldId: field.id,
      value: { type: "single_select", optionId: "todo" },
    });
    await db.insert(projectView).values({ workspaceId: acme, projectId: row.id, name: "My view" });
    const [repo] = await db
      .insert(repository)
      .values({ workspaceId: acme, name: "gate", source: "local_path", location: "/repo" })
      .returning();
    if (!repo) throw new Error("failed to seed repository");
    await db
      .insert(projectRepository)
      .values({ workspaceId: acme, projectId: row.id, repositoryId: repo.id });

    const result = await deleteProject(ctx, row.id);

    expect(result).toEqual({ ok: true, data: { id: row.id } });
    expect(await db.select().from(project).where(eq(project.id, row.id))).toHaveLength(0);
    expect(
      await db.select().from(projectItem).where(eq(projectItem.projectId, row.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(projectValue).where(eq(projectValue.itemId, itemA.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(projectField).where(eq(projectField.projectId, row.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(projectView).where(eq(projectView.projectId, row.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(projectRepository).where(eq(projectRepository.projectId, row.id)),
    ).toHaveLength(0);

    // The whole point: both Issues are exactly as they were, just no longer anyone's row.
    const survivors = await db
      .select({ id: issue.id, title: issue.title })
      .from(issue)
      .where(eq(issue.workspaceId, acme));
    expect(survivors.map((s) => s.title).sort()).toEqual(["Kept A", "Kept B"]);
  });

  it("is scoped to the Workspace — another tenant cannot delete this Project", async () => {
    const row = await seedProject(acme);

    const result = await deleteProject(ctxFor(db, other), row.id);

    expect(result.ok).toBe(false);
    expect((await getProject(ctxFor(db, acme), row.id)).ok).toBe(true);
  });

  it("reports NotFound for a Project that does not exist", async () => {
    const result = await deleteProject(ctxFor(db, acme), "no-such-project");
    expect(result).toEqual({ ok: false, error: "NOT_FOUND" });
  });
});
