/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { WorkflowErrorCode, type WorkflowStepGate } from "@gatecontrol/contracts";
import {
  advanceWorkflowStep,
  appendRank,
  buildStepBrief,
  rankBetween,
  rankForMove,
  resumeWorkflowCursor,
  sortSteps,
  type WorkflowStepOutcome,
  type WorkflowStepRule,
} from "./workflow.js";

/**
 * Workflow rules (issue #5). Every assertion here is about behaviour a caller can observe: the
 * order a list comes out in, which Step a cursor lands on, whether a Task is allowed to finish.
 */

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected ok, got ${String(result.error)}`);
  return result.data;
}

function step(
  id: string,
  rank: string,
  gate: WorkflowStepGate = "auto",
  advanceOn: WorkflowStepRule["advanceOn"] = "agent-signal",
): WorkflowStepRule {
  return { id, rank, gate, advanceOn };
}

/** A three-Step pipeline in the shape the issue describes: plan → implement → review. */
function pipeline(gate: WorkflowStepGate = "auto"): WorkflowStepRule[] {
  const a = appendRank(null);
  const b = appendRank(a);
  const c = appendRank(b);
  return [step("plan", a, gate), step("implement", b, gate), step("review", c, gate)];
}

function outcome(over: Partial<WorkflowStepOutcome> = {}): WorkflowStepOutcome {
  return { signal: "agent-signal", producedChanges: false, unspentApproval: false, ...over };
}

describe("workflow step ordering", () => {
  it("gives a rank that sorts strictly between its two neighbours", () => {
    const low = appendRank(null);
    const high = appendRank(low);
    const middle = unwrap(rankBetween(low, high));
    expect(low < middle).toBe(true);
    expect(middle < high).toBe(true);
  });

  it("appends after the last step without consulting any other step", () => {
    const first = appendRank(null);
    const second = appendRank(first);
    const third = appendRank(second);
    expect([first, second, third]).toEqual([...[first, second, third]].sort());
  });

  it("keeps a hundred successive inserts into the same gap strictly ordered", () => {
    const low = appendRank(null);
    const high = appendRank(low);
    // Every insert lands immediately after `low`, the worst case for a midpoint scheme: each new
    // rank has to fall between the previous insert and the one before it, forever.
    let previous = high;
    const inserted: string[] = [];
    for (let n = 0; n < 100; n += 1) {
      previous = unwrap(rankBetween(low, previous));
      inserted.push(previous);
    }
    for (const rank of inserted) {
      expect(low < rank).toBe(true);
      expect(rank < high).toBe(true);
    }
    // Newest first, because each one was inserted below its predecessor.
    expect(inserted).toEqual([...inserted].sort().reverse());
    expect(new Set(inserted).size).toBe(100);
  });

  it("keeps a hundred successive inserts at the head of the list strictly ordered", () => {
    let head = appendRank(null);
    const heads: string[] = [head];
    for (let n = 0; n < 100; n += 1) {
      head = unwrap(rankBetween(null, head));
      heads.push(head);
    }
    expect(heads).toEqual([...heads].sort().reverse());
    expect(new Set(heads).size).toBe(101);
  });

  it("refuses a rank between neighbours given in the wrong order", () => {
    const low = appendRank(null);
    const high = appendRank(low);
    const result = rankBetween(high, low);
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error).toBe(WorkflowErrorCode.StaleOrder);
  });

  it("refuses a rank between a neighbour and itself", () => {
    const only = appendRank(null);
    expect(rankBetween(only, only).ok).toBe(false);
  });

  it("sorts steps by rank rather than by the order they were handed over", () => {
    const [a, b, c] = pipeline();
    if (!a || !b || !c) throw new Error("pipeline");
    expect(sortSteps([c, a, b]).map((s) => s.id)).toEqual(["plan", "implement", "review"]);
  });
});

describe("moving a step", () => {
  it("places a step between the two neighbours it was dropped between", () => {
    const steps = pipeline();
    const moved = unwrap(
      rankForMove(steps, { stepId: "review", afterStepId: "plan", beforeStepId: "implement" }),
    );
    const after = sortSteps(steps.map((s) => (s.id === "review" ? { ...s, rank: moved } : s)));
    expect(after.map((s) => s.id)).toEqual(["plan", "review", "implement"]);
  });

  it("places a step at the head when it is dropped before the first one", () => {
    const steps = pipeline();
    const moved = unwrap(
      rankForMove(steps, { stepId: "review", afterStepId: null, beforeStepId: "plan" }),
    );
    const after = sortSteps(steps.map((s) => (s.id === "review" ? { ...s, rank: moved } : s)));
    expect(after.map((s) => s.id)).toEqual(["review", "plan", "implement"]);
  });

  it("places a step at the tail when it is dropped after the last one", () => {
    const steps = pipeline();
    const moved = unwrap(
      rankForMove(steps, { stepId: "plan", afterStepId: "review", beforeStepId: null }),
    );
    const after = sortSteps(steps.map((s) => (s.id === "plan" ? { ...s, rank: moved } : s)));
    expect(after.map((s) => s.id)).toEqual(["implement", "review", "plan"]);
  });

  it("refuses a move whose named neighbours are not adjacent any more", () => {
    const steps = pipeline();
    // `plan` and `review` have `implement` between them: the caller was looking at a stale list.
    const result = rankForMove(steps, {
      stepId: "implement",
      afterStepId: "plan",
      beforeStepId: "review",
    });
    // `implement` is excluded from the neighbour check, so this pair *is* adjacent for it.
    expect(result.ok).toBe(true);

    const stale = rankForMove(steps, {
      stepId: "plan",
      afterStepId: "implement",
      beforeStepId: null,
    });
    expect(stale.ok).toBe(false);
    expect(stale.ok ? null : stale.error).toBe(WorkflowErrorCode.StaleOrder);
  });

  it("refuses a move naming a step from another workflow", () => {
    const steps = pipeline();
    const result = rankForMove(steps, {
      stepId: "plan",
      afterStepId: "someone-elses-step",
      beforeStepId: null,
    });
    expect(result.ok ? null : result.error).toBe(WorkflowErrorCode.StepNotInWorkflow);
  });
});

describe("resuming a workflow", () => {
  it("resumes at the cursor rather than at the first step", () => {
    const steps = pipeline();
    expect(unwrap(resumeWorkflowCursor(steps, "implement")).id).toBe("implement");
  });

  it("starts at the first step when the task has no cursor yet", () => {
    expect(unwrap(resumeWorkflowCursor(pipeline(), null)).id).toBe("plan");
  });

  it("treats a cursor whose step no longer exists as an error, never a silent restart", () => {
    const steps = pipeline().filter((s) => s.id !== "implement");
    const result = resumeWorkflowCursor(steps, "implement");
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error).toBe(WorkflowErrorCode.StepNotInWorkflow);
  });

  it("refuses to resume a workflow with no steps at all", () => {
    const result = resumeWorkflowCursor([], null);
    expect(result.ok ? null : result.error).toBe(WorkflowErrorCode.Empty);
  });
});

describe("advancing a task through its steps", () => {
  it("moves an auto-gated middle step on to the next one when the agent signals", () => {
    const advance = unwrap(advanceWorkflowStep(pipeline("auto"), "plan", outcome()));
    expect(advance).toEqual({ status: "advanced", stepId: "implement", consumedApproval: false });
  });

  it("holds a human-gated step until a decision is recorded, however the agent signalled", () => {
    const steps = pipeline("human");
    expect(unwrap(advanceWorkflowStep(steps, "plan", outcome())).status).toBe("awaiting-decision");
    const decided = unwrap(advanceWorkflowStep(steps, "plan", outcome({ unspentApproval: true })));
    expect(decided).toEqual({ status: "advanced", stepId: "implement", consumedApproval: true });
  });

  it("lets auto-unless-changes through when the step produced nothing to look at", () => {
    const steps = pipeline("auto-unless-changes");
    const clean = unwrap(advanceWorkflowStep(steps, "plan", outcome({ producedChanges: false })));
    expect(clean).toEqual({ status: "advanced", stepId: "implement", consumedApproval: false });
  });

  it("stops auto-unless-changes when the step did produce changes", () => {
    const steps = pipeline("auto-unless-changes");
    const dirty = unwrap(advanceWorkflowStep(steps, "plan", outcome({ producedChanges: true })));
    expect(dirty).toEqual({
      status: "awaiting-decision",
      stepId: "plan",
      consumedApproval: false,
    });
    const decided = unwrap(
      advanceWorkflowStep(steps, "plan", outcome({ producedChanges: true, unspentApproval: true })),
    );
    expect(decided.status).toBe("advanced");
    expect(decided.consumedApproval).toBe(true);
  });

  it("leaves the cursor alone when the signal is not the one the step advances on", () => {
    const steps = [
      step("plan", "1", "auto", "review"),
      step("implement", "2", "auto", "agent-signal"),
    ];
    const held = unwrap(advanceWorkflowStep(steps, "plan", outcome({ signal: "agent-signal" })));
    expect(held).toEqual({ status: "held", stepId: "plan", consumedApproval: false });
  });

  it("advances a review-gated step when the review signal arrives", () => {
    const steps = [
      step("plan", "1", "human", "review"),
      step("implement", "2", "auto", "agent-signal"),
    ];
    const advance = unwrap(
      advanceWorkflowStep(steps, "plan", outcome({ signal: "review", unspentApproval: true })),
    );
    expect(advance).toEqual({ status: "advanced", stepId: "implement", consumedApproval: true });
  });

  it("refuses to advance a step that is not in the workflow", () => {
    const result = advanceWorkflowStep(pipeline(), "not-a-step", outcome());
    expect(result.ok ? null : result.error).toBe(WorkflowErrorCode.StepNotInWorkflow);
  });

  // Principle I / AC-4. Asserted for all three gates so the invariant is the rule rather than
  // one branch's accident.
  it.each<WorkflowStepGate>(["auto", "auto-unless-changes", "human"])(
    "never completes the last step without a recorded human decision, whatever its gate (%s)",
    (gate) => {
      const steps = pipeline(gate);
      const undecided = unwrap(advanceWorkflowStep(steps, "review", outcome()));
      expect(undecided).toEqual({
        status: "awaiting-decision",
        stepId: "review",
        consumedApproval: false,
      });

      const decided = unwrap(
        advanceWorkflowStep(steps, "review", outcome({ unspentApproval: true })),
      );
      expect(decided).toEqual({
        status: "completed",
        stepId: "review",
        consumedApproval: true,
      });
    },
  );

  it("still requires a decision at the last step of a single-step workflow", () => {
    const steps = [step("only", appendRank(null), "auto")];
    expect(unwrap(advanceWorkflowStep(steps, "only", outcome())).status).toBe("awaiting-decision");
  });

  /**
   * The other half of Principle I, and the half that was missing: an approval is spent on the
   * gate it opens. Every branch that leans on one has to say so, or one decision releases the
   * rest of the pipeline and the invariant degrades to "somebody looked at this Task once".
   */
  it.each<WorkflowStepGate>(["human", "auto-unless-changes"])(
    "spends the approval on the gate it opens, so the next gate needs its own (%s)",
    (gate) => {
      const steps = pipeline(gate);
      const first = unwrap(
        advanceWorkflowStep(
          steps,
          "plan",
          outcome({ producedChanges: true, unspentApproval: true }),
        ),
      );
      expect(first.status).toBe("advanced");
      expect(first.consumedApproval).toBe(true);

      // The caller marks it spent, so the same approval is no longer on offer at the next Step.
      const second = unwrap(
        advanceWorkflowStep(
          steps,
          "implement",
          outcome({ producedChanges: true, unspentApproval: false }),
        ),
      );
      expect(second).toEqual({
        status: "awaiting-decision",
        stepId: "implement",
        consumedApproval: false,
      });
    },
  );

  it("spends nothing on an auto gate, so a pipeline of them still costs exactly one decision", () => {
    const steps = pipeline("auto");
    const advance = unwrap(advanceWorkflowStep(steps, "plan", outcome({ unspentApproval: true })));
    expect(advance).toEqual({ status: "advanced", stepId: "implement", consumedApproval: false });
  });
});

describe("the handoff brief", () => {
  it("leads with the previous step's handoff and then the step's own prompt", () => {
    const brief = buildStepBrief({ promptTemplate: "Implement the plan." }, "The plan is X.");
    expect(brief.indexOf("The plan is X.")).toBeLessThan(brief.indexOf("Implement the plan."));
    expect(brief).toContain("Implement the plan.");
  });

  it("carries no handoff preamble on the first step", () => {
    expect(buildStepBrief({ promptTemplate: "Draw up a plan." }, null)).toBe("Draw up a plan.");
  });

  it("treats a blank handoff as no handoff at all", () => {
    expect(buildStepBrief({ promptTemplate: "Draw up a plan." }, "   \n ")).toBe("Draw up a plan.");
  });
});
