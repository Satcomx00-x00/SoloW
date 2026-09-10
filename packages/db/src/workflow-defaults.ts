import { rankBetween, WORKFLOW_STORE_SEEDS, workflowStoreDocument } from "@solow/core";
import { asc, eq } from "drizzle-orm";
import type { Db } from "./index.js";
import { harnessProfile, workflow, workflowStep } from "./schema.js";

/**
 * The Workflows a Workspace starts with (spec F03): the store's `seed` entries — three pipelines
 * that show what a Step, a gate and a harness-decided branch are for, ready to attach a Task to.
 * Seeded only when the Workspace has **no** Workflow yet — a pipeline the operator deleted stays
 * deleted (and can be taken back from the store) — and only once a Harness Profile exists,
 * because a Step has to name the harness that runs it; a fresh install therefore gets them the
 * moment its first Profile is created (`createHarnessProfile` calls this too), and never before.
 *
 * Written here, not through `workflow.import`: that lives in the web app's DAL, and the seed
 * runs from bootstrap and from the Profile write, both of which are inside this package. The
 * document is the same one the store installs, so the two cannot drift.
 */
export const DEFAULT_WORKFLOWS = WORKFLOW_STORE_SEEDS;

export async function ensureDefaultWorkflows(
  db: Db,
  workspaceId: string,
): Promise<{ seeded: number }> {
  const existing = await db
    .select({ id: workflow.id })
    .from(workflow)
    .where(eq(workflow.workspaceId, workspaceId))
    .limit(1);
  if (existing.length > 0) return { seeded: 0 };
  const [profile] = await db
    .select({ id: harnessProfile.id, name: harnessProfile.name })
    .from(harnessProfile)
    .where(eq(harnessProfile.workspaceId, workspaceId))
    .orderBy(asc(harnessProfile.createdAt))
    .limit(1);
  if (!profile) return { seeded: 0 };

  for (const seed of DEFAULT_WORKFLOWS) {
    const document = workflowStoreDocument(seed, profile.name);
    const [wf] = await db
      .insert(workflow)
      .values({ workspaceId, name: document.name, description: document.description })
      .returning({ id: workflow.id });
    if (!wf) throw new Error(`could not seed workflow ${seed.title}`);

    // Ranked the way the designer ranks: each Step after the last, so the ranks the seed writes
    // are the ones a later insert or drag can fit between.
    const ids: string[] = [];
    let previous: string | null = null;
    for (const step of document.steps) {
      const rank = rankBetween(previous, null);
      if (!rank.ok) throw new Error(`could not rank step ${step.name}`);
      const [row] = await db
        .insert(workflowStep)
        .values({
          workspaceId,
          workflowId: wf.id,
          rank: rank.data,
          name: step.name,
          agentProfileId: profile.id,
          promptTemplate: step.promptTemplate,
          gate: step.gate,
          advanceOn: step.advanceOn,
          permissionMode: step.permissionMode,
        })
        .returning({ id: workflowStep.id });
      if (!row) throw new Error(`could not seed step ${step.name}`);
      ids.push(row.id);
      previous = rank.data;
    }
    // Branches last, once every target has an id — the document names them by index.
    for (const [index, step] of document.steps.entries()) {
      if (!step.branch) continue;
      const self = ids[index];
      const target = (at: number | null) => (at === null ? null : (ids[at] ?? null));
      if (!self) throw new Error(`branch source ${step.name} missing`);
      await db
        .update(workflowStep)
        .set({
          branch: {
            when: step.branch.when,
            thenStepId: target(step.branch.thenStep),
            elseStepId: target(step.branch.elseStep),
          },
        })
        .where(eq(workflowStep.id, self));
    }
  }
  return { seeded: DEFAULT_WORKFLOWS.length };
}
