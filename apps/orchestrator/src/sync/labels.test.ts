/// <reference types="bun-types" />

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  encryptSecret,
  integration,
  repository,
  repositoryLabel,
  secret,
  workspace,
} from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import type { ExternalLabel } from "@solow/scm";
import { testing } from "@solow/scm";
import { eq } from "drizzle-orm";
import { linkedRepositories } from "./issues.js";
import { labelsAreDue, syncRepositoryLabels } from "./labels.js";

/**
 * The label mirror (see `labels.ts` for why it exists).
 *
 * The assertions that matter are the two that separate a mirror from a cache: a *failed* read
 * must keep what is already stored rather than blank a table full of chips, and a successful one
 * must drop labels the provider no longer has — the opposite rule to the issue sync's, and the
 * reason these are two files.
 */

const WS = "11111111-1111-4111-8111-111111111111";
const FIXTURE = "fixture.labels";
let db: TestDb;
/** How many times the driver was actually asked — the whole point is that it is rarely. */
let calls = 0;
let nextLabels: ExternalLabel[] = [];
let nextError: Error | null = null;

const label = (name: string, color: string | null = "#ff0000"): ExternalLabel => ({
  name,
  color,
  description: null,
});

beforeAll(() => {
  process.env.SOLOW_SECRET_KEY ??= Buffer.alloc(32, 5).toString("base64");
  testing.register({
    id: FIXTURE,
    name: "Fixture Labels",
    capabilities: ["issues"],
    fields: [],
    driver: {
      provider: FIXTURE,
      authenticate: async () => ({ ok: true as const }),
      listIssues: async () => [],
      getIssue: async () => ({}) as never,
      listComments: async () => [],
      listLabels: async (): Promise<ExternalLabel[]> => {
        calls += 1;
        if (nextError) throw nextError;
        return nextLabels;
      },
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

const stored = (repositoryId: string) =>
  db
    .select({ name: repositoryLabel.name, color: repositoryLabel.color })
    .from(repositoryLabel)
    .where(eq(repositoryLabel.repositoryId, repositoryId));

beforeEach(() => {
  db = createTestDb();
  calls = 0;
  nextLabels = [];
  nextError = null;
});

describe("labelsAreDue", () => {
  const now = new Date("2026-09-01T12:00:00.000Z");

  it("is due when nothing was ever mirrored", () => {
    expect(labelsAreDue(null, now)).toBe(true);
  });

  it("is not due inside the refresh window", () => {
    expect(labelsAreDue("2026-09-01T11:00:00.000Z", now)).toBe(false);
  });

  it("is due once the window has passed", () => {
    expect(labelsAreDue("2026-09-01T05:00:00.000Z", now)).toBe(true);
  });

  it("treats a watermark it cannot read as never mirrored, not as fresh", () => {
    // The opposite reading would strand the mirror for ever on one bad row.
    expect(labelsAreDue("not a date", now)).toBe(true);
  });
});

describe("syncRepositoryLabels", () => {
  it("mirrors the vocabulary and stamps the watermark", async () => {
    const { repositoryId } = await seed();
    nextLabels = [label("bug", "#d73a4a"), label("chore", null)];
    const [row] = await linkedRepositories(db);

    const result = await syncRepositoryLabels(db, row as never);

    expect(result.labels).toBe(2);
    expect(result.skipped).toBe(false);
    expect(result.changed).toBe(true);
    expect(await stored(repositoryId)).toEqual([
      { name: "bug", color: "#d73a4a" },
      // A provider that reports no colour is a fact, stored as one.
      { name: "chore", color: null },
    ]);
    const [repo] = await db.select().from(repository).where(eq(repository.id, repositoryId));
    expect(repo?.labelsSyncedAt).not.toBeNull();
  });

  it("makes no request at all while the mirror is fresh", async () => {
    await seed();
    nextLabels = [label("bug")];
    const [first] = await linkedRepositories(db);
    await syncRepositoryLabels(db, first as never);
    expect(calls).toBe(1);

    // Re-read so the row carries the watermark the pass just wrote.
    const [second] = await linkedRepositories(db);
    const result = await syncRepositoryLabels(db, second as never);

    expect(result.skipped).toBe(true);
    expect(calls).toBe(1);
  });

  it("asks anyway when forced, which is what a Sync now button needs", async () => {
    await seed();
    nextLabels = [label("bug")];
    const [first] = await linkedRepositories(db);
    await syncRepositoryLabels(db, first as never);

    const [second] = await linkedRepositories(db);
    await syncRepositoryLabels(db, second as never, { force: true });

    expect(calls).toBe(2);
  });

  it("drops a label the provider no longer defines", async () => {
    const { repositoryId } = await seed();
    nextLabels = [label("bug"), label("wontfix")];
    const [first] = await linkedRepositories(db);
    await syncRepositoryLabels(db, first as never);

    nextLabels = [label("bug")];
    const [second] = await linkedRepositories(db);
    await syncRepositoryLabels(db, second as never, { force: true });

    // Unlike an issue, nothing references a label row, and the vocabulary arrives unpaged — so
    // absence here really is evidence of deletion.
    expect(await stored(repositoryId)).toEqual([{ name: "bug", color: "#ff0000" }]);
  });

  it("keeps the previous mirror when the read fails", async () => {
    const { repositoryId } = await seed();
    nextLabels = [label("bug", "#d73a4a")];
    const [first] = await linkedRepositories(db);
    await syncRepositoryLabels(db, first as never);

    nextError = new Error("403 Forbidden");
    const [second] = await linkedRepositories(db);
    const result = await syncRepositoryLabels(db, second as never, { force: true });

    expect(result.failedReason).toContain("403");
    // Emptying here would repaint every chip on the table grey because one request failed.
    expect(await stored(repositoryId)).toEqual([{ name: "bug", color: "#d73a4a" }]);
  });

  it("reports no change when the vocabulary came back identical", async () => {
    await seed();
    nextLabels = [label("bug", "#d73a4a"), label("chore", "#cccccc")];
    const [first] = await linkedRepositories(db);
    await syncRepositoryLabels(db, first as never);

    const [second] = await linkedRepositories(db);
    const result = await syncRepositoryLabels(db, second as never, { force: true });

    // The common case by far, and the reason `changed` is not just "a read succeeded":
    // announcing this would make every open tab re-query for rows that did not move.
    expect(result.labels).toBe(2);
    expect(result.changed).toBe(false);
  });

  it("updates a colour that moved without touching one that did not", async () => {
    const { repositoryId } = await seed();
    nextLabels = [label("bug", "#d73a4a"), label("chore", "#cccccc")];
    const [first] = await linkedRepositories(db);
    await syncRepositoryLabels(db, first as never);

    nextLabels = [label("bug", "#000000"), label("chore", "#cccccc")];
    const [second] = await linkedRepositories(db);
    await syncRepositoryLabels(db, second as never, { force: true });

    expect(await stored(repositoryId)).toEqual([
      { name: "bug", color: "#000000" },
      { name: "chore", color: "#cccccc" },
    ]);
  });

  it("survives a provider that reports the same name twice", async () => {
    const { repositoryId } = await seed();
    // The unique index is `(repository, name)`; one duplicate must not fail the whole write.
    nextLabels = [label("bug", "#d73a4a"), label("bug", "#000000")];
    const [row] = await linkedRepositories(db);

    const result = await syncRepositoryLabels(db, row as never);

    expect(result.labels).toBe(1);
    expect(await stored(repositoryId)).toEqual([{ name: "bug", color: "#000000" }]);
  });

  it("does nothing for a repository that is not linked to an integration", async () => {
    await seed();
    await db.update(repository).set({ integrationId: null });
    const rows = await linkedRepositories(db);

    // `linkedRepositories` already filters it out; the guard inside is the second line.
    expect(rows).toHaveLength(0);
    expect(calls).toBe(0);
  });
});
