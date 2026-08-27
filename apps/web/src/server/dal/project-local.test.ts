/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import {
  encryptSecret,
  integration,
  project,
  projectField,
  projectItem,
  projectRepository,
  projectValue,
  secret,
} from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { eq } from "drizzle-orm";

// The secret store reads SOLOW_SECRET_KEY lazily (via the validated env module), so a
// mirrored-Project fixture that encrypts a PAT needs it set before that runs.
process.env.SOLOW_SECRET_KEY ??= Buffer.alloc(32, 11).toString("base64");

import {
  attachProjectRepository,
  createLocalProject,
  detachProjectRepository,
  listProjectRepositories,
} from "./project-local.js";
import { ctxFor, seedIssue, seedWorkspaceGraph } from "./test-fixtures.js";

/**
 * Local Projects (spec F23, Decision 0018's reversal, user request 2026-08-27).
 *
 * What matters here is the membership decision itself: registering a Repository backfills what
 * it already holds, a detach removes exactly what that registration put in the Project, and a
 * mirrored Project's own `project_repository` table stays permanently untouched — its rows come
 * from a sync, not from this file.
 */

let db: TestDb;
let acme: string;
let acmeRepositoryId: string;
let other: string;

/** A local Project: no Integration, no provider board. */
async function seedLocalProject(workspaceId: string, title = "Roadmap") {
  const [row] = await db
    .insert(project)
    .values({ workspaceId, title, integrationId: null, providerProjectId: null })
    .returning();
  if (!row) throw new Error("failed to seed local project");
  return row;
}

/** A mirrored Project — attach/detach must refuse this one outright. */
async function seedMirroredProject(workspaceId: string, title = "Mirrored") {
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
  if (!row) throw new Error("failed to seed mirrored project");
  return row;
}

beforeEach(async () => {
  db = createTestDb();
  const acmeGraph = await seedWorkspaceGraph(db, "acme");
  acme = acmeGraph.workspaceId;
  acmeRepositoryId = acmeGraph.repositoryId;
  other = (await seedWorkspaceGraph(db, "other")).workspaceId;
});

describe("createLocalProject", () => {
  it("creates a Project with no Integration and no provider board", async () => {
    const result = await createLocalProject(ctxFor(db, acme), { title: "Roadmap" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.source).toBe("local");
    expect(result.data.integrationId).toBeNull();
    expect(result.data.providerProjectId).toBeNull();
    expect(result.data.itemCount).toBe(0);
    expect(result.data.fields).toEqual([]);
    // Set at creation — there is no provider to disagree with, so "never synced" would
    // misdescribe it forever.
    expect(result.data.syncedAt).not.toBeNull();
  });
});

describe("listProjectRepositories", () => {
  it("counts Issues per attached Repository", async () => {
    const proj = await seedLocalProject(acme);
    const ctx = ctxFor(db, acme);
    await seedIssue(db, acme, { repositoryId: acmeRepositoryId, title: "One" });
    await seedIssue(db, acme, { repositoryId: acmeRepositoryId, title: "Two" });
    const attached = await attachProjectRepository(ctx, {
      projectId: proj.id,
      repositoryId: acmeRepositoryId,
    });
    expect(attached.ok).toBe(true);

    const result = await listProjectRepositories(ctx, { projectId: proj.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      repositoryId: acmeRepositoryId,
      issueCount: 2,
    });
  });

  it("404s on a Project in another Workspace (Principle V)", async () => {
    const proj = await seedLocalProject(acme);

    const result = await listProjectRepositories(ctxFor(db, other), { projectId: proj.id });

    expect(result.ok).toBe(false);
  });
});

describe("attachProjectRepository", () => {
  it("backfills every existing Issue in the Repository", async () => {
    const proj = await seedLocalProject(acme);
    const ctx = ctxFor(db, acme);
    const issueA = await seedIssue(db, acme, { repositoryId: acmeRepositoryId, title: "A" });
    const issueB = await seedIssue(db, acme, { repositoryId: acmeRepositoryId, title: "B" });

    const result = await attachProjectRepository(ctx, {
      projectId: proj.id,
      repositoryId: acmeRepositoryId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.issueCount).toBe(2);
    const items = await db.select().from(projectItem).where(eq(projectItem.projectId, proj.id));
    expect(items.map((i) => i.issueId).sort()).toEqual([issueA.id, issueB.id].sort());
  });

  it("refuses on a mirrored Project (NotLocal)", async () => {
    const proj = await seedMirroredProject(acme);

    const result = await attachProjectRepository(ctxFor(db, acme), {
      projectId: proj.id,
      repositoryId: acmeRepositoryId,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe("PROJECT_NOT_LOCAL");
  });

  it("refuses a duplicate attach (RepositoryAlreadyAttached)", async () => {
    const proj = await seedLocalProject(acme);
    const ctx = ctxFor(db, acme);
    await attachProjectRepository(ctx, { projectId: proj.id, repositoryId: acmeRepositoryId });

    const result = await attachProjectRepository(ctx, {
      projectId: proj.id,
      repositoryId: acmeRepositoryId,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe("PROJECT_REPOSITORY_ALREADY_ATTACHED");
  });

  it("404s attaching another Workspace's Repository (Principle V)", async () => {
    const proj = await seedLocalProject(acme);
    const otherGraph = await seedWorkspaceGraph(db, "intruder");

    const result = await attachProjectRepository(ctxFor(db, acme), {
      projectId: proj.id,
      repositoryId: otherGraph.repositoryId,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe("NOT_FOUND");
  });

  it("404s attaching a Repository to another Workspace's Project (Principle V)", async () => {
    const proj = await seedLocalProject(acme);

    const result = await attachProjectRepository(ctxFor(db, other), {
      projectId: proj.id,
      repositoryId: acmeRepositoryId,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe("NOT_FOUND");
  });
});

describe("detachProjectRepository", () => {
  it("removes the project_item/project_value rows and the membership itself", async () => {
    const proj = await seedLocalProject(acme);
    const ctx = ctxFor(db, acme);
    await seedIssue(db, acme, { repositoryId: acmeRepositoryId, title: "A" });
    const attached = await attachProjectRepository(ctx, {
      projectId: proj.id,
      repositoryId: acmeRepositoryId,
    });
    expect(attached.ok).toBe(true);
    const [item] = await db.select().from(projectItem).where(eq(projectItem.projectId, proj.id));
    // Defensive fixture: a local Project has no fields today, but the detach cascade is written
    // to clean up `project_value` rows regardless — this proves it actually does when one exists.
    const [field] = await db
      .insert(projectField)
      .values({
        workspaceId: acme,
        projectId: proj.id,
        providerFieldId: "f1",
        name: "Notes",
        type: "text",
      })
      .returning();
    await db.insert(projectValue).values({
      workspaceId: acme,
      itemId: item?.id ?? "",
      fieldId: field?.id ?? "",
      value: { type: "text", text: "hi" },
    });

    const result = await detachProjectRepository(ctx, {
      projectId: proj.id,
      repositoryId: acmeRepositoryId,
    });

    expect(result.ok).toBe(true);
    expect(
      await db.select().from(projectItem).where(eq(projectItem.projectId, proj.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(projectValue)
        .where(eq(projectValue.itemId, item?.id ?? "")),
    ).toHaveLength(0);
    expect(
      await db.select().from(projectRepository).where(eq(projectRepository.projectId, proj.id)),
    ).toHaveLength(0);
  });

  it("404s on a pair that was never attached", async () => {
    const proj = await seedLocalProject(acme);

    const result = await detachProjectRepository(ctxFor(db, acme), {
      projectId: proj.id,
      repositoryId: acmeRepositoryId,
    });

    expect(result.ok).toBe(false);
  });

  it("leaves no stale rows for a subsequent re-attach to trip over", async () => {
    const proj = await seedLocalProject(acme);
    const ctx = ctxFor(db, acme);
    await seedIssue(db, acme, { repositoryId: acmeRepositoryId, title: "A" });
    await attachProjectRepository(ctx, { projectId: proj.id, repositoryId: acmeRepositoryId });
    await detachProjectRepository(ctx, { projectId: proj.id, repositoryId: acmeRepositoryId });

    const reattached = await attachProjectRepository(ctx, {
      projectId: proj.id,
      repositoryId: acmeRepositoryId,
    });

    expect(reattached.ok).toBe(true);
    if (!reattached.ok) return;
    expect(reattached.data.issueCount).toBe(1);
    expect(
      await db.select().from(projectItem).where(eq(projectItem.projectId, proj.id)),
    ).toHaveLength(1);
  });
});
