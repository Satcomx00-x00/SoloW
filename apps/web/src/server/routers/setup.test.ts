/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { workspace } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import type { BaseContext } from "../trpc.js";
import { appRouter } from "./index.js";

/**
 * The guided setup reached through the real router (roadmap E1). The rules — one transaction,
 * nothing made twice, the state read from rows — are proved at the DAL layer (`dal/setup.test.ts`);
 * what this file proves is the layer above: the write is behind the core loop like every other,
 * its output satisfies the contract end to end, and the credential never comes back out.
 */

let db: TestDb;

beforeEach(() => {
  db = createTestDb();
});

async function seedWs(name: string): Promise<string> {
  const [row] = await db
    .insert(workspace)
    .values({ name, ownerUserId: `owner-${name}` })
    .returning();
  if (!row) throw new Error("failed to seed workspace");
  return row.id;
}

function caller(workspaceId: string, coreLoop = true) {
  const ctx: BaseContext = {
    db,
    session: { workspaceId, userId: "user-1" },
    flagOverrides: { "ff-core-program": coreLoop },
  };
  return appRouter.createCaller(ctx);
}

describe("setup.connectClaude", () => {
  it("connects in one call and never echoes the credential", async () => {
    const id = await seedWs("acme");

    const result = await caller(id).setup.connectClaude({
      billing: "subscription",
      // Pasted from a terminal, newline and all.
      credential: "sk-ant-oat01-do-not-echo\n",
    });

    expect(result.executorKind).toBe("local");
    expect(result.createdExecutor).toBe(true);
    expect(result.resumedTaskCount).toBe(0);
    expect(JSON.stringify(result)).not.toContain("do-not-echo");

    const setup = await caller(id).workspace.setup();
    expect(setup.steps.find((s) => s.key === "claude")?.done).toBe(true);
  });

  it("refuses an empty credential at the boundary", async () => {
    const id = await seedWs("acme");

    await expect(
      caller(id).setup.connectClaude({ billing: "api_key", credential: "   " }),
    ).rejects.toThrow();
  });

  it("sits behind the core loop's kill switch, while the read stays open to say so", async () => {
    const id = await seedWs("acme");

    await expect(
      caller(id, false).setup.connectClaude({ billing: "api_key", credential: "sk-ant-key" }),
    ).rejects.toThrow();
    // The read is how the screen learns the loop is off, so the switch must not take it too.
    const setup = await caller(id, false).workspace.setup();
    expect(setup.steps).toHaveLength(3);
  });
});

describe("setup.test", () => {
  it("answers with a cause rather than an error when there is nothing to test", async () => {
    const id = await seedWs("acme");

    const result = await caller(id).setup.test();

    expect(result).toMatchObject({ ok: false, problem: "not-connected", fixStep: "claude" });
  });
});
