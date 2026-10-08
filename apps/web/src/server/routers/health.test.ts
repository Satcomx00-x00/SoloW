/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { task as taskTable } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { seedIssue, seedWorkspaceGraph } from "../dal/test-fixtures.js";
import { webHealth } from "../health.js";
import type { BaseContext } from "../trpc.js";
import { appRouter } from "./index.js";

/**
 * The product's own health (FINDINGS F3), through the real router: what the status bar is told
 * when the orchestrator or the engine behind it is down, and the "needs attention" list.
 */

const caller = (db: TestDb, workspaceId: string | null, core = true) =>
  appRouter.createCaller({
    db,
    session: workspaceId ? { workspaceId, userId: "user-1" } : null,
    flagOverrides: { "ff-core-program": core },
  } satisfies BaseContext);

const realFetch = globalThis.fetch;
const urls: string[] = [];

function orchestratorAnswers(answer: () => Response | Promise<Response>) {
  process.env["SOLOW_ORCHESTRATOR_URL"] = "http://orchestrator.test";
  globalThis.fetch = (async (input: unknown) => {
    urls.push(String(input));
    return answer();
  }) as typeof globalThis.fetch;
}

let db: TestDb;
let workspaceId: string;

beforeEach(async () => {
  db = createTestDb();
  workspaceId = (await seedWorkspaceGraph(db, "health")).workspaceId;
  urls.length = 0;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Reflect.deleteProperty(process.env, "SOLOW_ORCHESTRATOR_URL");
});

describe("health.status", () => {
  it("says the orchestrator is not configured when nothing names it", async () => {
    const health = await caller(db, workspaceId).health.status();
    expect(health.orchestrator.state).toBe("not_configured");
    expect(health.engine.state).toBe("unknown");
  });

  it("passes on the orchestrator's own report of the engine", async () => {
    orchestratorAnswers(() =>
      Response.json({
        status: "ok",
        service: "orchestrator",
        engine: { state: "unreachable", detail: "engine refused the connection" },
      }),
    );
    const health = await caller(db, workspaceId).health.status();
    expect(urls).toEqual(["http://orchestrator.test/health"]);
    expect(health.orchestrator).toEqual({ state: "ok", detail: null });
    expect(health.engine).toEqual({
      state: "unreachable",
      detail: "engine refused the connection",
    });
  });

  it("reports an orchestrator that does not answer, and leaves the engine unknown", async () => {
    orchestratorAnswers(() => {
      throw new TypeError("fetch failed");
    });
    const health = await caller(db, workspaceId).health.status();
    expect(health.orchestrator.state).toBe("unreachable");
    expect(health.engine.state).toBe("unknown");
  });

  it("reports an orchestrator that answers with an error", async () => {
    orchestratorAnswers(() => new Response("", { status: 500 }));
    const health = await caller(db, workspaceId).health.status();
    expect(health.orchestrator).toEqual({
      state: "unreachable",
      detail: "orchestrator answered 500",
    });
  });

  it("counts an orchestrator answering without a report as up", async () => {
    // An orchestrator older than the report, or the E2E suite's stand-in, answers plain "ok".
    orchestratorAnswers(() => new Response("ok"));
    const health = await caller(db, workspaceId).health.status();
    expect(health.orchestrator.state).toBe("ok");
    expect(health.engine.state).toBe("unknown");
  });

  it("answers with the core loop switched off: that is when the services matter most", async () => {
    const health = await caller(db, workspaceId, false).health.status();
    expect(health.orchestrator.state).toBe("not_configured");
  });

  it("refuses a caller with no session", async () => {
    await expect(caller(db, null).health.status()).rejects.toThrow();
  });
});

describe("health.attention", () => {
  it("lists a failed Task for its own Workspace", async () => {
    const graph = await seedWorkspaceGraph(db, "attention");
    const issue = await seedIssue(db, graph.workspaceId);
    await db.insert(taskTable).values({
      workspaceId: graph.workspaceId,
      issueId: issue.id,
      title: "Broke",
      state: "failed",
      failureReason: "fail",
      agentProfileId: graph.agentProfileId,
      executorProfileId: graph.executorProfileId,
    });

    const list = await caller(db, graph.workspaceId).health.attention();
    expect(list.items.map((i) => [i.title, i.kind, i.cause])).toEqual([
      ["Broke", "failed", "failed"],
    ]);
    expect((await caller(db, workspaceId).health.attention()).items).toEqual([]);
  });

  it("is behind the core loop's switch, like every other read of Tasks", async () => {
    await expect(caller(db, workspaceId, false).health.attention()).rejects.toThrow();
  });
});

describe("webHealth", () => {
  it("is ok when the database answers", async () => {
    expect(await webHealth(() => db)).toEqual({ status: "ok", service: "web", database: "ok" });
  });

  it("is an error, not a throw, when the database cannot be opened", async () => {
    const report = await webHealth(() => {
      throw new Error("SOLOW_SECRET_KEY is required");
    });
    expect(report).toEqual({ status: "error", service: "web", database: "unreachable" });
  });
});
