/// <reference types="bun-types" />

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { encryptSecret, integration, issue, repository, secret } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import type { IssuePatch } from "@solow/scm";
import { testing } from "@solow/scm";
import { eq } from "drizzle-orm";
import {
  createIssueComment,
  listIssueComments,
  readIssueDetail,
  updateExternalIssue,
} from "./issue-write.js";
import { ctxFor, seedWorkspaceGraph } from "./test-fixtures.js";

/**
 * Editing an imported Issue on its provider (spec F23 FR-13, Decision 0019).
 *
 * The property every test here is about: **the mirror is written from the provider's answer,
 * never from the request.** A provider may normalise a title, refuse an assignee or drop a label,
 * and a mirror updated from what was sent would hold a value nobody ever stored — worse than
 * stale, because it looks current.
 */

const FIXTURE = "fixture.writable";
const READONLY = "fixture.readonly";
let db: TestDb;
let acme: string;
/** Every patch the driver was handed, so absence can be asserted and not merely assumed. */
let received: IssuePatch[] = [];
/** The comment thread the fixture provider currently holds. */
let thread: Array<{
  externalId: string;
  author: { login: string; name: string | null; avatarUrl: string | null } | null;
  body: string;
  createdAt: string;
  updatedAt: string | null;
  url: string;
}> = [];

beforeAll(() => {
  process.env.SOLOW_SECRET_KEY ??= Buffer.alloc(32, 5).toString("base64");
  const readIssue = {
    externalId: "9001",
    number: 42,
    title: "Latch sticks",
    description: "in the rain",
    state: "open" as const,
    url: "https://example.test/i/42",
    assignees: [{ login: "ada", name: "Ada", avatarUrl: null }],
    labels: ["hardware"],
    milestone: null,
  };

  testing.register({
    id: FIXTURE,
    name: "Writable",
    capabilities: ["issues", "issueWrites"],
    fields: [],
    // The GitHub shape: writes the six every provider has, explains the four only GitLab holds.
    // Exhaustive on purpose — a field in neither list is the silent gap F23 FR-5 forbids, and
    // `registry.test.ts` now asserts no shipped manifest has one.
    issueWrites: {
      writes: ["title", "description", "state", "assignees", "labels", "milestone"],
      cannot: {
        dueDate: "Fixture issues have no due date.",
        weight: "Fixture issues have no weight.",
        confidential: "Fixture issues have no confidential flag.",
        timeEstimate: "Fixture issues carry no time estimate.",
      },
    },
    driver: {
      provider: FIXTURE,
      authenticate: async () => ({ ok: true as const }),
      listIssues: async () => [],
      getIssue: async () => readIssue,
      listComments: async () => thread,
      listLabels: async () => [{ name: "hardware", color: "aabbcc", description: null }],
      listAssignableUsers: async () => [{ login: "ada", name: "Ada", avatarUrl: null }],
      listMilestones: async () => [
        { externalId: "7", title: "v1", startDate: null, dueDate: null },
      ],
      createComment: async (_c: unknown, _r: string, _n: number, body: string) => {
        const posted = {
          externalId: `c${thread.length + 1}`,
          author: { login: "ada", name: "Ada", avatarUrl: null },
          // Normalised on purpose: the DAL must answer with what the provider stored.
          body: `${body} (normalised)`,
          createdAt: "2026-08-26T00:00:00.000Z",
          updatedAt: null,
          url: "u/c",
        };
        thread = [...thread, posted];
        return posted;
      },
      updateIssue: async (_c: unknown, _r: string, _n: number, patch: IssuePatch) => {
        received.push(patch);
        return {
          ...readIssue,
          // What the provider *stored*: deliberately not what was sent.
          title: patch.title === undefined ? readIssue.title : `${patch.title} (normalised)`,
          state: patch.state ?? readIssue.state,
          labels: patch.labels ?? readIssue.labels,
        };
      },
    },
  });

  testing.register({
    id: READONLY,
    name: "Read-only tracker",
    capabilities: ["issues"],
    fields: [],
    driver: {
      provider: READONLY,
      authenticate: async () => ({ ok: true as const }),
      listIssues: async () => [],
      getIssue: async () => readIssue,
      listComments: async () => [],
      listLabels: async () => [],
    },
  });
});
afterAll(() => {
  testing.unregister(FIXTURE);
  testing.unregister(READONLY);
});

async function seed(provider: string): Promise<string> {
  const [token] = await db
    .insert(secret)
    // Named per provider: a Workspace's secret names are unique, so a test seeding two
    // integrations would otherwise collide on the index rather than on anything it meant to test.
    .values({
      workspaceId: acme,
      name: `pat-${provider}`,
      kind: "scm_pat",
      ciphertext: encryptSecret("t"),
    })
    .returning();
  const [connected] = await db
    .insert(integration)
    .values({ workspaceId: acme, provider, secretId: token?.id ?? "" })
    .returning();
  const [repo] = await db
    .insert(repository)
    .values({
      workspaceId: acme,
      name: "gate",
      source: "remote_url",
      location: "https://example.test/acme/gate.git",
      integrationId: connected?.id ?? null,
      externalFullName: "acme/gate",
    })
    .returning();
  const [row] = await db
    .insert(issue)
    .values({
      workspaceId: acme,
      title: "Stale title",
      description: "stale",
      source: provider,
      integrationId: connected?.id ?? null,
      repositoryId: repo?.id ?? null,
      externalId: "9001",
      externalNumber: 42,
      externalUrl: "https://example.test/i/42",
      externalState: "open",
      labels: [],
    })
    .returning();
  return row?.id ?? "";
}

beforeEach(async () => {
  db = createTestDb();
  acme = (await seedWorkspaceGraph(db, "acme")).workspaceId;
  received = [];
  thread = [];
});

describe("readIssueDetail", () => {
  it("reads the provider, not the mirror, so the form does not open on a stale title", async () => {
    // A form built from the last poll opens on a value someone else changed an hour ago and
    // saves over it with neither party seeing a conflict.
    const issueId = await seed(FIXTURE);

    const detail = await readIssueDetail(ctxFor(db, acme), { issueId });

    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.data.title).toBe("Latch sticks");
    expect(detail.data.assignees.map((u) => u.login)).toEqual(["ada"]);
    expect(detail.data.availableMilestones.map((m) => m.title)).toEqual(["v1"]);
  });

  it("refreshes the mirror from what it read, so the table behind agrees", async () => {
    const issueId = await seed(FIXTURE);

    await readIssueDetail(ctxFor(db, acme), { issueId });

    const [row] = await db.select().from(issue).where(eq(issue.id, issueId));
    expect(row?.title).toBe("Latch sticks");
    expect(row?.labels).toEqual(["hardware"]);
  });

  it("says which fields a provider will not accept, rather than offering a control that fails", async () => {
    // Decision 0016: ask for a capability, never for a provider. A tracker that does not declare
    // `issueWrites` answers "nothing, and here is a sentence for each field".
    const issueId = await seed(READONLY);

    const detail = await readIssueDetail(ctxFor(db, acme), { issueId });

    expect(detail.ok && detail.data.writes).toEqual([]);
    expect(detail.ok && detail.data.cannot.title).toContain("does not support editing");
  });
});

describe("updateExternalIssue", () => {
  it("stores the provider's answer, never the value that was sent", async () => {
    // F23 NFR-7 and the whole point of this path.
    const issueId = await seed(FIXTURE);

    const updated = await updateExternalIssue(ctxFor(db, acme), { issueId, title: "Renamed" });

    expect(updated.ok && updated.data.title).toBe("Latch sticks");
    const [row] = await db.select().from(issue).where(eq(issue.id, issueId));
    // The mirror holds what the provider answered on the *read-back*, not the typed string.
    expect(row?.title).toBe("Latch sticks");
    expect(row?.title).not.toBe("Renamed");
  });

  it("sends only the keys the caller named, so an editor cannot revert what it never drew", async () => {
    const issueId = await seed(FIXTURE);

    await updateExternalIssue(ctxFor(db, acme), { issueId, state: "closed" });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ state: "closed" });
  });

  it("distinguishes clearing a milestone from leaving it alone", async () => {
    const issueId = await seed(FIXTURE);

    await updateExternalIssue(ctxFor(db, acme), { issueId, milestone: null });

    expect(received[0]).toEqual({ milestone: null });
  });

  it("does not touch the provider when the patch is empty", async () => {
    // A no-op request still costs a round trip and bumps `updated_at` on some providers, which
    // would make an opened-and-closed panel look like an edit in every audit trail.
    const issueId = await seed(FIXTURE);

    const result = await updateExternalIssue(ctxFor(db, acme), { issueId });

    expect(result.ok).toBe(true);
    expect(received).toHaveLength(0);
  });

  it("refuses a field the provider declared it cannot hold, before the network", async () => {
    const issueId = await seed(READONLY);

    const result = await updateExternalIssue(ctxFor(db, acme), { issueId, title: "Renamed" });

    expect(result.ok).toBe(false);
    expect(received).toHaveLength(0);
  });

  it("refuses one unwritable field even when the provider writes every other one", async () => {
    // The case the READONLY test above cannot reach: a provider that genuinely writes most of an
    // issue and holds none of GitLab's four. The guard is per *field*, not per provider, so the
    // network must not be touched at all — a partial write that dropped the offending key would
    // report success for a change nobody made.
    const issueId = await seed(FIXTURE);
    received = [];

    const result = await updateExternalIssue(ctxFor(db, acme), { issueId, dueDate: "2026-09-30" });

    expect(result.ok).toBe(false);
    expect(received).toHaveLength(0);
  });

  it("refuses the whole patch when one field is unwritable, never just the writable half", async () => {
    const issueId = await seed(FIXTURE);
    received = [];

    // Title alone would be accepted; paired with a field the provider cannot hold it must not be
    // half-applied, or the editor shows a saved title beside a due date that never landed.
    const result = await updateExternalIssue(ctxFor(db, acme), {
      issueId,
      title: "Renamed",
      weight: 3,
    });

    expect(result.ok).toBe(false);
    expect(received).toHaveLength(0);
  });

  it("refuses an Issue that has no provider behind it", async () => {
    // A locally-created Issue has nothing to write to. Not an error the operator can fix, so the
    // editor should not have offered the controls — this is the second line.
    const [local] = await db
      .insert(issue)
      .values({ workspaceId: acme, title: "Local only", source: "local" })
      .returning();

    const result = await updateExternalIssue(ctxFor(db, acme), {
      issueId: local?.id ?? "",
      title: "Renamed",
    });

    expect(result.ok).toBe(false);
  });

  it("will not reach an Issue in another Workspace", async () => {
    // Principle V. Every read here is scoped, and this is the test that says so out loud.
    const issueId = await seed(FIXTURE);
    const other = (await seedWorkspaceGraph(db, "other")).workspaceId;

    const result = await updateExternalIssue(ctxFor(db, other), { issueId, title: "Renamed" });

    expect(result.ok).toBe(false);
    expect(received).toHaveLength(0);
  });
});

describe("issue comments", () => {
  it("reads the thread live rather than from a mirror", async () => {
    // A comment thread is the one part of an issue that changes without anything here doing it,
    // and a stale copy of a conversation is worse than no copy — it looks like the whole of it.
    thread = [
      {
        externalId: "c1",
        author: { login: "ada", name: "Ada", avatarUrl: null },
        body: "First",
        createdAt: "2026-08-20T00:00:00.000Z",
        updatedAt: null,
        url: "u/c1",
      },
    ];
    const issueId = await seed(FIXTURE);

    const result = await listIssueComments(ctxFor(db, acme), { issueId });

    expect(result.ok && result.data.comments.map((c) => c.body)).toEqual(["First"]);
  });

  it("offers a composer only where posting can actually work", async () => {
    // A provider that reads and does not write shows the discussion with no box, rather than a
    // box that fails on submit.
    const writable = await seed(FIXTURE);
    const readOnly = await seed(READONLY);

    expect((await listIssueComments(ctxFor(db, acme), { issueId: writable })).ok).toBe(true);
    const a = await listIssueComments(ctxFor(db, acme), { issueId: writable });
    const b = await listIssueComments(ctxFor(db, acme), { issueId: readOnly });

    expect(a.ok && a.data.canComment).toBe(true);
    expect(b.ok && b.data.canComment).toBe(false);
  });

  it("answers a post with the whole thread, not with the text that was sent", async () => {
    /*
     * Two reasons and the second decides it: a provider may normalise what was posted, and
     * somebody else may have commented while this one was being written. Only the whole thread
     * is a response that cannot be missing a message.
     */
    const issueId = await seed(FIXTURE);

    const result = await createIssueComment(ctxFor(db, acme), { issueId, body: "Looks right" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.comments.map((c) => c.body)).toEqual(["Looks right (normalised)"]);
  });

  it("refuses to post through a provider that cannot write", async () => {
    const issueId = await seed(READONLY);

    const result = await createIssueComment(ctxFor(db, acme), { issueId, body: "hello" });

    expect(result.ok).toBe(false);
  });

  it("will not read another workspace's discussion", async () => {
    // Principle V, said out loud on the newest read.
    const issueId = await seed(FIXTURE);
    const other = (await seedWorkspaceGraph(db, "other")).workspaceId;

    expect((await listIssueComments(ctxFor(db, other), { issueId })).ok).toBe(false);
  });
});
