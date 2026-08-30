/// <reference types="bun-types" />

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  encryptSecret,
  integration,
  issue,
  project,
  projectItem,
  repository,
  secret,
} from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import type { EpicSeed, ExternalEpic, ExternalGroup, ExternalIssue, IssueSeed } from "@solow/scm";
import { testing } from "@solow/scm";
import { eq } from "drizzle-orm";
import { appRouter } from "../routers/index.js";
import type { BaseContext } from "../trpc.js";
import {
  createEpic,
  createProviderIssue,
  listCreatableGroups,
  listGroupEpics,
} from "./issue-create.js";
import { ctxFor, seedWorkspaceGraph } from "./test-fixtures.js";

/**
 * Creating on the provider, and mirroring what it answered (spec F23a Part 1).
 *
 * The property this file exists for is F23 NFR-7, and it is asserted the only way that catches a
 * pass-through bug: the fixture provider deliberately answers with a *different* title and a
 * different number from the ones sent, so a DAL that echoed its input back would fail here rather
 * than pass on a coincidence.
 */

/** A provider that creates issues and has epics — GitLab's shape. */
const EPICS = "fixture.creates";
/** A provider that creates issues and has none — GitHub's shape, throws if reached. */
const NO_EPICS = "fixture.noepics";

/** The seed the fixture last received, so absent-vs-present can be asserted on the way out. */
let lastSeed: IssueSeed | null = null;
let lastEpicSeed: EpicSeed | null = null;
/** How many times the provider was actually reached — a refusal must not have touched it. */
let createIssueCalls = 0;

const STORED_ISSUE: ExternalIssue = {
  externalId: "ext-9001",
  number: 4242,
  title: "Gate sticks on the second cycle",
  description: "As the provider stored it",
  state: "open",
  url: "https://provider.test/acme/gate/-/issues/4242",
  labels: ["bug"],
  assignees: [{ login: "mo", name: "Mo", avatarUrl: null }],
};

const STORED_EPIC: ExternalEpic = {
  externalId: "epic-7",
  iid: 7,
  title: "Q3 reliability",
  url: "https://provider.test/groups/acme/-/epics/7",
  state: "open",
  startDate: "2026-07-01",
  dueDate: null,
  groupRef: "acme",
};

const GROUPS: ExternalGroup[] = [
  { externalId: "g-1", fullPath: "acme", name: "Acme", url: "https://provider.test/acme" },
  {
    externalId: "g-2",
    fullPath: "acme/platform",
    name: "Platform",
    url: "https://provider.test/acme/platform",
  },
];

function throwing(reason: string) {
  return () => {
    throw new Error(reason);
  };
}

beforeAll(() => {
  process.env.SOLOW_SECRET_KEY ??= Buffer.alloc(32, 7).toString("base64");
  testing.register({
    id: EPICS,
    name: "Fixture Creator",
    capabilities: ["issueCreates"],
    fields: [],
    issueCreates: { epics: true },
    driver: {
      provider: EPICS,
      authenticate: async () => ({ ok: true as const }),
      createIssue: async (_c: unknown, _repo: string, seed: IssueSeed) => {
        lastSeed = seed;
        createIssueCalls += 1;
        return STORED_ISSUE;
      },
      createEpic: async (_c: unknown, groupRef: string, seed: EpicSeed) => {
        lastEpicSeed = seed;
        return { ...STORED_EPIC, groupRef };
      },
      listGroups: async () => GROUPS,
      listEpics: async (_c: unknown, groupRef: string) => [{ ...STORED_EPIC, groupRef }],
    },
  });
  testing.register({
    id: NO_EPICS,
    name: "Fixture Epicless",
    capabilities: ["issueCreates"],
    fields: [],
    issueCreates: { epics: false },
    driver: {
      provider: NO_EPICS,
      authenticate: async () => ({ ok: true as const }),
      createIssue: async () => STORED_ISSUE,
      // Exactly what `GithubProvider` does — the throw the DAL must refuse before reaching.
      createEpic: throwing("this provider has no epics"),
      listGroups: throwing("this provider has no groups"),
      listEpics: throwing("this provider has no epics"),
    },
  });
});
afterAll(() => {
  testing.unregister(EPICS);
  testing.unregister(NO_EPICS);
});

let db: TestDb;
let acme: string;
let localRepositoryId: string;

/** A connected Integration plus a Repository linked to it, in the given Workspace. */
async function seedLinkedRepository(
  workspaceId: string,
  provider: string,
): Promise<{ integrationId: string; repositoryId: string }> {
  const [token] = await db
    .insert(secret)
    .values({ workspaceId, name: "pat", kind: "scm_pat", ciphertext: encryptSecret("t") })
    .returning();
  const [connected] = await db
    .insert(integration)
    .values({ workspaceId, provider, secretId: token?.id ?? "" })
    .returning();
  const [repo] = await db
    .insert(repository)
    .values({
      workspaceId,
      name: "gate",
      source: "remote_url",
      location: "https://provider.test/acme/gate.git",
      integrationId: connected?.id ?? null,
      externalFullName: "acme/gate",
    })
    .returning();
  return { integrationId: connected?.id ?? "", repositoryId: repo?.id ?? "" };
}

async function seedProject(workspaceId: string, title = "Roadmap"): Promise<string> {
  const [row] = await db.insert(project).values({ workspaceId, title }).returning();
  return row?.id ?? "";
}

beforeEach(async () => {
  db = createTestDb();
  const seeded = await seedWorkspaceGraph(db, "acme");
  acme = seeded.workspaceId;
  localRepositoryId = seeded.repositoryId;
  lastSeed = null;
  lastEpicSeed = null;
  createIssueCalls = 0;
});

describe("createProviderIssue", () => {
  it("answers with the provider's values, never the ones that were sent (F23 NFR-7)", async () => {
    const { repositoryId } = await seedLinkedRepository(acme, EPICS);

    const result = await createProviderIssue(ctxFor(db, acme), {
      repositoryId,
      title: "Gate sticks",
      description: "Typed body",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Every one of these differs from the input above — an echo would show "Gate sticks".
    expect(result.data.title).toBe("Gate sticks on the second cycle");
    expect(result.data.externalNumber).toBe(4242);
    expect(result.data.externalUrl).toBe("https://provider.test/acme/gate/-/issues/4242");
  });

  it("passes absent fields through as absent, so the provider keeps its own defaults", async () => {
    const { repositoryId } = await seedLinkedRepository(acme, EPICS);

    await createProviderIssue(ctxFor(db, acme), {
      repositoryId,
      title: "Gate sticks",
      labels: [],
    });

    expect(lastSeed).toEqual({ title: "Gate sticks", labels: [] });
  });

  it("mirrors the created Issue locally, with what the provider stored on it", async () => {
    const { integrationId, repositoryId } = await seedLinkedRepository(acme, EPICS);

    const result = await createProviderIssue(ctxFor(db, acme), {
      repositoryId,
      title: "Gate sticks",
    });

    expect(result.ok).toBe(true);
    const rows = await db.select().from(issue).where(eq(issue.workspaceId, acme));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.ok ? result.data.issueId : "",
      title: "Gate sticks on the second cycle",
      source: EPICS,
      integrationId,
      repositoryId,
      externalId: "ext-9001",
      externalNumber: 4242,
      externalState: "open",
      labels: ["bug"],
      assignees: [{ login: "mo", name: "Mo", avatarUrl: null }],
    });
  });

  it("attaches the mirrored Issue to the Project the create was started from", async () => {
    const { repositoryId } = await seedLinkedRepository(acme, EPICS);
    const projectId = await seedProject(acme);

    const result = await createProviderIssue(ctxFor(db, acme), {
      repositoryId,
      projectId,
      title: "Gate sticks",
    });

    const items = await db.select().from(projectItem).where(eq(projectItem.projectId, projectId));
    expect(items).toHaveLength(1);
    expect(items[0]?.issueId).toBe(result.ok ? result.data.issueId : "");
  });

  it("refuses a Repository belonging to another Workspace", async () => {
    const other = (await seedWorkspaceGraph(db, "other")).workspaceId;
    const foreign = await seedLinkedRepository(other, EPICS);

    const result = await createProviderIssue(ctxFor(db, acme), {
      repositoryId: foreign.repositoryId,
      title: "Gate sticks",
    });

    expect(result).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(createIssueCalls).toBe(0);
  });

  it("refuses a Project belonging to another Workspace, before the provider is touched", async () => {
    const { repositoryId } = await seedLinkedRepository(acme, EPICS);
    const other = (await seedWorkspaceGraph(db, "other")).workspaceId;
    const foreignProject = await seedProject(other, "Theirs");

    const result = await createProviderIssue(ctxFor(db, acme), {
      repositoryId,
      projectId: foreignProject,
      title: "Gate sticks",
    });

    expect(result).toEqual({ ok: false, error: "NOT_FOUND" });
    // The point of checking first: a refused create must not leave a real issue on the provider.
    expect(createIssueCalls).toBe(0);
    expect(await db.select().from(issue).where(eq(issue.workspaceId, acme))).toHaveLength(0);
  });

  it("refuses a purely local-path Repository with a typed error", async () => {
    const result = await createProviderIssue(ctxFor(db, acme), {
      repositoryId: localRepositoryId,
      title: "Gate sticks",
    });

    expect(result).toEqual({ ok: false, error: "INTEGRATION_NOT_LINKED" });
    expect(createIssueCalls).toBe(0);
  });
});

describe("createEpic", () => {
  it("answers with the epic the provider stored", async () => {
    const { integrationId } = await seedLinkedRepository(acme, EPICS);

    const result = await createEpic(ctxFor(db, acme), {
      integrationId,
      groupRef: "acme/platform",
      title: "Reliability",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      externalId: "epic-7",
      iid: 7,
      title: "Q3 reliability",
      url: "https://provider.test/groups/acme/-/epics/7",
      state: "open",
      startDate: "2026-07-01",
      dueDate: null,
      groupRef: "acme/platform",
    });
  });

  it("carries the three date states through: absent, null and fixed are three requests", async () => {
    const { integrationId } = await seedLinkedRepository(acme, EPICS);
    const ctx = ctxFor(db, acme);

    await createEpic(ctx, { integrationId, groupRef: "acme", title: "A" });
    expect(lastEpicSeed).toEqual({ title: "A" });

    await createEpic(ctx, { integrationId, groupRef: "acme", title: "B", startDate: null });
    expect(lastEpicSeed).toEqual({ title: "B", startDate: null });

    await createEpic(ctx, { integrationId, groupRef: "acme", title: "C", dueDate: "2026-09-30" });
    expect(lastEpicSeed).toEqual({ title: "C", dueDate: "2026-09-30" });
  });

  it("synthesises no Project row — the epic surfaces on the next sync", async () => {
    const { integrationId } = await seedLinkedRepository(acme, EPICS);

    await createEpic(ctxFor(db, acme), { integrationId, groupRef: "acme", title: "Reliability" });

    expect(await db.select().from(project).where(eq(project.workspaceId, acme))).toHaveLength(0);
    expect(await db.select().from(issue).where(eq(issue.workspaceId, acme))).toHaveLength(0);
  });

  it("refuses a provider without epics with a typed error, not the driver's throw", async () => {
    const { integrationId } = await seedLinkedRepository(acme, NO_EPICS);

    const result = await createEpic(ctxFor(db, acme), {
      integrationId,
      groupRef: "acme",
      title: "Reliability",
    });

    expect(result).toEqual({ ok: false, error: "INTEGRATION_CAPABILITY_UNAVAILABLE" });
  });

  it("refuses an Integration belonging to another Workspace", async () => {
    const other = (await seedWorkspaceGraph(db, "other")).workspaceId;
    const foreign = await seedLinkedRepository(other, EPICS);

    const result = await createEpic(ctxFor(db, acme), {
      integrationId: foreign.integrationId,
      groupRef: "acme",
      title: "Reliability",
    });

    expect(result).toEqual({ ok: false, error: "NOT_FOUND" });
  });
});

describe("listCreatableGroups / listGroupEpics", () => {
  it("passes the provider's groups through, stamped with the Integration they came from", async () => {
    const { integrationId } = await seedLinkedRepository(acme, EPICS);

    const result = await listCreatableGroups(ctxFor(db, acme), { integrationId });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([
      {
        integrationId,
        externalId: "g-1",
        fullPath: "acme",
        name: "Acme",
        url: GROUPS[0]?.url ?? "",
      },
      {
        integrationId,
        externalId: "g-2",
        fullPath: "acme/platform",
        name: "Platform",
        url: GROUPS[1]?.url ?? "",
      },
    ]);
  });

  it("passes the group's epics through as the provider reported them", async () => {
    const { integrationId } = await seedLinkedRepository(acme, EPICS);

    const result = await listGroupEpics(ctxFor(db, acme), {
      integrationId,
      groupRef: "acme/platform",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([{ ...STORED_EPIC, groupRef: "acme/platform" }]);
  });

  it("refuses both on a provider without epics, rather than letting the driver throw", async () => {
    const { integrationId } = await seedLinkedRepository(acme, NO_EPICS);
    const ctx = ctxFor(db, acme);

    expect(await listCreatableGroups(ctx, { integrationId })).toEqual({
      ok: false,
      error: "INTEGRATION_CAPABILITY_UNAVAILABLE",
    });
    expect(await listGroupEpics(ctx, { integrationId, groupRef: "acme" })).toEqual({
      ok: false,
      error: "INTEGRATION_CAPABILITY_UNAVAILABLE",
    });
  });

  it("refuses an Integration belonging to another Workspace", async () => {
    const other = (await seedWorkspaceGraph(db, "other")).workspaceId;
    const foreign = await seedLinkedRepository(other, EPICS);

    expect(
      await listCreatableGroups(ctxFor(db, acme), { integrationId: foreign.integrationId }),
    ).toEqual({ ok: false, error: "NOT_FOUND" });
  });
});

/**
 * The four procedures the client is written against, called through the router that publishes
 * them — the layer where a renamed procedure or a mis-wired input schema would show up.
 */
describe("router wiring", () => {
  function caller(workspaceId: string) {
    const ctx: BaseContext = {
      db,
      session: { workspaceId, userId: "user-1" },
      flagOverrides: { "ff-core-program": true },
    };
    return appRouter.createCaller(ctx);
  }

  it("issue.createOnProvider, project.createEpic, project.listGroups and project.listEpics", async () => {
    const { integrationId, repositoryId } = await seedLinkedRepository(acme, EPICS);
    const projectId = await seedProject(acme);
    const api = caller(acme);

    const created = await api.issue.createOnProvider({
      repositoryId,
      projectId,
      title: "Gate sticks",
      labels: ["ops"],
    });
    expect(created.externalNumber).toBe(4242);
    expect(created.title).toBe("Gate sticks on the second cycle");

    const epic = await api.project.createEpic({ integrationId, groupRef: "acme", title: "Q3" });
    expect(epic.iid).toBe(7);

    expect(await api.project.listGroups({ integrationId })).toHaveLength(2);
    expect(await api.project.listEpics({ integrationId, groupRef: "acme" })).toHaveLength(1);
  });

  it("surfaces a provider without epics as a stated refusal rather than a 500", async () => {
    const { integrationId } = await seedLinkedRepository(acme, NO_EPICS);
    const api = caller(acme);

    await expect(
      api.project.createEpic({ integrationId, groupRef: "acme", title: "Q3" }),
    ).rejects.toMatchObject({ message: "INTEGRATION_CAPABILITY_UNAVAILABLE" });
  });
});
