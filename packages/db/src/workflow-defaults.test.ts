/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { validateWorkflowGraph, workflowStoreDocument } from "@solow/core";
import { asc, eq } from "drizzle-orm";
import { ensureDefaultHarnessCatalog } from "./harness-catalog-defaults.js";
import { harnessProfile, secret, workflow, workflowStep, workspace } from "./schema.js";
import { createTestDb, type TestDb } from "./testing.js";
import { DEFAULT_WORKFLOWS, ensureDefaultWorkflows } from "./workflow-defaults.js";

describe("ensureDefaultWorkflows", () => {
  let db: TestDb;
  let wsId: string;
  beforeEach(async () => {
    db = await createTestDb();
    const [ws] = await db.insert(workspace).values({ name: "Acme", ownerUserId: "o1" }).returning();
    if (!ws) throw new Error("seed");
    wsId = ws.id;
  });

  async function seedProfile(name = "Harness#1"): Promise<string> {
    const catalogId = await ensureDefaultHarnessCatalog(db, wsId);
    const [token] = await db
      .insert(secret)
      .values({ workspaceId: wsId, name: `${name}-token`, kind: "api_key", ciphertext: "x" })
      .returning({ id: secret.id });
    if (!token) throw new Error("seed secret");
    const [row] = await db
      .insert(harnessProfile)
      .values({
        workspaceId: wsId,
        name,
        agentCatalogId: catalogId,
        authMode: "subscription",
        secretId: token.id,
        concurrencyCap: 1,
      })
      .returning({ id: harnessProfile.id });
    if (!row) throw new Error("seed profile");
    return row.id;
  }

  it("waits for a Harness Profile, then seeds three pipelines whose graphs are valid", async () => {
    expect(await ensureDefaultWorkflows(db, wsId)).toEqual({ seeded: 0 });
    const profileId = await seedProfile();
    expect(await ensureDefaultWorkflows(db, wsId)).toEqual({ seeded: 3 });

    const workflows = await db.select().from(workflow).where(eq(workflow.workspaceId, wsId));
    expect(workflows.map((w) => w.name)).toEqual(DEFAULT_WORKFLOWS.map((w) => w.title));
    for (const wf of workflows) {
      const steps = await db
        .select()
        .from(workflowStep)
        .where(eq(workflowStep.workflowId, wf.id))
        .orderBy(asc(workflowStep.rank));
      expect(steps.every((s) => s.agentProfileId === profileId)).toBe(true);
      // The designer's own rules: one start, every Step reachable, every Step with a way out.
      expect(validateWorkflowGraph(steps)).toEqual([]);
    }

    const review = (await db.select().from(workflowStep).where(eq(workflowStep.name, "Review")))[0];
    const implement = (
      await db.select().from(workflowStep).where(eq(workflowStep.name, "Implement"))
    )[0];
    expect(review?.branch).toEqual({
      when: {
        kind: "agent-decides",
        question: "Does the implementation need another pass before it can be merged?",
      },
      thenStepId: implement?.id ?? null,
      elseStepId: null,
    });
    const plan = (await db.select().from(workflowStep).where(eq(workflowStep.name, "Plan")))[0];
    expect([plan?.gate, plan?.advanceOn]).toEqual(["human", "review"]);
  });

  it("writes exactly what the store entry says, so the seed and the store cannot disagree", async () => {
    await seedProfile("Harness#1");
    await ensureDefaultWorkflows(db, wsId);
    for (const seed of DEFAULT_WORKFLOWS) {
      const document = workflowStoreDocument(seed, "Harness#1");
      const [wf] = await db.select().from(workflow).where(eq(workflow.name, document.name));
      expect(wf?.description).toBe(document.description);
      const steps = await db
        .select()
        .from(workflowStep)
        .where(eq(workflowStep.workflowId, wf?.id ?? ""))
        .orderBy(asc(workflowStep.rank));
      const ids = steps.map((s) => s.id);
      expect(
        steps.map((s) => ({
          name: s.name,
          promptTemplate: s.promptTemplate,
          gate: s.gate,
          advanceOn: s.advanceOn,
          permissionMode: s.permissionMode,
          branch: s.branch
            ? {
                when: s.branch.when,
                thenStep: s.branch.thenStepId === null ? null : ids.indexOf(s.branch.thenStepId),
                elseStep: s.branch.elseStepId === null ? null : ids.indexOf(s.branch.elseStepId),
              }
            : null,
        })),
      ).toEqual(
        document.steps.map((s) => ({
          name: s.name,
          promptTemplate: s.promptTemplate,
          gate: s.gate,
          advanceOn: s.advanceOn,
          permissionMode: s.permissionMode,
          branch: s.branch,
        })),
      );
    }
  });

  it("seeds once, and never into a Workspace that already has a Workflow of its own", async () => {
    await seedProfile();
    await ensureDefaultWorkflows(db, wsId);
    expect(await ensureDefaultWorkflows(db, wsId)).toEqual({ seeded: 0 });

    const [other] = await db
      .insert(workspace)
      .values({ name: "Other", ownerUserId: "o2" })
      .returning();
    if (!other) throw new Error("seed");
    await db.insert(workflow).values({ workspaceId: other.id, name: "Theirs", description: null });
    const before = (await db.select().from(workflow).where(eq(workflow.workspaceId, other.id)))
      .length;
    expect(await ensureDefaultWorkflows(db, other.id)).toEqual({ seeded: 0 });
    expect(
      (await db.select().from(workflow).where(eq(workflow.workspaceId, other.id))).length,
    ).toBe(before);
  });
});
