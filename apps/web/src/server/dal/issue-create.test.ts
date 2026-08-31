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
import type {
  EpicSeed,
  ExternalEpic,
  ExternalGroup,
  ExternalIssue,
  ExternalIssueType,
  IssueSeed,
} from "@solow/scm";
import { testing } from "@solow/scm";
import { eq } from "drizzle-orm";
import { appRouter } from "../routers/index.js";
import type { BaseContext } from "../trpc.js";
import {
  createEpic,
  createParentPlanningItem,
  createProviderIssue,
  listCreatableGroups,
  listGroupEpics,
} from "./issue-create.js";
import { listRepositoryIssueTypes } from "./repository.js";
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
/**
 * A provider that creates issues, has no epics, and declares no parent planning item either —
 * the "nobody has said" case, which both gates must read as a refusal rather than as permission.
 */
const NO_EPICS = "fixture.noepics";
/**
 * A provider with no epics that *can* originate a parent planning item, in a repository — GitHub's
 * shape after the F23a Part 3 split. It exists so the new gate can be tested independently of
 * `epics`, which is the property the whole change hangs on.
 */
const REPO_PARENT = "fixture.repoparent";

/** The seed the fixture last received, so absent-vs-present can be asserted on the way out. */
let lastSeed: IssueSeed | null = null;
/** The same, for the repository-container parent path — a separate method, so a separate record. */
let lastParentSeed: IssueSeed | null = null;
let createParentCalls = 0;
let lastEpicSeed: EpicSeed | null = null;
/** How many times the provider was actually reached — a refusal must not have touched it. */
let createIssueCalls = 0;
/** Same, for the type picker: a provider that declares none must not be asked at all. */
let listIssueTypesCalls = 0;

const STORED_TYPES: ExternalIssueType[] = [
  { externalId: "1", name: "Bug", description: "Something is broken", color: "red" },
  { externalId: "2", name: "Feature", description: null, color: null },
];

/** What the parent-item fixture answers with — every field different from anything a test sends. */
const STORED_PARENT: ExternalIssue = {
  externalId: "ext-7007",
  number: 77,
  title: "Cold-weather reliability, as the provider stored it",
  description: null,
  state: "open",
  url: "https://provider.test/acme/gate/issues/77",
};

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
    // Two capabilities in one fixture, deliberately: `epics` and `issueTypes` are declared
    // independently, and a DAL that gated one on the other would pass every epic test and still
    // be wrong. No real provider declares both today, which is exactly why the fixture does.
    issueCreates: {
      epics: true,
      parentPlanningItem: { container: "group", noun: "epic" },
      issueTypes: true,
    },
    driver: {
      provider: EPICS,
      authenticate: async () => ({ ok: true as const }),
      // GitLab's answer: a parent item here is an epic in a group, so the repository-shaped method
      // throws rather than quietly creating a plain issue and calling it a parent.
      createParentPlanningItem: throwing("this provider's parent item lives in a group"),
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
      listIssueTypes: async () => {
        listIssueTypesCalls += 1;
        return STORED_TYPES;
      },
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
      createParentPlanningItem: throwing("this provider originates no parent item"),
      listGroups: throwing("this provider has no groups"),
      listEpics: throwing("this provider has no epics"),
      listIssueTypes: throwing("this provider has no issue types"),
    },
  });
  testing.register({
    id: REPO_PARENT,
    name: "Fixture Sub-issues",
    capabilities: ["issueCreates"],
    fields: [],
    // The pairing the user's decision produced: no epics, and still a parent planning item — in a
    // repository. A DAL that read one flag for the other would fail on this fixture and no other.
    issueCreates: {
      epics: false,
      parentPlanningItem: { container: "repository", noun: "parent issue" },
    },
    driver: {
      provider: REPO_PARENT,
      authenticate: async () => ({ ok: true as const }),
      createIssue: async () => STORED_ISSUE,
      createParentPlanningItem: async (_c: unknown, _repo: string, seed: IssueSeed) => {
        lastParentSeed = seed;
        createParentCalls += 1;
        return STORED_PARENT;
      },
      createEpic: throwing("this provider has no epics"),
      listGroups: throwing("this provider has no groups"),
      listEpics: throwing("this provider has no epics"),
      listIssueTypes: throwing("this provider has no issue types"),
    },
  });
});
afterAll(() => {
  testing.unregister(EPICS);
  testing.unregister(NO_EPICS);
  testing.unregister(REPO_PARENT);
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
    // Named for the provider rather than a fixed "pat": secret names are unique per Workspace,
    // and a test that connects two providers at once would otherwise collide on the seed.
    .values({
      workspaceId,
      name: `pat-${provider}`,
      kind: "scm_pat",
      ciphertext: encryptSecret("t"),
    })
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
  lastParentSeed = null;
  createParentCalls = 0;
  createIssueCalls = 0;
  listIssueTypesCalls = 0;
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

  it("carries every provider extra through to the seed, whichever provider's it is", async () => {
    const { repositoryId } = await seedLinkedRepository(acme, EPICS);

    await createProviderIssue(ctxFor(db, acme), {
      repositoryId,
      title: "Gate sticks",
      // Five that only GitLab holds and three that only GitHub does, sent together on purpose:
      // this layer does not know which provider it is talking to, and must not start.
      dueDate: "2026-09-30",
      weight: 3,
      confidential: true,
      timeEstimate: "2h",
      links: [{ issueNumber: 12, type: "blocks" }],
      issueType: "Bug",
      parentIssueNumber: 7,
      providerProjectId: "PVT_board",
    });

    expect(lastSeed).toEqual({
      title: "Gate sticks",
      dueDate: "2026-09-30",
      weight: 3,
      confidential: true,
      timeEstimate: "2h",
      links: [{ issueNumber: 12, type: "blocks" }],
      issueType: "Bug",
      parentIssueNumber: 7,
      providerProjectId: "PVT_board",
    });
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

/**
 * The other shape of the same act (F23a Part 3): the parent planning item a provider without epics
 * originates in a repository.
 *
 * The property this describe holds above all others is that it is gated on the *declared
 * container* and not on `epics` — a provider declaring `epics: false` succeeds here, which is
 * precisely the case the whole feature was asked for.
 */
describe("createParentPlanningItem", () => {
  it("answers with the provider's values, never the ones that were sent (F23 NFR-7)", async () => {
    const { repositoryId } = await seedLinkedRepository(acme, REPO_PARENT);

    const result = await createParentPlanningItem(ctxFor(db, acme), {
      repositoryId,
      title: "Cold-weather reliability",
      description: "Typed body",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // All three differ from the input — an echo would answer "Cold-weather reliability" bare.
    expect(result.data.title).toBe("Cold-weather reliability, as the provider stored it");
    expect(result.data.externalNumber).toBe(77);
    expect(result.data.externalUrl).toBe("https://provider.test/acme/gate/issues/77");
  });

  it("succeeds on a provider that declares epics: false — the gate is the container", async () => {
    // The failure this catches is reusing `epicDriver` (or any `epics` check) on this path, which
    // would lock out exactly the provider the feature exists for.
    const { repositoryId } = await seedLinkedRepository(acme, REPO_PARENT);

    const result = await createParentPlanningItem(ctxFor(db, acme), {
      repositoryId,
      title: "Cold-weather reliability",
    });

    expect(result.ok).toBe(true);
    expect(createParentCalls).toBe(1);
  });

  it("passes absent fields through as absent, so the provider keeps its own defaults", async () => {
    const { repositoryId } = await seedLinkedRepository(acme, REPO_PARENT);

    await createParentPlanningItem(ctxFor(db, acme), {
      repositoryId,
      title: "Cold-weather reliability",
      labels: [],
    });

    expect(lastParentSeed).toEqual({ title: "Cold-weather reliability", labels: [] });
  });

  it("mirrors the created parent as a real Issue row, and attaches it to the Project", async () => {
    // The judgement call this feature made, asserted: unlike a group epic, this item *is* an issue
    // in a repository this Workspace mirrors, so it gets a row now rather than on the next poll —
    // which is what stops the operator creating it a second time in the meantime.
    const { integrationId, repositoryId } = await seedLinkedRepository(acme, REPO_PARENT);
    const projectId = await seedProject(acme);

    const result = await createParentPlanningItem(ctxFor(db, acme), {
      repositoryId,
      projectId,
      title: "Cold-weather reliability",
    });

    expect(result.ok).toBe(true);
    const rows = await db.select().from(issue).where(eq(issue.workspaceId, acme));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.ok ? result.data.issueId : "",
      title: "Cold-weather reliability, as the provider stored it",
      source: REPO_PARENT,
      integrationId,
      repositoryId,
      externalId: "ext-7007",
      externalNumber: 77,
      externalState: "open",
    });

    const items = await db.select().from(projectItem).where(eq(projectItem.projectId, projectId));
    expect(items).toHaveLength(1);
    expect(items[0]?.issueId).toBe(result.ok ? result.data.issueId : "");
  });

  it("refuses a group-container provider with a typed error, without reaching the driver", async () => {
    // GitLab's driver throws a sentence here on purpose; propagating it would reach the client as
    // an opaque 500 where the honest answer is "this connection creates its parent elsewhere".
    const { repositoryId } = await seedLinkedRepository(acme, EPICS);

    const result = await createParentPlanningItem(ctxFor(db, acme), {
      repositoryId,
      title: "Cold-weather reliability",
    });

    expect(result).toEqual({ ok: false, error: "INTEGRATION_CAPABILITY_UNAVAILABLE" });
    expect(createParentCalls).toBe(0);
  });

  it("refuses a provider that declares issueCreates but no parent planning item", async () => {
    // Absent is "nobody has said", which must never read as permission.
    const { repositoryId } = await seedLinkedRepository(acme, NO_EPICS);

    const result = await createParentPlanningItem(ctxFor(db, acme), {
      repositoryId,
      title: "Cold-weather reliability",
    });

    expect(result).toEqual({ ok: false, error: "INTEGRATION_CAPABILITY_UNAVAILABLE" });
  });

  it("refuses a Repository from another Workspace before the provider is touched", async () => {
    const other = (await seedWorkspaceGraph(db, "other")).workspaceId;
    const foreign = await seedLinkedRepository(other, REPO_PARENT);

    const result = await createParentPlanningItem(ctxFor(db, acme), {
      repositoryId: foreign.repositoryId,
      title: "Cold-weather reliability",
    });

    expect(result).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(createParentCalls).toBe(0);
  });

  it("refuses a foreign Project id before the provider is touched (Principle V)", async () => {
    const { repositoryId } = await seedLinkedRepository(acme, REPO_PARENT);
    const other = (await seedWorkspaceGraph(db, "other")).workspaceId;
    const foreignProject = await seedProject(other, "Theirs");

    const result = await createParentPlanningItem(ctxFor(db, acme), {
      repositoryId,
      projectId: foreignProject,
      title: "Cold-weather reliability",
    });

    expect(result).toEqual({ ok: false, error: "NOT_FOUND" });
    // A refused create must not have left a real issue on somebody's provider first.
    expect(createParentCalls).toBe(0);
    expect(await db.select().from(issue).where(eq(issue.workspaceId, acme))).toHaveLength(0);
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
 * The type picker behind the compose form's Type control (user request 2026-08-31).
 *
 * The property worth holding is the *gate*, not the pass-through: a provider that does not
 * declare `issueCreates.issueTypes` must never be asked, because a real driver in that position
 * throws a sentence rather than answering with an empty list (`GitlabProvider.listIssueTypes`),
 * and propagating that throw would turn a fact the form already knows into a 500.
 */
describe("listRepositoryIssueTypes", () => {
  it("passes the provider's vocabulary through, as the provider named it", async () => {
    const { repositoryId } = await seedLinkedRepository(acme, EPICS);

    const result = await listRepositoryIssueTypes(ctxFor(db, acme), repositoryId);

    expect(result).toEqual({ ok: true, data: STORED_TYPES });
  });

  it("never asks a provider whose manifest declares no issue types", async () => {
    const { repositoryId } = await seedLinkedRepository(acme, NO_EPICS);

    const result = await listRepositoryIssueTypes(ctxFor(db, acme), repositoryId);

    // Empty, and — the part that matters — empty *without* reaching the driver, whose
    // `listIssueTypes` throws. An implementation that called it first and caught the throw would
    // pass the assertion above and still be wrong.
    expect(result).toEqual({ ok: true, data: [] });
    expect(listIssueTypesCalls).toBe(0);
  });

  it("distinguishes a provider with no vocabulary from a repository with no types", async () => {
    // Both answer `[]`, and only one of them asked. The distinction is invisible in the result by
    // design — the picker draws nothing either way — so it is asserted on the call count instead.
    const declaring = await seedLinkedRepository(acme, EPICS);
    await listRepositoryIssueTypes(ctxFor(db, acme), declaring.repositoryId);
    expect(listIssueTypesCalls).toBe(1);
  });

  it("returns NOT_LINKED for a local-path Repository — there is no provider to ask", async () => {
    const result = await listRepositoryIssueTypes(ctxFor(db, acme), localRepositoryId);

    expect(result).toEqual({ ok: false, error: "INTEGRATION_NOT_LINKED" });
  });

  it("returns NOT_FOUND for a Repository from another Workspace (Principle V)", async () => {
    const { repositoryId } = await seedLinkedRepository(acme, EPICS);
    const intruder = await seedWorkspaceGraph(db, "intruder");

    const result = await listRepositoryIssueTypes(ctxFor(db, intruder.workspaceId), repositoryId);

    expect(result).toEqual({ ok: false, error: "NOT_FOUND" });
    // Refused before the provider was touched, not after it answered.
    expect(listIssueTypesCalls).toBe(0);
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
      // Two kill switches, because this describe now spans two of them: the create flow is behind
      // `ff-core-program` and the repository pickers behind `ff-integrations` (issue #15's
      // separate switch). A caller enabling only the first would fail the type-picker call on a
      // FORBIDDEN that says nothing about the wiring under test.
      flagOverrides: { "ff-core-program": true, "ff-integrations": true },
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

  it("repository.listIssueTypes, on a provider that has them and one that does not", async () => {
    const declaring = await seedLinkedRepository(acme, EPICS);
    const silent = await seedLinkedRepository(acme, NO_EPICS);
    const api = caller(acme);

    expect(await api.repository.listIssueTypes({ repositoryId: declaring.repositoryId })).toEqual(
      STORED_TYPES,
    );
    // Not a thrown 500 for the provider that declares none — an empty list is the honest answer,
    // and it is what makes the client's picker hide itself rather than render an error.
    expect(await api.repository.listIssueTypes({ repositoryId: silent.repositoryId })).toEqual([]);
  });

  it("issue.createParentOnProvider answers with what the provider stored", async () => {
    const { repositoryId } = await seedLinkedRepository(acme, REPO_PARENT);
    const projectId = await seedProject(acme);
    const api = caller(acme);

    const created = await api.issue.createParentOnProvider({
      repositoryId,
      projectId,
      title: "Cold-weather reliability",
      labels: ["ops"],
    });

    expect(created.externalNumber).toBe(77);
    expect(created.title).toBe("Cold-weather reliability, as the provider stored it");
  });

  it("rejects a group-container connection on that procedure with a stated reason", async () => {
    // Not the driver's throw escaping as a 500 — the typed refusal the gate produced.
    const { repositoryId } = await seedLinkedRepository(acme, EPICS);
    const api = caller(acme);

    await expect(
      api.issue.createParentOnProvider({ repositoryId, title: "Cold-weather reliability" }),
    ).rejects.toMatchObject({ message: "INTEGRATION_CAPABILITY_UNAVAILABLE" });
  });

  it("surfaces a provider without epics as a stated refusal rather than a 500", async () => {
    const { integrationId } = await seedLinkedRepository(acme, NO_EPICS);
    const api = caller(acme);

    await expect(
      api.project.createEpic({ integrationId, groupRef: "acme", title: "Q3" }),
    ).rejects.toMatchObject({ message: "INTEGRATION_CAPABILITY_UNAVAILABLE" });
  });
});
