/// <reference types="bun-types" />

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  encryptSecret,
  integration,
  issue,
  project,
  projectItem,
  projectValue,
  repository,
  secret,
} from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import type { ExternalProjectItem } from "@solow/scm";
import { testing } from "@solow/scm";
import { eq } from "drizzle-orm";
import { adoptProject, refreshProject, scanProject } from "./project-sync.js";
import { ctxFor, seedWorkspaceGraph } from "./test-fixtures.js";

/**
 * The seam between the two capabilities (spec F23, issues #121–#126).
 *
 * This file exists because of a defect that every other test missed: the `projects` capability
 * reported an issue in GraphQL's node-id space while the `issues` capability persisted the REST
 * database id, so `refreshProject`'s join matched nothing, every row was counted as "waiting on
 * its issue", and the table was permanently empty. Both drivers' own tests passed — they each
 * asserted their own id — and nothing tested the join between them.
 *
 * So what is asserted here is the *agreement*: an item resolves to the Issue it names.
 */

const FIXTURE = "fixture.planner";
let db: TestDb;
let acme: string;
/**
 * Rows the provider reports beyond the two base ones, set per test.
 *
 * These carry their issue with them — the shape a real project has, where most rows come from
 * repositories this Workspace never connected.
 */
let carriedItems: ExternalProjectItem[] = [];
/** Repositories the provider will admit to, keyed by full name. */
let knownRepositories: Record<string, { name: string; cloneUrl: string }> = {};

beforeAll(() => {
  process.env.SOLOW_SECRET_KEY ??= Buffer.alloc(32, 3).toString("base64");
  testing.register({
    id: FIXTURE,
    name: "Fixture Planner",
    capabilities: ["issues", "projects", "repositories"],
    fields: [],
    projectFields: {
      expresses: ["single_select", "text", "number", "date", "iteration", "user", "url"],
      cannot: {},
    },
    driver: {
      provider: FIXTURE,
      authenticate: async () => ({ ok: true as const }),
      // The issues capability writes these ids into `issue.external_id`.
      listIssues: async () => [
        {
          externalId: "101",
          number: 1,
          title: "Cap the upload size",
          description: null,
          state: "open" as const,
          url: "u/1",
        },
        {
          externalId: "102",
          number: 2,
          title: "Rework the theme",
          description: null,
          state: "open" as const,
          url: "u/2",
        },
      ],
      getIssue: async () => ({
        externalId: "101",
        number: 1,
        title: "Cap the upload size",
        description: null,
        state: "open" as const,
        url: "u/1",
      }),
      listComments: async () => [],
      listLabels: async () => [],
      listRepositories: async () => [],
      listBranches: async () => [],
      getRepository: async (_c: unknown, fullName: string) => {
        const found = knownRepositories[fullName];
        return found
          ? {
              fullName,
              ...found,
              description: null,
              defaultBranch: "main",
              isPrivate: false,
              url: `u/${fullName}`,
            }
          : null;
      },
      listProjects: async () => [{ externalId: "PRJ_1", title: "Roadmap", url: "u/p" }],
      readProjectFields: async () => [
        {
          externalId: "f-status",
          name: "Status",
          type: "single_select" as const,
          options: [{ id: "todo", name: "Todo" }],
          iterations: [],
          position: 0,
          readOnly: false,
          readOnlyReason: null,
        },
      ],
      // ...and the projects capability must name an issue the same way.
      readProjectItems: async () => ({
        items: [
          {
            externalId: "it-1",
            issueExternalId: "101",
            position: 0,
            archivedAt: null,
            values: [
              {
                fieldExternalId: "f-status",
                value: { type: "single_select" as const, optionId: "todo" },
              },
            ],
          },
          {
            externalId: "it-2",
            issueExternalId: "102",
            position: 1,
            archivedAt: null,
            values: [],
          },
          ...carriedItems,
        ],
        nextCursor: null,
        drafts: 0,
        pullRequests: 0,
      }),
      writeProjectFieldValue: async (_c: unknown, w: { fieldExternalId: string }) => ({
        fieldExternalId: w.fieldExternalId,
        value: null,
      }),
      provisionProjectStructure: async () => ({ created: [], existing: [] }),
    },
  });
});
afterAll(() => testing.unregister(FIXTURE));

async function seedIntegration(): Promise<string> {
  const [token] = await db
    .insert(secret)
    .values({ workspaceId: acme, name: "pat", kind: "scm_pat", ciphertext: encryptSecret("t") })
    .returning();
  const [connected] = await db
    .insert(integration)
    .values({ workspaceId: acme, provider: FIXTURE, secretId: token?.id ?? "" })
    .returning();
  await db.insert(repository).values({
    workspaceId: acme,
    name: "gate",
    source: "remote_url",
    location: "https://example.test/acme/gate.git",
    integrationId: connected?.id ?? null,
    externalFullName: "acme/gate",
  });
  return connected?.id ?? "";
}

beforeEach(async () => {
  db = createTestDb();
  acme = (await seedWorkspaceGraph(db, "acme")).workspaceId;
  carriedItems = [];
  knownRepositories = {};
});

describe("adoptProject", () => {
  it("resolves every row to its Issue — the two capabilities agree on an id", async () => {
    // The regression this file exists for. `skipped` being non-zero here is the symptom that
    // read like a race and was a mismatch.
    const integrationId = await seedIntegration();

    const result = await adoptProject(ctxFor(db, acme), {
      integrationId,
      providerProjectId: "PRJ_1",
      title: "Roadmap",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.rows.items).toBe(2);
    expect(result.data.rows.skipped).toBe(0);
  });

  it("imports the issues first, so the table is full rather than empty", async () => {
    const integrationId = await seedIntegration();

    const result = await adoptProject(ctxFor(db, acme), {
      integrationId,
      providerProjectId: "PRJ_1",
      title: "Roadmap",
    });

    expect(result.ok && result.data.issues.imported).toBe(2);
    expect(await db.select().from(issue).where(eq(issue.workspaceId, acme))).toHaveLength(2);
  });

  it("links each row to the Issue it names, not merely to some Issue", async () => {
    const integrationId = await seedIntegration();
    await adoptProject(ctxFor(db, acme), {
      integrationId,
      providerProjectId: "PRJ_1",
      title: "Roadmap",
    });

    const rows = await db.select().from(projectItem).where(eq(projectItem.workspaceId, acme));
    const issues = await db.select().from(issue).where(eq(issue.workspaceId, acme));
    const byId = new Map(issues.map((i) => [i.id, i.externalId]));
    const pairs = rows.map((r) => [r.providerItemId, byId.get(r.issueId)]).sort();

    expect(pairs).toEqual([
      ["it-1", "101"],
      ["it-2", "102"],
    ]);
  });

  it("is idempotent — importing twice mirrors once", async () => {
    const integrationId = await seedIntegration();
    const input = { integrationId, providerProjectId: "PRJ_1", title: "Roadmap" };
    await adoptProject(ctxFor(db, acme), input);

    await adoptProject(ctxFor(db, acme), input);

    expect(await db.select().from(project).where(eq(project.workspaceId, acme))).toHaveLength(1);
    expect(
      await db.select().from(projectItem).where(eq(projectItem.workspaceId, acme)),
    ).toHaveLength(2);
  });

  it("counts a row whose Issue never arrived, rather than inventing one", async () => {
    // A row pointing at an issue nothing else in the product knows about would have Tasks and a
    // review history that lead nowhere.
    const integrationId = await seedIntegration();
    const ctx = ctxFor(db, acme);
    await adoptProject(ctx, { integrationId, providerProjectId: "PRJ_1", title: "Roadmap" });
    // Values reference items, so they go first — the same order the Issue delete path uses.
    await db.delete(projectValue).where(eq(projectValue.workspaceId, acme));
    await db.delete(projectItem).where(eq(projectItem.workspaceId, acme));
    await db.delete(issue).where(eq(issue.externalId, "102"));

    const [row] = await db.select().from(project).where(eq(project.workspaceId, acme));
    const refreshed = await refreshProject(ctx, row?.id ?? "");

    expect(refreshed.ok && refreshed.data.items).toBe(1);
    expect(refreshed.ok && refreshed.data.skipped).toBe(1);
  });
});

describe("a project that spans repositories nobody connected", () => {
  /** A row from a repository this Workspace has never heard of — the ordinary case. */
  const fromUnconnectedRepo: ExternalProjectItem = {
    externalId: "it-3",
    issueExternalId: "900",
    position: 2,
    archivedAt: null,
    values: [],
    issue: {
      repositoryFullName: "acme/other",
      externalId: "900",
      number: 9,
      title: "Rotate the certificate",
      description: null,
      state: "open",
      url: "u/9",
    },
  };

  it("connects the repository and imports the issue, instead of skipping the row for ever", async () => {
    // The defect: a project is *the* thing that spans repositories, so its rows pointed at issues
    // no repository sync would ever fetch. They were counted as "waiting" on every pass — a table
    // with nineteen columns and no rows.
    carriedItems = [fromUnconnectedRepo];
    knownRepositories["acme/other"] = {
      name: "other",
      cloneUrl: "https://example.test/acme/other.git",
    };
    const integrationId = await seedIntegration();

    const result = await adoptProject(ctxFor(db, acme), {
      integrationId,
      providerProjectId: "PRJ_1",
      title: "Roadmap",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.rows.skipped).toBe(0);
    expect(result.data.rows.items).toBe(3);
    // Named, not merely done: connecting a repository is a write into the operator's Workspace,
    // and one they cannot undo if they never learn it happened.
    expect(result.data.rows.connected).toEqual(["acme/other"]);
    const repos = await db.select().from(repository).where(eq(repository.workspaceId, acme));
    expect(repos.find((r) => r.externalFullName === "acme/other")?.location).toBe(
      "https://example.test/acme/other.git",
    );
  });

  it("leaves the row waiting when the provider will not hand the repository over", async () => {
    // A 404 means "absent, or your token cannot see it" — the provider's own ambiguity. Guessing
    // either way would be inventing a fact; the row stays counted, and nothing is written.
    carriedItems = [fromUnconnectedRepo];
    const integrationId = await seedIntegration();

    const result = await adoptProject(ctxFor(db, acme), {
      integrationId,
      providerProjectId: "PRJ_1",
      title: "Roadmap",
    });

    expect(result.ok && result.data.rows.skipped).toBe(1);
    expect(result.ok && result.data.rows.connected).toEqual([]);
    const repos = await db.select().from(repository).where(eq(repository.workspaceId, acme));
    expect(repos.some((r) => r.externalFullName === "acme/other")).toBe(false);
  });

  it("resolves each row against its own repository, not another one holding the same id", async () => {
    // GitLab's `iid` restarts at 1 per project, so several repositories genuinely have an issue
    // "101". A map keyed on the id alone holds exactly one of them and hands it to every row —
    // rows silently pointing into the wrong repository, which is worse than the empty table this
    // whole change fixed. Two colliding rows, so no ordering accident can make a single-key
    // lookup right for both.
    const collide = (repo: string, item: string): ExternalProjectItem => ({
      externalId: item,
      issueExternalId: "101",
      position: 2,
      archivedAt: null,
      values: [],
      issue: {
        repositoryFullName: repo,
        externalId: "101",
        number: 1,
        title: `#101 of ${repo}`,
        description: null,
        state: "open",
        url: `u/${repo}/1`,
      },
    });
    carriedItems = [collide("acme/other", "it-other"), collide("acme/third", "it-third")];
    knownRepositories["acme/other"] = {
      name: "other",
      cloneUrl: "https://example.test/acme/other.git",
    };
    knownRepositories["acme/third"] = {
      name: "third",
      cloneUrl: "https://example.test/acme/third.git",
    };
    const integrationId = await seedIntegration();

    await adoptProject(ctxFor(db, acme), {
      integrationId,
      providerProjectId: "PRJ_1",
      title: "Roadmap",
    });

    const rows = await db.select().from(projectItem).where(eq(projectItem.workspaceId, acme));
    const issues = await db.select().from(issue).where(eq(issue.workspaceId, acme));
    const repoNameById = new Map(
      (await db.select().from(repository).where(eq(repository.workspaceId, acme))).map((r) => [
        r.id,
        r.externalFullName,
      ]),
    );
    const repoOf = (itemId: string) => {
      const found = issues.find(
        (i) => i.id === rows.find((r) => r.providerItemId === itemId)?.issueId,
      );
      return found ? repoNameById.get(found.repositoryId ?? "") : undefined;
    };

    expect(repoOf("it-other")).toBe("acme/other");
    expect(repoOf("it-third")).toBe("acme/third");
  });
});

describe("scanProject", () => {
  it("starts over rather than resuming, because a scan is asked for when the mirror is wrong", async () => {
    // The repair path. A project adopted before its repositories could be connected holds a
    // *finished* sync and no rows; resuming from wherever a cursor was left would re-read the
    // tail and leave the already-skipped rows exactly as they are — the state it was called to
    // fix. The rows here were deleted behind the mirror's back to stand in for that.
    const integrationId = await seedIntegration();
    const ctx = ctxFor(db, acme);
    await adoptProject(ctx, { integrationId, providerProjectId: "PRJ_1", title: "Roadmap" });
    await db.delete(projectValue).where(eq(projectValue.workspaceId, acme));
    await db.delete(projectItem).where(eq(projectItem.workspaceId, acme));
    const [row] = await db.select().from(project).where(eq(project.workspaceId, acme));
    // A cursor left pointing past the end, as a half-finished walk would leave it.
    await db
      .update(project)
      .set({ syncCursor: "PAGE_9" })
      .where(eq(project.id, row?.id ?? ""));

    const scanned = await scanProject(ctx, row?.id ?? "");

    expect(scanned.ok && scanned.data.items).toBe(2);
    expect(
      await db.select().from(projectItem).where(eq(projectItem.workspaceId, acme)),
    ).toHaveLength(2);
  });
});

describe("what a rescan does to an issue it already has", () => {
  /*
   * The defect this covers: a Workspace that imported its issues *before* adopting the project
   * kept them for ever without labels and without a hierarchy. GitHub's REST issue listing
   * returns neither labels nor the sub-issue parent; the project's GraphQL query asks for both.
   * Skipping on conflict meant the richer answer was thrown away every single pass.
   */
  const carried = (over: Record<string, unknown> = {}): ExternalProjectItem => ({
    externalId: "it-rich",
    issueExternalId: "101",
    position: 0,
    archivedAt: null,
    values: [],
    issue: {
      repositoryFullName: "acme/gate",
      externalId: "101",
      number: 1,
      title: "Cap the upload size",
      description: null,
      state: "open",
      url: "u/1",
      labels: ["type/feat", "size/m"],
      parentExternalId: "900",
      ...over,
    },
  });

  it("fills in the labels and the parent an earlier thin import never had", async () => {
    const integrationId = await seedIntegration();
    const ctx = ctxFor(db, acme);
    // First pass: the plain listing, which carries neither.
    await adoptProject(ctx, { integrationId, providerProjectId: "PRJ_1", title: "Roadmap" });
    const [before] = await db.select().from(issue).where(eq(issue.externalId, "101"));
    expect(before?.labels).toEqual([]);
    expect(before?.externalParentId).toBeNull();

    // Second pass, now that the project row carries the richer answer.
    carriedItems = [carried()];
    const [row] = await db.select().from(project).where(eq(project.workspaceId, acme));
    await scanProject(ctx, row?.id ?? "");

    const [after] = await db.select().from(issue).where(eq(issue.externalId, "101"));
    expect(after?.labels).toEqual(["type/feat", "size/m"]);
    expect(after?.externalParentId).toBe("900");
  });

  it("does not blank a field this pass could not read", async () => {
    // Absent is "could not say", not "none". A pass that cannot report labels must leave the ones
    // an earlier pass established — otherwise every poll that degrades erases real data.
    const integrationId = await seedIntegration();
    const ctx = ctxFor(db, acme);
    carriedItems = [carried()];
    await adoptProject(ctx, { integrationId, providerProjectId: "PRJ_1", title: "Roadmap" });
    const [row] = await db.select().from(project).where(eq(project.workspaceId, acme));

    // A degraded pass: the same row, with neither labels nor a parent reported.
    carriedItems = [carried({ labels: undefined, parentExternalId: undefined })];
    await scanProject(ctx, row?.id ?? "");

    const [after] = await db.select().from(issue).where(eq(issue.externalId, "101"));
    expect(after?.labels).toEqual(["type/feat", "size/m"]);
    expect(after?.externalParentId).toBe("900");
  });
});
