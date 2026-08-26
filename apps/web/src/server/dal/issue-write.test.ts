/// <reference types="bun-types" />

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { encryptSecret, integration, issue, repository, secret } from "@gatecontrol/db";
import { createTestDb, type TestDb } from "@gatecontrol/db/testing";
import type { IssuePatch } from "@gatecontrol/scm";
import { testing } from "@gatecontrol/scm";
import { eq } from "drizzle-orm";
import { readIssueDetail, updateExternalIssue } from "./issue-write.js";
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

beforeAll(() => {
  process.env.GATECONTROL_SECRET_KEY ??= Buffer.alloc(32, 5).toString("base64");
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
    issueWrites: {
      writes: ["title", "description", "state", "assignees", "labels", "milestone"],
      cannot: {},
    },
    driver: {
      provider: FIXTURE,
      authenticate: async () => ({ ok: true as const }),
      listIssues: async () => [],
      getIssue: async () => readIssue,
      listLabels: async () => [{ name: "hardware", color: "aabbcc", description: null }],
      listAssignableUsers: async () => [{ login: "ada", name: "Ada", avatarUrl: null }],
      listMilestones: async () => [
        { externalId: "7", title: "v1", startDate: null, dueDate: null },
      ],
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
    .values({ workspaceId: acme, name: "pat", kind: "scm_pat", ciphertext: encryptSecret("t") })
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
