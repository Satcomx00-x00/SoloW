/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { harnessProfile, issue, task } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { seedWorkspaceGraph } from "../dal/test-fixtures.js";
import type { BaseContext } from "../trpc.js";
import { appRouter } from "./index.js";

/**
 * Emptying a Workspace, through the router (spec F16).
 *
 * The walk itself is covered in `@solow/db`'s `workspace-reset.test.ts`, against two Workspaces.
 * What only a router test can see is the rest of the contract: the flag that gates it, the
 * session it needs, and the typed name — which is checked against the name the *server* holds,
 * so a client that sends the wrong one is refused however confidently it asks.
 */

let db: TestDb;
let seeded: Awaited<ReturnType<typeof seedWorkspaceGraph>>;

function caller(
  session: { workspaceId: string; userId: string } | null,
  overrides: Record<string, boolean> = { "ff-workspace-controls": true },
) {
  const ctx: BaseContext = { db, session, flagOverrides: overrides };
  return appRouter.createCaller(ctx);
}

async function errCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "OK";
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
}

beforeEach(async () => {
  db = createTestDb();
  // `seedWorkspaceGraph` names the Workspace after its argument, which is the name the reset
  // asks the Owner to type back.
  seeded = await seedWorkspaceGraph(db, "acme");
  await db.insert(issue).values({ id: "iss-1", workspaceId: seeded.workspaceId, title: "Ship it" });
  await db.insert(task).values({
    id: "task-1",
    workspaceId: seeded.workspaceId,
    issueId: "iss-1",
    title: "Do it",
    agentProfileId: seeded.agentProfileId,
    executorProfileId: seeded.executorProfileId,
  });
});

describe("workspace.reset", () => {
  it("refuses a name that is not the Workspace's own, and deletes nothing", async () => {
    const api = caller({ workspaceId: seeded.workspaceId, userId: "ada" });

    expect(
      await errCode(() => api.workspace.reset({ scope: "work-data", confirmName: "acme inc" })),
    ).toBe("BAD_REQUEST");
    // The gate has to fail closed: a refused reset that had already emptied half the tables
    // would be worse than no gate at all.
    expect(await db.select().from(task)).toHaveLength(1);
    expect(await db.select().from(issue)).toHaveLength(1);
  });

  it("removes the work and reports what it removed", async () => {
    const api = caller({ workspaceId: seeded.workspaceId, userId: "ada" });

    const receipt = await api.workspace.reset({ scope: "work-data", confirmName: "acme" });

    expect(await db.select().from(task)).toHaveLength(0);
    expect(await db.select().from(issue)).toHaveLength(0);
    // The receipt is the only account an Owner gets of something with no undo, so it has to be
    // a real tally rather than a fixed message.
    expect(receipt.scope).toBe("work-data");
    expect(receipt.rows).toBeGreaterThan(0);
    expect(receipt.removed.map((entry) => entry.table)).toContain("task");
  });

  it("is unreachable while its flag is off", async () => {
    // An explicit `false`, not an absent override: flags default ON (constitution v1.5.0), so
    // omitting it would now mean "enabled" and this case would assert nothing.
    const api = caller(
      { workspaceId: seeded.workspaceId, userId: "ada" },
      { "ff-workspace-controls": false },
    );

    expect(
      await errCode(() => api.workspace.reset({ scope: "work-data", confirmName: "acme" })),
    ).toBe("FORBIDDEN");
  });

  it("refuses an unauthenticated caller", async () => {
    expect(
      await errCode(() =>
        caller(null).workspace.reset({ scope: "everything", confirmName: "acme" }),
      ),
    ).toBe("UNAUTHORIZED");
  });

  it("forgives stray spaces around the typed name, but nothing else", async () => {
    const api = caller({ workspaceId: seeded.workspaceId, userId: "ada" });

    // Pasting a name picks up whitespace; that is the same name, and refusing it would read as
    // the gate being broken. A different case is a different name.
    expect(
      await errCode(() => api.workspace.reset({ scope: "work-data", confirmName: "ACME" })),
    ).toBe("BAD_REQUEST");
    await api.workspace.reset({ scope: "work-data", confirmName: "  acme " });
    expect(await db.select().from(task)).toHaveLength(0);
  });

  it("empties only the caller's own Workspace, whatever name is typed (Principle V)", async () => {
    const other = await seedWorkspaceGraph(db, "other");
    await db.insert(issue).values({ id: "iss-2", workspaceId: other.workspaceId, title: "Theirs" });
    const api = caller({ workspaceId: seeded.workspaceId, userId: "ada" });

    // The other Workspace's name is not a way to reach it: the name is checked against the
    // session's own Workspace, never used to find one.
    expect(
      await errCode(() => api.workspace.reset({ scope: "everything", confirmName: "other" })),
    ).toBe("BAD_REQUEST");
    await api.workspace.reset({ scope: "everything", confirmName: "acme" });

    const left = await db.select().from(issue);
    expect(left.map((row) => row.id)).toEqual(["iss-2"]);
    expect((await db.select().from(harnessProfile)).map((row) => row.workspaceId)).toEqual([
      other.workspaceId,
    ]);
  });

  it("allows three attempts an hour, and counts a refused one among them", async () => {
    const api = caller({ workspaceId: seeded.workspaceId, userId: "ada" });

    // Counted before the name is read, deliberately: a wedged client retrying a wrong name is
    // exactly the loop the limit is for, and it should stop that loop too.
    expect(
      await errCode(() => api.workspace.reset({ scope: "work-data", confirmName: "nope" })),
    ).toBe("BAD_REQUEST");
    await api.workspace.reset({ scope: "work-data", confirmName: "acme" });
    await api.workspace.reset({ scope: "work-data", confirmName: "acme" });

    expect(
      await errCode(() => api.workspace.reset({ scope: "work-data", confirmName: "acme" })),
    ).toBe("TOO_MANY_REQUESTS");
  });
});

describe("preference.setTaskDefaults", () => {
  it("saves the pair the same user reads back", async () => {
    const api = caller({ workspaceId: seeded.workspaceId, userId: "ada" });

    await api.preference.setTaskDefaults({
      harnessProfileId: seeded.agentProfileId,
      executorProfileId: seeded.executorProfileId,
    });

    const read = await api.preference.getTaskDefaults({});
    expect(read.defaults).toEqual({
      harnessProfileId: seeded.agentProfileId,
      executorProfileId: seeded.executorProfileId,
    });
  });

  it("refuses a Profile this Workspace does not own (Principle V)", async () => {
    const other = await seedWorkspaceGraph(db, "other");
    const api = caller({ workspaceId: seeded.workspaceId, userId: "ada" });

    expect(
      await errCode(() =>
        api.preference.setTaskDefaults({
          harnessProfileId: other.agentProfileId,
          executorProfileId: null,
        }),
      ),
    ).toBe("NOT_FOUND");
  });

  it("answers null for a default whose Profile has since been deleted", async () => {
    const api = caller({ workspaceId: seeded.workspaceId, userId: "ada" });
    await api.preference.setTaskDefaults({
      harnessProfileId: seeded.agentProfileId,
      executorProfileId: null,
    });

    // The one preference that points at another row, so the only one something else can
    // invalidate. A form preselecting a deleted Profile would fail on submit, naming an id the
    // Owner never typed.
    // The Task the fixture seeded references it, so it goes first — the point of the case is
    // the dangling *preference*, not a dangling foreign key.
    await db.delete(task);
    await db.delete(harnessProfile);

    expect((await api.preference.getTaskDefaults({})).defaults.harnessProfileId).toBeNull();
  });
});

describe("preference.setAppearance", () => {
  it("saves the theme, and defaults to dark when nothing is saved", async () => {
    const api = caller({ workspaceId: seeded.workspaceId, userId: "ada" });

    // Dark rather than `system`, so an existing installation does not change appearance on
    // upgrade because of a setting nobody touched.
    expect((await api.preference.getAppearance({})).appearance.theme).toBe("dark");

    await api.preference.setAppearance({ theme: "light" });
    expect((await api.preference.getAppearance({})).appearance.theme).toBe("light");
  });

  it("keeps one user's theme out of another's", async () => {
    const ada = caller({ workspaceId: seeded.workspaceId, userId: "ada" });
    await ada.preference.setAppearance({ theme: "light" });

    const grace = caller({ workspaceId: seeded.workspaceId, userId: "grace" });
    expect((await grace.preference.getAppearance({})).appearance.theme).toBe("dark");
  });
});
