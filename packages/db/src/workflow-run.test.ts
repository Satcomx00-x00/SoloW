/// <reference types="bun-types" />
import { beforeEach, describe, expect, it } from "bun:test";
import { WorkflowErrorCode } from "@solow/contracts";
import { appendRank } from "@solow/core";
import { eq } from "drizzle-orm";
import { ensureDefaultAgentCatalog } from "./agent-catalog-defaults.js";
import {
  agentProfile,
  executorProfile,
  issue,
  review,
  session,
  sessionEvent,
  task,
  workflow,
  workflowStep,
  workspace,
} from "./schema.js";
import { createTestDb, type TestDb } from "./testing.js";
import {
  advanceTaskWorkflow,
  clearTaskWorkflowPendingHandoff,
  loadTaskWorkflowRun,
} from "./workflow-run.js";

/**
 * The Workflow run, tested where it now lives (issue #5, AC-2/AC-4/AC-5).
 *
 * The advance moved out of the web DAL because the orchestrator runs the same transaction from
 * inside a durable step, and these are the tests that make the move worth making: every one of
 * them reads the `task` ROW BACK from the database afterwards rather than trusting the DTO the
 * function returned. A test that asserts against the return value agrees with the bug whenever
 * the code decides one thing and the row records another — and the row is what the next run,
 * after a restart, actually resumes from.
 */

interface Pipeline {
  workspaceId: string;
  taskId: string;
  sessionId: string;
  stepIds: string[];
}

type StepSpec = {
  gate?: "human" | "auto" | "auto-unless-changes";
  advanceOn?: "review" | "agent-signal";
};

let db: TestDb;

/** Read the four columns an advance can write. Nothing here goes through a DTO. */
async function taskRow(taskId: string) {
  const [row] = await db
    .select({
      workflowStepId: task.workflowStepId,
      workflowHandoff: task.workflowHandoff,
      workflowPendingHandoff: task.workflowPendingHandoff,
      workflowDecisionId: task.workflowDecisionId,
    })
    .from(task)
    .where(eq(task.id, taskId))
    .limit(1);
  if (!row) throw new Error("task vanished");
  return row;
}

/** A Workspace with one Task attached to a pipeline of the given Steps, cursor on Step 1. */
async function pipeline(name: string, specs: StepSpec[]): Promise<Pipeline> {
  const [ws] = await db
    .insert(workspace)
    .values({ name, ownerUserId: `owner-${name}` })
    .returning();
  if (!ws) throw new Error("failed to seed workspace");
  const workspaceId = ws.id;

  const agentCatalogId = await ensureDefaultAgentCatalog(db, workspaceId);
  const [agent] = await db
    .insert(agentProfile)
    .values({
      workspaceId,
      name: `${name}-agent`,
      agentCatalogId,
      authMode: "subscription",
      secretId: "secret-not-read-here",
    })
    .returning();
  const [executor] = await db
    .insert(executorProfile)
    .values({ workspaceId, name: `${name}-executor` })
    .returning();
  const [iss] = await db.insert(issue).values({ workspaceId, title: "Fix latch" }).returning();
  if (!agent || !executor || !iss) throw new Error("failed to seed profiles");

  const [row] = await db
    .insert(task)
    .values({
      workspaceId,
      issueId: iss.id,
      title: `${name} task`,
      agentProfileId: agent.id,
      executorProfileId: executor.id,
    })
    .returning();
  const [wf] = await db
    .insert(workflow)
    .values({ workspaceId, name: `${name}-wf` })
    .returning();
  if (!row || !wf) throw new Error("failed to seed task");

  const stepIds: string[] = [];
  let rank: string | null = null;
  for (const [index, spec] of specs.entries()) {
    rank = appendRank(rank);
    const [step] = await db
      .insert(workflowStep)
      .values({
        workspaceId,
        workflowId: wf.id,
        rank,
        name: `Step ${index + 1}`,
        agentProfileId: agent.id,
        promptTemplate: `Do step ${index + 1}.`,
        gate: spec.gate ?? "auto",
        advanceOn: spec.advanceOn ?? "agent-signal",
      })
      .returning();
    if (!step) throw new Error("failed to seed step");
    stepIds.push(step.id);
  }

  await db
    .update(task)
    .set({ workflowId: wf.id, workflowStepId: stepIds[0], workflowVersion: wf.version })
    .where(eq(task.id, row.id));

  const [sess] = await db
    .insert(session)
    .values({ workspaceId, taskId: row.id, state: "active" })
    .returning();
  if (!sess) throw new Error("failed to seed session");

  return { workspaceId, taskId: row.id, sessionId: sess.id, stepIds };
}

/** Record a human decision the way the review gate does — a row, never an input. */
async function decide(
  p: Pipeline,
  decision: "approve" | "reject" | "request_changes",
  sessionId = p.sessionId,
): Promise<string> {
  const [row] = await db
    .insert(review)
    .values({
      workspaceId: p.workspaceId,
      sessionId,
      decision,
      actorUserId: "reviewer-1",
    })
    .returning();
  if (!row) throw new Error("failed to record review");
  return row.id;
}

function stepId(p: Pipeline, index: number): string {
  const id = p.stepIds[index];
  if (!id) throw new Error(`pipeline has no step ${index}`);
  return id;
}

beforeEach(() => {
  db = createTestDb();
});

describe("advancing a task's workflow", () => {
  it("writes the next step, the promoted handoff and a cleared pending handoff to the row", async () => {
    const p = await pipeline("advance", [{}, {}, {}]);

    const result = await advanceTaskWorkflow(db, p.workspaceId, {
      taskId: p.taskId,
      fromStepId: stepId(p, 0),
      signal: "agent-signal",
      producedChanges: false,
      handoff: "The plan is to replace the latch.",
    });
    expect(result.ok && result.data.status).toBe("advanced");

    const row = await taskRow(p.taskId);
    expect(row.workflowStepId).toBe(stepId(p, 1));
    expect(row.workflowHandoff).toBe("The plan is to replace the latch.");
    expect(row.workflowPendingHandoff).toBeNull();
  });

  /**
   * The two-column split, asserted from the database: a Step that reports in behind a closed gate
   * parks its summary, and the Step still running keeps the brief it was given.
   */
  it("parks the summary and moves nothing when the gate holds", async () => {
    const p = await pipeline("held", [{ gate: "human" }, {}, {}]);

    const result = await advanceTaskWorkflow(db, p.workspaceId, {
      taskId: p.taskId,
      fromStepId: stepId(p, 0),
      signal: "agent-signal",
      producedChanges: true,
      handoff: "Latch replaced, awaiting sign-off.",
    });
    expect(result.ok && result.data.status).toBe("awaiting-decision");

    const row = await taskRow(p.taskId);
    expect(row.workflowStepId).toBe(stepId(p, 0));
    expect(row.workflowPendingHandoff).toBe("Latch replaced, awaiting sign-off.");
    expect(row.workflowHandoff).toBeNull();
    expect(row.workflowDecisionId).toBeNull();
  });

  /**
   * The Definition of Done's gate-bypass test (AC-4, Principle I).
   *
   * Step 1 needs no approval to move but advances *on a review*, so a human approving the PLAN
   * triggers its advance. Before the rule was fixed that approval was left unspent, and Step 3's
   * agent signal found it still on offer — completing the pipeline, and therefore integrating an
   * implementation, on the strength of a decision made about a plan. The last assertion is the
   * one that matters: `awaiting-decision`, not `completed`.
   */
  it("spends the approval that advanced the plan, so the final step still needs its own", async () => {
    const p = await pipeline("bypass", [
      { gate: "auto", advanceOn: "review" },
      { gate: "auto", advanceOn: "agent-signal" },
      { gate: "auto", advanceOn: "agent-signal" },
    ]);
    const approvalId = await decide(p, "approve");

    const first = await advanceTaskWorkflow(db, p.workspaceId, {
      taskId: p.taskId,
      fromStepId: stepId(p, 0),
      signal: "review",
      producedChanges: false,
    });
    expect(first.ok && first.data.status).toBe("advanced");

    const afterPlan = await taskRow(p.taskId);
    expect(afterPlan.workflowStepId).toBe(stepId(p, 1));
    expect(afterPlan.workflowDecisionId).toBe(approvalId);

    const second = await advanceTaskWorkflow(db, p.workspaceId, {
      taskId: p.taskId,
      fromStepId: stepId(p, 1),
      signal: "agent-signal",
      producedChanges: true,
    });
    expect(second.ok && second.data.status).toBe("advanced");

    const third = await advanceTaskWorkflow(db, p.workspaceId, {
      taskId: p.taskId,
      fromStepId: stepId(p, 2),
      signal: "agent-signal",
      producedChanges: true,
    });
    expect(third.ok && third.data.status).toBe("awaiting-decision");

    const final = await taskRow(p.taskId);
    expect(final.workflowStepId).toBe(stepId(p, 2));
    expect(final.workflowDecisionId).toBe(approvalId);
  });

  /**
   * The replay guard the orchestrator's durable step rests on: a `step.run` body that commits and
   * is then retried from the top sends the identical payload a second time.
   */
  it("refuses a redelivered advance rather than skipping a step", async () => {
    const p = await pipeline("replay", [{}, {}, {}]);
    const payload = {
      taskId: p.taskId,
      fromStepId: stepId(p, 0),
      signal: "agent-signal" as const,
      producedChanges: false,
      handoff: "Plan written.",
    };

    const first = await advanceTaskWorkflow(db, p.workspaceId, payload);
    expect(first.ok && first.data.status).toBe("advanced");

    const second = await advanceTaskWorkflow(db, p.workspaceId, payload);
    expect(second.ok).toBe(false);
    expect(!second.ok && second.error).toBe(WorkflowErrorCode.StaleCursor);

    const row = await taskRow(p.taskId);
    expect(row.workflowStepId).toBe(stepId(p, 1));
  });

  /**
   * Principle V at the one place it decides whether a change ships: the approval that opens the
   * last gate is looked up through this Task's own Sessions, *in this Workspace*.
   *
   * The row is deliberately shaped as the attack rather than as a bystander — a `review` in a
   * second Workspace naming THIS Task's Session id. A neighbouring tenant's review of its own
   * work would be excluded by the Session join alone and would prove nothing about the Workspace
   * filter; this one is excluded only by `eq(review.workspaceId, workspaceId)`.
   */
  it("ignores an approval recorded in another workspace against this task's session", async () => {
    const mine = await pipeline("mine", [{}]);
    const theirs = await pipeline("theirs", [{}]);
    await decide(theirs, "approve", mine.sessionId);

    const result = await advanceTaskWorkflow(db, mine.workspaceId, {
      taskId: mine.taskId,
      fromStepId: stepId(mine, 0),
      signal: "agent-signal",
      producedChanges: true,
    });
    expect(result.ok && result.data.status).toBe("awaiting-decision");

    const row = await taskRow(mine.taskId);
    expect(row.workflowStepId).toBe(stepId(mine, 0));
    expect(row.workflowDecisionId).toBeNull();
  });

  /**
   * The claim is a floor, not the answer: an `auto-unless-changes` Step that reports it changed
   * nothing is still gated when the Session log says otherwise.
   */
  it("corroborates a 'nothing changed' claim against the session log", async () => {
    const p = await pipeline("corroborate", [{ gate: "auto-unless-changes" }, {}]);
    await db.insert(sessionEvent).values({
      workspaceId: p.workspaceId,
      sessionId: p.sessionId,
      seq: 1,
      kind: "diff",
      payload: { files: ["src/latch.ts"] },
    });

    const result = await advanceTaskWorkflow(db, p.workspaceId, {
      taskId: p.taskId,
      fromStepId: stepId(p, 0),
      signal: "agent-signal",
      producedChanges: false,
    });
    expect(result.ok && result.data.status).toBe("awaiting-decision");
    expect((await taskRow(p.taskId)).workflowStepId).toBe(stepId(p, 0));
  });
});

describe("clearing a rejected step's pending handoff", () => {
  it("drops the summary the rejected attempt parked on the current step", async () => {
    const p = await pipeline("reject", [{ gate: "human" }, {}]);
    await advanceTaskWorkflow(db, p.workspaceId, {
      taskId: p.taskId,
      fromStepId: stepId(p, 0),
      signal: "agent-signal",
      producedChanges: true,
      handoff: "Half-done work a human refused.",
    });
    expect((await taskRow(p.taskId)).workflowPendingHandoff).toBe(
      "Half-done work a human refused.",
    );

    await clearTaskWorkflowPendingHandoff(db, p.workspaceId, p.taskId, stepId(p, 0));

    const row = await taskRow(p.taskId);
    expect(row.workflowPendingHandoff).toBeNull();
    expect(row.workflowStepId).toBe(stepId(p, 0));
  });

  /**
   * Replay safety, the same argument `advanceTaskWorkflow` makes for `StaleCursor`: the caller is
   * a durable step that can re-run after the cursor has moved on, and a clear that ignored the
   * cursor would wipe the *next* Step's inbound summary.
   */
  it("writes nothing when the cursor has already moved past the step it names", async () => {
    const p = await pipeline("stale-clear", [{}, { gate: "human" }]);
    await advanceTaskWorkflow(db, p.workspaceId, {
      taskId: p.taskId,
      fromStepId: stepId(p, 0),
      signal: "agent-signal",
      producedChanges: false,
      handoff: "Plan written.",
    });
    await advanceTaskWorkflow(db, p.workspaceId, {
      taskId: p.taskId,
      fromStepId: stepId(p, 1),
      signal: "agent-signal",
      producedChanges: true,
      handoff: "Implementation done, awaiting sign-off.",
    });

    await clearTaskWorkflowPendingHandoff(db, p.workspaceId, p.taskId, stepId(p, 0));

    const row = await taskRow(p.taskId);
    expect(row.workflowPendingHandoff).toBe("Implementation done, awaiting sign-off.");
    expect(row.workflowStepId).toBe(stepId(p, 1));
  });

  /**
   * The terminal Step, re-executed (Principle III, AC-5).
   *
   * `StaleCursor` is the replay guard for every other Step, and it works only because an
   * `advanced` outcome moves the cursor off the Step the re-executed body names. The last Step
   * has nowhere to move it, so the guard is silent exactly where the run integrates — and the
   * second pass reads a world the first one changed, because the first pass wrote its approval
   * into `workflow_decision_id`. Before this was closed the pair returned `completed` then
   * `awaiting-decision`, and the orchestrator exited before `approve-${round}`: nothing
   * committed, nothing integrated, and a Task parked on a decision the operator had already made.
   */
  it("reports the last step completed again when its own step body re-runs", async () => {
    const p = await pipeline("terminal-replay", [{ gate: "human", advanceOn: "review" }]);
    const approvalId = await decide(p, "approve");

    const call = {
      taskId: p.taskId,
      fromStepId: stepId(p, 0),
      signal: "review" as const,
      producedChanges: true,
      handoff: "Built and reviewed.",
    };

    const first = await advanceTaskWorkflow(db, p.workspaceId, call);
    expect(first.ok && first.data.status).toBe("completed");

    // Byte-identical arguments: this is a retry of the same durable step, not a new request.
    const replay = await advanceTaskWorkflow(db, p.workspaceId, call);
    expect(replay.ok && replay.data.status).toBe("completed");

    // And it spent nothing the second time — the decision on record is still that one approval,
    // and the cursor is still on the Step whose gate it opened.
    const row = await taskRow(p.taskId);
    expect(row.workflowDecisionId).toBe(approvalId);
    expect(row.workflowStepId).toBe(stepId(p, 0));
  });

  it("still refuses to finish the last step when the only decision is a refusal", async () => {
    // The inverse, so the branch above cannot be read as "any recorded decision finishes it".
    const p = await pipeline("terminal-reject", [{ gate: "human", advanceOn: "review" }]);
    await decide(p, "reject");

    const result = await advanceTaskWorkflow(db, p.workspaceId, {
      taskId: p.taskId,
      fromStepId: stepId(p, 0),
      signal: "review",
      producedChanges: true,
      handoff: undefined,
    });
    expect(result.ok && result.data.status).toBe("awaiting-decision");
  });

  it("leaves another workspace's task alone", async () => {
    const mine = await pipeline("clear-mine", [{ gate: "human" }, {}]);
    const theirs = await pipeline("clear-theirs", [{ gate: "human" }, {}]);
    await advanceTaskWorkflow(db, theirs.workspaceId, {
      taskId: theirs.taskId,
      fromStepId: stepId(theirs, 0),
      signal: "agent-signal",
      producedChanges: true,
      handoff: "Their summary.",
    });

    await clearTaskWorkflowPendingHandoff(db, mine.workspaceId, theirs.taskId, stepId(theirs, 0));

    expect((await taskRow(theirs.taskId)).workflowPendingHandoff).toBe("Their summary.");
  });
});

describe("loading a task's workflow run", () => {
  it("resumes on the step the last committed advance landed on, with that step's brief", async () => {
    const p = await pipeline("resume", [{}, {}, {}]);
    await advanceTaskWorkflow(db, p.workspaceId, {
      taskId: p.taskId,
      fromStepId: stepId(p, 0),
      signal: "agent-signal",
      producedChanges: false,
      handoff: "The plan is to replace the latch.",
    });

    const loaded = await loadTaskWorkflowRun(db, p.workspaceId, p.taskId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.data.currentStep.id).toBe(stepId(p, 1));
    expect(loaded.data.handoff).toBe("The plan is to replace the latch.");
    expect(loaded.data.brief).toContain("The plan is to replace the latch.");
    expect(loaded.data.brief).toContain("Do step 2.");
  });

  /**
   * A cursor that names a Step this Workflow does not contain is an error, never a silent restart
   * at Step 1 — that would re-run work an Owner has already paid an agent for, at the moment
   * nobody is watching. It is the state the orchestrator's `workflow-unresumable` path exists for.
   *
   * Reached here by re-pointing the cursor at a Step of another Workflow rather than by deleting
   * the Step it was on: `task.workflow_step_id` is a foreign key and `PRAGMA foreign_keys` is ON
   * in both the test database and the real one, so a Step row cannot vanish underneath a live
   * cursor while the constraint holds. `resumeWorkflowCursor` cannot tell the two apart — it is
   * given this Workflow's Steps and asked whether the cursor is among them — so this pins the
   * refusal, and a Step deleted by some future path that bypasses the constraint lands here too.
   */
  it("refuses a cursor naming a step this workflow does not contain", async () => {
    const p = await pipeline("orphan", [{}, {}]);

    // A second Workflow in the same Workspace, so the refusal is about the Workflow the cursor
    // belongs to rather than about tenancy — which the workspace-scoped tests above cover.
    const [other] = await db
      .insert(workflow)
      .values({ workspaceId: p.workspaceId, name: "other-wf" })
      .returning();
    const [profile] = await db
      .select({ id: agentProfile.id })
      .from(agentProfile)
      .where(eq(agentProfile.workspaceId, p.workspaceId))
      .limit(1);
    if (!other || !profile) throw new Error("failed to seed the stray workflow");
    const [stray] = await db
      .insert(workflowStep)
      .values({
        workspaceId: p.workspaceId,
        workflowId: other.id,
        rank: appendRank(null),
        name: "Stray",
        agentProfileId: profile.id,
      })
      .returning();
    if (!stray) throw new Error("failed to seed the stray step");
    await db.update(task).set({ workflowStepId: stray.id }).where(eq(task.id, p.taskId));

    const loaded = await loadTaskWorkflowRun(db, p.workspaceId, p.taskId);
    expect(loaded.ok).toBe(false);
    expect(!loaded.ok && loaded.error).toBe(WorkflowErrorCode.StepNotInWorkflow);
  });

  /** Read-only: resolving a null cursor must not make "this Task has begun its pipeline" true. */
  it("does not write the resolved cursor back to the row", async () => {
    const p = await pipeline("readonly", [{}, {}]);
    await db.update(task).set({ workflowStepId: null }).where(eq(task.id, p.taskId));

    const loaded = await loadTaskWorkflowRun(db, p.workspaceId, p.taskId);
    expect(loaded.ok && loaded.data.currentStep.id).toBe(stepId(p, 0));
    expect((await taskRow(p.taskId)).workflowStepId).toBeNull();
  });
});
