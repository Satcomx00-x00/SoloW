import { describe, expect, it } from "bun:test";
import type { WorkflowStepDto } from "@solow/contracts";
import {
  branchRetarget,
  END_NODE_ID,
  END_NODE_Y,
  endNodePosition,
  nextStepName,
  placeSteps,
  reorderFromDrop,
  roundedPath,
  START_NODE_ID,
  START_NODE_WIDTH,
  STEP_NODE_GAP,
  STEP_NODE_WIDTH,
  startNodePosition,
  stepDotColor,
  stepDotColors,
  stepEdges,
  stepHue,
} from "./workflow-canvas";

const AT = "2026-08-20T00:00:00.000Z";

function step(id: string, rank: string): WorkflowStepDto {
  return {
    id,
    workflowId: "wf-1",
    name: id,
    position: 0,
    rank,
    agentProfileId: "ap-1",
    promptTemplate: "",
    gate: "human",
    advanceOn: "review",
    onEnter: null,
    branch: null,
    createdAt: AT,
    updatedAt: AT,
  };
}

// Deliberately out of rank order, so a test that passed by array order would fail here.
const STEPS = [step("s2", "2"), step("s3", "3"), step("s1", "1")];
const PITCH = STEP_NODE_WIDTH + STEP_NODE_GAP;

describe("placeSteps", () => {
  it("lays the Steps out left to right by rank, one row", () => {
    const placed = placeSteps(STEPS);
    expect(placed.map((p) => p.step.id)).toEqual(["s1", "s2", "s3"]);
    expect(placed.map((p) => p.x)).toEqual([0, PITCH, 2 * PITCH]);
    expect(placed.every((p) => p.y === 0)).toBe(true);
  });
});

describe("stepEdges", () => {
  it("enters at the first step, chains the rest in rank order, and leaves the last for the end", () => {
    expect(stepEdges(STEPS)).toEqual([
      { id: "start:next", source: START_NODE_ID, target: "s1", kind: "start", adjacent: true },
      { id: "s1:next", source: "s1", target: "s2", kind: "next", adjacent: true },
      { id: "s2:next", source: "s2", target: "s3", kind: "next", adjacent: true },
      { id: "s3:next", source: "s3", target: END_NODE_ID, kind: "next", adjacent: true },
    ]);
  });

  it("gives a branching step a yes edge and a no edge instead of its rank successor", () => {
    const branched = STEPS.map((s) =>
      s.id === "s1"
        ? {
            ...s,
            branch: {
              when: { kind: "agent-decides" as const, question: "Design first?" },
              thenStepId: "s3",
              elseStepId: "s2",
            },
          }
        : s,
    );
    const edges = stepEdges(branched).filter((e) => e.source === "s1");
    expect(edges).toEqual([
      // s3 is two ahead: routed around the row rather than drawn through s2.
      { id: "s1:then", source: "s1", target: "s3", kind: "then", adjacent: false },
      { id: "s1:else", source: "s1", target: "s2", kind: "else", adjacent: true },
    ]);
  });

  it("draws a null target as an edge to the end, and a backward target as one that loops", () => {
    const branched = STEPS.map((s) =>
      s.id === "s3"
        ? {
            ...s,
            branch: {
              when: { kind: "produced-changes" as const },
              thenStepId: "s1",
              elseStepId: null,
            },
          }
        : s,
    );
    const edges = stepEdges(branched).filter((e) => e.source === "s3");
    expect(edges).toEqual([
      { id: "s3:then", source: "s3", target: "s1", kind: "then", adjacent: false },
      { id: "s3:else", source: "s3", target: END_NODE_ID, kind: "else", adjacent: true },
    ]);
  });

  it("draws no entry edge for an empty pipeline — there is nothing to enter", () => {
    expect(stepEdges([])).toEqual([]);
  });

  it("places the end one pitch past the last step and the start one gap before the first, on the main line", () => {
    expect(endNodePosition(STEPS)).toEqual({ x: 3 * PITCH, y: END_NODE_Y });
    expect(endNodePosition([])).toEqual({ x: 0, y: END_NODE_Y });
    expect(startNodePosition()).toEqual({ x: -(STEP_NODE_GAP + START_NODE_WIDTH), y: END_NODE_Y });
  });
});

describe("reorderFromDrop", () => {
  it("swaps Step 1 with Step 2 when Step 1 is dropped past Step 2's left edge", () => {
    expect(reorderFromDrop(STEPS, "s1", PITCH + 10)).toEqual({
      stepId: "s1",
      afterStepId: "s2",
      beforeStepId: "s3",
    });
  });

  it("sends nulls for the ends", () => {
    expect(reorderFromDrop(STEPS, "s3", -50)).toEqual({
      stepId: "s3",
      afterStepId: null,
      beforeStepId: "s1",
    });
    expect(reorderFromDrop(STEPS, "s1", 5 * PITCH)).toEqual({
      stepId: "s1",
      afterStepId: "s3",
      beforeStepId: null,
    });
  });

  it("is a no-op for a nudge that lands the node where it was", () => {
    expect(reorderFromDrop(STEPS, "s2", PITCH + 40)).toBeNull();
    expect(reorderFromDrop(STEPS, "s2", PITCH - 40)).toBeNull();
  });

  it("is a no-op for a node the list does not contain", () => {
    expect(reorderFromDrop(STEPS, "ghost", 0)).toBeNull();
  });
});

describe("nextStepName", () => {
  it("skips a number a step already carries, so no two steps are born with one name", () => {
    const named = (...names: string[]) =>
      names.map((name, i) => ({ ...step(`s${i}`, `${i}`), name }));
    expect(nextStepName(named("Step 1", "Step 2"))).toBe("Step 3");
    // Two steps, one of them already "Step 3": the third must not be a second "Step 3".
    expect(nextStepName(named("Step 1", "Step 3"))).toBe("Step 4");
    expect(nextStepName(named("step 1", "STEP 3"))).toBe("Step 4");
  });
});

describe("roundedPath", () => {
  it("draws a straight line with no corners as a line", () => {
    expect(
      roundedPath(
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ],
        8,
      ),
    ).toBe("M 0 0 L 10 0");
  });

  it("cuts each corner short on both sides and curves through it", () => {
    const path = roundedPath(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
      10,
    );
    expect(path).toBe("M 0 0 L 90 0 Q 100 0 100 10 L 100 100");
  });

  it("never overshoots a segment shorter than two radii", () => {
    // The middle segment is 10 long; a 20 radius must share it, 5 each side.
    const path = roundedPath(
      [
        { x: 0, y: 0 },
        { x: 50, y: 0 },
        { x: 50, y: 10 },
        { x: 100, y: 10 },
      ],
      20,
    );
    expect(path).toBe("M 0 0 L 45 0 Q 50 0 50 5 L 50 5 Q 50 10 55 10 L 100 10");
  });
});

describe("the Step dot", () => {
  it("is the same colour for the same step, whatever its position", () => {
    expect(stepHue("s1")).toBe(stepHue("s1"));
    expect(stepDotColor("6db6596b-0f90-4c95-a967-7cb6627f54b2")).toBe(
      stepDotColor("6db6596b-0f90-4c95-a967-7cb6627f54b2"),
    );
  });

  it("is one of twelve hues, 30° apart", () => {
    for (const id of ["a", "b", "s1", "s2", "6db6596b-0f90-4c95-a967-7cb6627f54b2"]) {
      const hue = stepHue(id);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
      expect(hue % 30).toBe(0);
    }
  });

  it("gives siblings that hash alike different hues, and keeps every other colour put", () => {
    // Any id whose hue matches the first one's — found by search, so the fixture cannot rot when
    // the hash changes. The later-created one is the one that yields.
    const a = { ...step("a", "1"), id: "step-a", createdAt: "2026-01-01T00:00:00Z" };
    const twin = Array.from({ length: 200 }, (_, i) => `step-${i}`).find(
      (id) => id !== a.id && stepHue(id) === stepHue(a.id),
    );
    if (!twin) throw new Error("no colliding id found for the fixture");
    const b = { ...step("b", "2"), id: twin, createdAt: "2026-01-02T00:00:00Z" };
    const colors = stepDotColors([b, a]);
    expect(colors.get(a.id)).toBe(stepDotColor(a.id));
    expect(colors.get(b.id)).not.toBe(colors.get(a.id));
    // Reordering changes nothing; deleting the yielder changes nothing for the rest.
    expect(stepDotColors([a, b]).get(b.id)).toBe(colors.get(b.id));
    expect(stepDotColors([a]).get(a.id)).toBe(colors.get(a.id));
  });

  it("never lets two of up to twelve siblings share a hue", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...step(`s${i}`, `${i}`),
      createdAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    }));
    const hues = [...stepDotColors(many).values()];
    expect(new Set(hues).size).toBe(12);
  });

  it("tells near-identical ids apart", () => {
    // Two uuids that differ in one character: a hash that folded them together would give a
    // pipeline of freshly inserted Steps one colour.
    expect(stepHue("6db6596b-0f90-4c95-a967-7cb6627f54b2")).not.toBe(
      stepHue("6db6596b-0f90-4c95-a967-7cb6627f54b3"),
    );
  });
});

describe("branchRetarget", () => {
  it("reads a drag from a yes or no exit onto a step as that exit's new target", () => {
    expect(branchRetarget({ source: "s1", sourceHandle: "then", target: "s3" })).toEqual({
      stepId: "s1",
      exit: "then",
      targetStepId: "s3",
    });
    expect(branchRetarget({ source: "s3", sourceHandle: "else", target: "s1" })).toEqual({
      stepId: "s3",
      exit: "else",
      targetStepId: "s1",
    });
  });

  it("reads a drag onto the end as the pipeline ending there", () => {
    expect(branchRetarget({ source: "s1", sourceHandle: "then", target: END_NODE_ID })).toEqual({
      stepId: "s1",
      exit: "then",
      targetStepId: null,
    });
  });

  it("refuses every drag that is not a branch exit onto another step or the end", () => {
    // The plain exit is the rank order, not a thing to re-point.
    expect(branchRetarget({ source: "s1", sourceHandle: "next", target: "s2" })).toBeNull();
    // The start has nothing to re-point and cannot be pointed at.
    expect(branchRetarget({ source: START_NODE_ID, sourceHandle: null, target: "s1" })).toBeNull();
    expect(
      branchRetarget({ source: "s1", sourceHandle: "then", target: START_NODE_ID }),
    ).toBeNull();
    // A Step is not its own target; the server would refuse it, the line says so first.
    expect(branchRetarget({ source: "s1", sourceHandle: "else", target: "s1" })).toBeNull();
    // A drag let go over nothing.
    expect(branchRetarget({ source: "s1", sourceHandle: "then", target: null })).toBeNull();
  });
});

describe("nextStepName", () => {
  it("numbers the new Step after the ones there are", () => {
    expect(nextStepName([])).toBe("Step 1");
    expect(nextStepName(STEPS)).toBe("Step 4");
  });
});
