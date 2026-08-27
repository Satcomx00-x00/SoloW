/// <reference types="bun-types" />

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  encryptSecret,
  integration,
  issue,
  project,
  projectItem,
  projectRepository,
  repository,
  secret,
  workspace,
} from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import type { ExternalIssue, ListIssuesOptions } from "@solow/scm";
import { testing } from "@solow/scm";
import { eq } from "drizzle-orm";
import { isBackoffWorthy, linkedRepositories, syncRepositoryIssues } from "./issues.js";

/**
 * Automatic ingestion (issue #125).
 *
 * The assertions that matter are about what a *failed* pass must not do: advance a watermark past
 * issues it never read, and delete rows that Tasks and review records point at. Getting the happy
 * path right is a loop; getting those two wrong loses work.
 */

const WS = "11111111-1111-4111-8111-111111111111";
const FIXTURE = "fixture.tracker";
let db: TestDb;
/** What each listing was asked for, so a test can assert the poll's side of the bargain. */
let listed: ListIssuesOptions[] = [];
let nextIssues: ExternalIssue[] = [];
let nextError: Error | null = null;

beforeAll(() => {
  process.env.SOLOW_SECRET_KEY ??= Buffer.alloc(32, 3).toString("base64");
  testing.register({
    id: FIXTURE,
    name: "Fixture Tracker",
    capabilities: ["issues"],
    fields: [],
    driver: {
      provider: FIXTURE,
      authenticate: async () => ({ ok: true as const }),
      listIssues: async (
        _c: unknown,
        _r: string,
        options?: ListIssuesOptions,
      ): Promise<ExternalIssue[]> => {
        listed.push(options ?? {});
        if (nextError) throw nextError;
        return nextIssues;
      },
      getIssue: async () => ({}) as never,
      listComments: async () => [],
      listLabels: async () => [],
    },
  });
});
afterAll(() => testing.unregister(FIXTURE));

async function seed(): Promise<{ repositoryId: string }> {
  await db.insert(workspace).values({ id: WS, name: "acme", ownerUserId: "u1" });
  const [token] = await db
    .insert(secret)
    .values({
      workspaceId: WS,
      name: "pat",
      kind: "scm_pat",
      ciphertext: encryptSecret("glpat-fixture"),
    })
    .returning();
  const [connected] = await db
    .insert(integration)
    .values({ workspaceId: WS, provider: FIXTURE, secretId: token?.id ?? "" })
    .returning();
  const [repo] = await db
    .insert(repository)
    .values({
      workspaceId: WS,
      name: "gate",
      source: "remote_url",
      location: "https://example.test/acme/gate.git",
      integrationId: connected?.id ?? null,
      externalFullName: "acme/gate",
    })
    .returning();
  return { repositoryId: repo?.id ?? "" };
}

/** A local Project (no integration, no provider project id) with `repositoryId` registered under it. */
async function seedLocalProject(repositoryId: string): Promise<{ projectId: string }> {
  const [proj] = await db
    .insert(project)
    .values({ workspaceId: WS, title: "Local board" })
    .returning();
  const projectId = proj?.id ?? "";
  await db.insert(projectRepository).values({ workspaceId: WS, projectId, repositoryId });
  return { projectId };
}

const external = (over: Record<string, unknown> = {}) => ({
  externalId: "gh-1",
  number: 1,
  title: "Cap the upload size",
  description: "bodies over 2MB are rejected",
  state: "open" as const,
  url: "https://example.test/1",
  ...over,
});

beforeEach(() => {
  db = createTestDb();
  listed = [];
  nextIssues = [];
  nextError = null;
});

describe("syncRepositoryIssues", () => {
  it("imports an issue nobody asked for, which is the whole point", async () => {
    const { repositoryId } = await seed();
    nextIssues = [external()];
    const [row] = await linkedRepositories(db);

    const result = await syncRepositoryIssues(db, row as never);

    expect(result.imported).toBe(1);
    const [stored] = await db.select().from(issue).where(eq(issue.repositoryId, repositoryId));
    expect(stored?.title).toBe("Cap the upload size");
    expect(stored?.source).toBe(FIXTURE);
  });

  it("updates on a second pass rather than duplicating", async () => {
    // #125 AC-3. GitLab's `iid` restarts at 1 per project, so the key is the pair.
    const { repositoryId } = await seed();
    nextIssues = [external()];
    let [row] = await linkedRepositories(db);
    await syncRepositoryIssues(db, row as never);

    nextIssues = [external({ title: "Cap the upload size (revised)" })];
    [row] = await linkedRepositories(db);
    const second = await syncRepositoryIssues(db, row as never);

    expect(second.imported).toBe(0);
    expect(second.updated).toBe(1);
    const rows = await db.select().from(issue).where(eq(issue.repositoryId, repositoryId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Cap the upload size (revised)");
  });

  /**
   * Assignees, milestone and the provider's own "updated at" (spec F23 FR-8, user request
   * 2026-08-28) — this data was already fetched by the driver on every pass and thrown away, on
   * both providers, because nothing here wrote it anywhere. Fixed alongside the SCM drivers that
   * now populate `ExternalIssue.assignees`/`.milestone` on `listIssues`, not only on a
   * single-issue read.
   */
  describe("assignees, milestone and the provider's own updated-at", () => {
    it("persists assignees and milestone on import, and updates them on a later pass", async () => {
      const { repositoryId } = await seed();
      nextIssues = [
        external({
          assignees: [{ login: "ada", name: "Ada", avatarUrl: null }],
          milestone: { externalId: "5", title: "v1", startDate: null, dueDate: "2026-09-01" },
        }),
      ];
      let [row] = await linkedRepositories(db);
      await syncRepositoryIssues(db, row as never);

      let [stored] = await db.select().from(issue).where(eq(issue.repositoryId, repositoryId));
      expect(stored?.assignees).toEqual([{ login: "ada", name: "Ada", avatarUrl: null }]);
      expect(stored?.milestone).toEqual({
        externalId: "5",
        title: "v1",
        startDate: null,
        dueDate: "2026-09-01",
      });

      nextIssues = [
        external({
          assignees: [{ login: "grace", name: "Grace", avatarUrl: null }],
          milestone: null,
        }),
      ];
      [row] = await linkedRepositories(db);
      await syncRepositoryIssues(db, row as never);

      [stored] = await db.select().from(issue).where(eq(issue.repositoryId, repositoryId));
      expect(stored?.assignees).toEqual([{ login: "grace", name: "Grace", avatarUrl: null }]);
      // Reassigned to nobody, and the milestone cleared — both are the provider's answer this
      // pass, not "the driver did not say" (see the `undefined` vs. explicit-`null` guard).
      expect(stored?.milestone).toBeNull();
    });

    it("leaves assignees and milestone alone when the driver did not report them this pass", async () => {
      const { repositoryId } = await seed();
      nextIssues = [
        external({
          assignees: [{ login: "ada", name: "Ada", avatarUrl: null }],
          milestone: { externalId: "5", title: "v1", startDate: null, dueDate: "2026-09-01" },
        }),
      ];
      let [row] = await linkedRepositories(db);
      await syncRepositoryIssues(db, row as never);

      // A driver that could not read them omits the keys entirely (`undefined`, not `[]`/`null`).
      nextIssues = [external({ title: "Cap the upload size (revised)" })];
      [row] = await linkedRepositories(db);
      await syncRepositoryIssues(db, row as never);

      const [stored] = await db.select().from(issue).where(eq(issue.repositoryId, repositoryId));
      expect(stored?.assignees).toEqual([{ login: "ada", name: "Ada", avatarUrl: null }]);
      expect(stored?.milestone).toEqual({
        externalId: "5",
        title: "v1",
        startDate: null,
        dueDate: "2026-09-01",
      });
    });

    it("stores the provider's own updatedAt when it reports one, not just the poll's clock", async () => {
      const { repositoryId } = await seed();
      nextIssues = [external({ updatedAt: "2026-05-01T00:00:00.000Z" })];
      const [row] = await linkedRepositories(db);

      await syncRepositoryIssues(db, row as never);

      const [stored] = await db.select().from(issue).where(eq(issue.repositoryId, repositoryId));
      expect(stored?.updatedAt).toBe("2026-05-01T00:00:00.000Z");
    });
  });

  describe("local Project membership (#125 / F23)", () => {
    it("attaches a newly-synced issue to every local Project its repository feeds", async () => {
      const { repositoryId } = await seed();
      const { projectId } = await seedLocalProject(repositoryId);
      nextIssues = [external()];
      const [row] = await linkedRepositories(db);

      await syncRepositoryIssues(db, row as never);

      const [storedIssue] = await db
        .select()
        .from(issue)
        .where(eq(issue.repositoryId, repositoryId));
      const items = await db.select().from(projectItem).where(eq(projectItem.projectId, projectId));
      expect(items).toHaveLength(1);
      expect(items[0]?.issueId).toBe(storedIssue?.id ?? "");
    });

    it("does not attach or duplicate anything for an issue that only updated", async () => {
      // The update branch must stay untouched in effect, not just in code: an issue that already
      // existed already got its project_item rows (or was never eligible) when it was first
      // inserted, so a second pass over the same issue must not add another.
      const { repositoryId } = await seed();
      const { projectId } = await seedLocalProject(repositoryId);
      nextIssues = [external()];
      let [row] = await linkedRepositories(db);
      await syncRepositoryIssues(db, row as never);

      nextIssues = [external({ title: "Cap the upload size (revised)" })];
      [row] = await linkedRepositories(db);
      const second = await syncRepositoryIssues(db, row as never);

      expect(second.updated).toBe(1);
      const items = await db.select().from(projectItem).where(eq(projectItem.projectId, projectId));
      expect(items).toHaveLength(1);
    });
  });

  describe("linked change requests (issue #128)", () => {
    const link = (over: Record<string, unknown> = {}) => ({
      externalId: "pr-9",
      number: 9,
      title: "Cap it",
      state: "open" as const,
      url: "https://example.test/pull/9",
      mergedAt: null,
      ...over,
    });

    it("refreshes link state on the same pass as everything else", async () => {
      // #128 AC-4. Merge is the transition a reader is most likely to be shown stale, so it has
      // to land on the ordinary poll rather than on a schedule of its own.
      const { repositoryId } = await seed();
      nextIssues = [external({ linkedChangeRequests: [link()] })];
      let [row] = await linkedRepositories(db);
      await syncRepositoryIssues(db, row as never);

      nextIssues = [
        external({
          linkedChangeRequests: [link({ state: "merged", mergedAt: "2026-02-01T00:00:00.000Z" })],
        }),
      ];
      [row] = await linkedRepositories(db);
      await syncRepositoryIssues(db, row as never);

      const [stored] = await db.select().from(issue).where(eq(issue.repositoryId, repositoryId));
      expect(stored?.linkedChangeRequests).toEqual([
        {
          externalId: "pr-9",
          number: 9,
          title: "Cap it",
          state: "merged",
          url: "https://example.test/pull/9",
          mergedAt: "2026-02-01T00:00:00.000Z",
        },
      ]);
    });

    it("records an issue with no linked change request as an empty list", async () => {
      const { repositoryId } = await seed();
      nextIssues = [external({ linkedChangeRequests: [] })];
      const [row] = await linkedRepositories(db);

      await syncRepositoryIssues(db, row as never);

      const [stored] = await db.select().from(issue).where(eq(issue.repositoryId, repositoryId));
      expect(stored?.linkedChangeRequests).toEqual([]);
    });

    it("keeps the last known links when a driver could not report them", async () => {
      // The failure this guards: a driver whose side call failed omits the field, and a pass that
      // wrote an empty array anyway would make every row claim nothing is in flight.
      const { repositoryId } = await seed();
      nextIssues = [external({ linkedChangeRequests: [link()] })];
      let [row] = await linkedRepositories(db);
      await syncRepositoryIssues(db, row as never);

      nextIssues = [external()];
      [row] = await linkedRepositories(db);
      await syncRepositoryIssues(db, row as never);

      const [stored] = await db.select().from(issue).where(eq(issue.repositoryId, repositoryId));
      expect(stored?.linkedChangeRequests).toHaveLength(1);
    });

    it("asks for the links, being the one caller that stores them", async () => {
      // They cost a request per issue, so the enrichment is opt-in and every other caller — the
      // connect-time auto-import, the import preview — pays for issues alone.
      await seed();
      nextIssues = [external()];
      const [row] = await linkedRepositories(db);

      await syncRepositoryIssues(db, row as never);

      expect(listed[0]?.linkedChangeRequests).toBe(true);
    });

    it("keeps the links it had when the enrichment was rate limited", async () => {
      // The end of the laundering path (issue #128 review): the driver fails the listing on a
      // 429 rather than answering "no links", so the pass marks the repository stale, leaves the
      // stored links alone, and does not advance the watermark past the issues it could not
      // finish reading.
      const { repositoryId } = await seed();
      nextIssues = [external({ linkedChangeRequests: [link()] })];
      let [row] = await linkedRepositories(db);
      await syncRepositoryIssues(db, row as never);

      nextError = new Error("fixture request failed: 429 too many requests");
      [row] = await linkedRepositories(db);
      const result = await syncRepositoryIssues(db, row as never);

      expect(result.staleReason).toMatch(/rate limiting/i);
      const [stored] = await db.select().from(issue).where(eq(issue.repositoryId, repositoryId));
      expect(stored?.linkedChangeRequests).toHaveLength(1);
    });
  });

  describe("hierarchy and closed state (issue #127)", () => {
    it("records that the provider closed an issue, on the ordinary poll", async () => {
      // An epic's progress is counted from this and from nothing else (AC-3), so a poll that
      // refreshed everything except the state would leave every rollup permanently at 0%.
      const { repositoryId } = await seed();
      nextIssues = [external()];
      let [row] = await linkedRepositories(db);
      await syncRepositoryIssues(db, row as never);

      nextIssues = [external({ state: "closed" })];
      [row] = await linkedRepositories(db);
      await syncRepositoryIssues(db, row as never);

      const [stored] = await db.select().from(issue).where(eq(issue.repositoryId, repositoryId));
      expect(stored?.externalState).toBe("closed");
    });

    it("records the parent the provider reported, and only the provider's", async () => {
      const { repositoryId } = await seed();
      nextIssues = [external({ parentExternalId: "gh-epic" })];
      const [row] = await linkedRepositories(db);

      await syncRepositoryIssues(db, row as never);

      const [stored] = await db.select().from(issue).where(eq(issue.repositoryId, repositoryId));
      expect(stored?.externalParentId).toBe("gh-epic");
    });

    it("keeps a recorded parent when a driver does not report hierarchy at all", async () => {
      // Omitted is "this provider does not answer that", not "this issue has no parent". Blanking
      // the edge here would un-nest a row every time a driver without sub-issues polled it.
      const { repositoryId } = await seed();
      nextIssues = [external({ parentExternalId: "gh-epic" })];
      let [row] = await linkedRepositories(db);
      await syncRepositoryIssues(db, row as never);

      nextIssues = [external({ title: "Renamed" })];
      [row] = await linkedRepositories(db);
      await syncRepositoryIssues(db, row as never);

      const [stored] = await db.select().from(issue).where(eq(issue.repositoryId, repositoryId));
      expect(stored?.externalParentId).toBe("gh-epic");
    });

    it("clears the parent when the provider says there is none", async () => {
      // Someone detached the sub-issue on GitHub. `null` is an answer, and the mirror follows it.
      const { repositoryId } = await seed();
      nextIssues = [external({ parentExternalId: "gh-epic" })];
      let [row] = await linkedRepositories(db);
      await syncRepositoryIssues(db, row as never);

      nextIssues = [external({ parentExternalId: null })];
      [row] = await linkedRepositories(db);
      await syncRepositoryIssues(db, row as never);

      const [stored] = await db.select().from(issue).where(eq(issue.repositoryId, repositoryId));
      expect(stored?.externalParentId).toBeNull();
    });
  });

  it("asks the provider only for what changed, once it has a watermark", async () => {
    // #125 AC-2. Re-reading a repository's whole history every five minutes is what exhausts a
    // rate limit.
    await seed();
    nextIssues = [external()];
    let [row] = await linkedRepositories(db);
    await syncRepositoryIssues(db, row as never);
    [row] = await linkedRepositories(db);
    await syncRepositoryIssues(db, row as never);

    expect(listed[0]?.since).toBeUndefined();
    expect(listed[1]?.since).toBeTruthy();
  });

  describe("when the provider rate limits", () => {
    it("says the data is stale instead of pretending it is current", async () => {
      await seed();
      nextError = new Error("fixture request failed: 429 too many requests");
      const [row] = await linkedRepositories(db);

      const result = await syncRepositoryIssues(db, row as never);

      expect(result.staleReason).toMatch(/rate limiting/i);
      const [repo] = await db.select().from(repository);
      expect(repo?.syncStaleSince).toBeTruthy();
      expect(repo?.syncStaleReason).toMatch(/rate limiting/i);
    });

    it("leaves the watermark where it was, so nothing is skipped for ever", async () => {
      // The failure that would be invisible: advancing past issues the pass never read means
      // they are never asked for again.
      await seed();
      nextIssues = [external()];
      let [row] = await linkedRepositories(db);
      await syncRepositoryIssues(db, row as never);
      const [afterGood] = await db.select().from(repository);

      nextError = new Error("fixture request failed: 429");
      [row] = await linkedRepositories(db);
      await syncRepositoryIssues(db, row as never);

      const [afterBad] = await db.select().from(repository);
      expect(afterBad?.issuesSyncedAt).toBe(afterGood?.issuesSyncedAt ?? "");
    });

    it("clears the staleness on the next pass that works", async () => {
      await seed();
      nextError = new Error("429 rate limit");
      let [row] = await linkedRepositories(db);
      await syncRepositoryIssues(db, row as never);

      nextError = null;
      nextIssues = [external()];
      [row] = await linkedRepositories(db);
      await syncRepositoryIssues(db, row as never);

      const [repo] = await db.select().from(repository);
      expect(repo?.syncStaleSince).toBeNull();
      expect(repo?.syncStaleReason).toBeNull();
    });
  });

  it("does not delete an issue that stopped being reported", async () => {
    // #125 AC-5 / AC-6, and the reason the two read as contradictory until you try it: the Tasks,
    // Sessions and review records that point at an Issue would be orphaned by its removal. An
    // issue absent from a page is not proof of deletion either — it may have been filtered,
    // paged past, or fallen outside the `since` window.
    const { repositoryId } = await seed();
    nextIssues = [external()];
    let [row] = await linkedRepositories(db);
    await syncRepositoryIssues(db, row as never);

    nextIssues = [];
    [row] = await linkedRepositories(db);
    await syncRepositoryIssues(db, row as never);

    expect(await db.select().from(issue).where(eq(issue.repositoryId, repositoryId))).toHaveLength(
      1,
    );
  });

  it("ignores a repository with no integration behind it", async () => {
    db = createTestDb();
    await db.insert(workspace).values({ id: WS, name: "acme", ownerUserId: "u1" });
    await db.insert(repository).values({
      workspaceId: WS,
      name: "local",
      source: "local_path",
      location: "/srv/repos/local",
    });

    expect(await linkedRepositories(db)).toHaveLength(0);
  });
});

describe("isBackoffWorthy", () => {
  it("recognises the provider saying slow down", () => {
    expect(isBackoffWorthy(new Error("github request failed: 429 "))).toBe(true);
    expect(isBackoffWorthy(new Error("API rate limit exceeded"))).toBe(true);
    expect(isBackoffWorthy(new Error("You have exceeded a secondary rate limit"))).toBe(true);
  });

  it("does not mistake an ordinary failure for one", () => {
    // A misconfigured repository that stopped syncing silently would be worse than one that
    // reports a failure every five minutes.
    expect(isBackoffWorthy(new Error("404 Not Found"))).toBe(false);
    expect(isBackoffWorthy(new Error("401 Unauthorized"))).toBe(false);
  });
});
