import { rankBetween } from "@solow/core";
import { asc, eq } from "drizzle-orm";
import type { Db } from "./index.js";
import { agentProfile, workflow, workflowStep } from "./schema.js";

/**
 * The Workflows a Workspace starts with (spec F03): three pipelines that show what a Step, a
 * gate and an agent-decided branch are for, ready to attach a Task to. Seeded only when the
 * Workspace has **no** Workflow yet — a pipeline the operator deleted stays deleted — and only
 * once an Agent Profile exists, because a Step has to name the agent that runs it; a fresh
 * install therefore gets them the moment its first Profile is created (`createAgentProfile`
 * calls this too), and never before.
 */

type StepSeed = {
  name: string;
  prompt: string;
  gate: "human" | "auto" | "auto-unless-changes";
  advanceOn: "agent-signal" | "review";
  /** A branch on the agent's answer: yes goes back to the named Step, no ends the pipeline. */
  askAgent?: { question: string; yesGoesTo: string };
};

type WorkflowSeed = { name: string; description: string; steps: StepSeed[] };

export const DEFAULT_WORKFLOWS: readonly WorkflowSeed[] = [
  {
    name: "Implement & review",
    description:
      "Implement the issue, then a reviewer agent decides whether it needs another pass.",
    steps: [
      {
        name: "Implement",
        gate: "auto",
        advanceOn: "agent-signal",
        prompt:
          "Implement what the issue asks for. Keep the change minimal and consistent with the codebase, and do not touch unrelated files. If this is a later pass, address the reviewer's notes in the handoff above first.",
      },
      {
        name: "Review",
        gate: "auto",
        advanceOn: "agent-signal",
        prompt:
          "Review the previous step's implementation against the issue: correctness, tests, and consistency with the codebase. Do not modify any file. Name every defect precisely in your summary.",
        askAgent: {
          question: "Does the implementation need another pass before it can be merged?",
          yesGoesTo: "Implement",
        },
      },
    ],
  },
  {
    name: "Plan, then build",
    description: "A written plan you approve, then the build that follows it.",
    steps: [
      {
        name: "Plan",
        gate: "human",
        advanceOn: "review",
        prompt:
          "Study the issue and the codebase, then write a short plan: the files to change, the approach, the tests to add, and the risks. Do not change any file.",
      },
      {
        name: "Build",
        gate: "auto",
        advanceOn: "agent-signal",
        prompt:
          "Carry out the plan in the handoff above. Keep the change focused, and add or update the tests the plan calls for.",
      },
    ],
  },
  {
    name: "Bug fix",
    description: "Reproduce it, fix it, verify it — and loop until the reproduction passes.",
    steps: [
      {
        name: "Reproduce",
        gate: "auto",
        advanceOn: "agent-signal",
        prompt:
          "Reproduce the bug the issue describes: find the failing behaviour and, where possible, write a failing test that captures it. Do not fix it yet. Say exactly how it reproduces in your summary.",
      },
      {
        name: "Fix",
        gate: "auto",
        advanceOn: "agent-signal",
        prompt:
          "Fix the bug so the reproduction in the handoff above passes, changing as little as possible.",
      },
      {
        name: "Verify",
        gate: "auto",
        advanceOn: "agent-signal",
        prompt:
          "Re-run the reproduction and the test suite. Do not modify any file. Report what passed and what did not.",
        askAgent: {
          question: "Does the bug still reproduce, or did the fix break a test?",
          yesGoesTo: "Fix",
        },
      },
    ],
  },
];

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
    .select({ id: agentProfile.id })
    .from(agentProfile)
    .where(eq(agentProfile.workspaceId, workspaceId))
    .orderBy(asc(agentProfile.createdAt))
    .limit(1);
  if (!profile) return { seeded: 0 };

  for (const seed of DEFAULT_WORKFLOWS) {
    const [wf] = await db
      .insert(workflow)
      .values({ workspaceId, name: seed.name, description: seed.description })
      .returning({ id: workflow.id });
    if (!wf) throw new Error(`could not seed workflow ${seed.name}`);

    // Ranked the way the designer ranks: each Step after the last, so the ranks the seed writes
    // are the ones a later insert or drag can fit between.
    const ids = new Map<string, string>();
    let previous: string | null = null;
    for (const step of seed.steps) {
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
          promptTemplate: step.prompt,
          gate: step.gate,
          advanceOn: step.advanceOn,
        })
        .returning({ id: workflowStep.id });
      if (!row) throw new Error(`could not seed step ${step.name}`);
      ids.set(step.name, row.id);
      previous = rank.data;
    }
    // Branches last, once every target has an id: yes loops back, no lets the pipeline end.
    for (const step of seed.steps) {
      if (!step.askAgent) continue;
      const self = ids.get(step.name);
      const target = ids.get(step.askAgent.yesGoesTo);
      if (!self || !target) throw new Error(`branch target ${step.askAgent.yesGoesTo} missing`);
      await db
        .update(workflowStep)
        .set({
          branch: {
            when: { kind: "agent-decides", question: step.askAgent.question },
            thenStepId: target,
            elseStepId: null,
          },
        })
        .where(eq(workflowStep.id, self));
    }
  }
  return { seeded: DEFAULT_WORKFLOWS.length };
}
