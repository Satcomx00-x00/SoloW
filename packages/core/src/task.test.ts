import { describe, expect, it } from "bun:test";
import { TaskDependencyErrorCode, TaskErrorCode, type TaskState } from "@gatecontrol/contracts";
import {
  buildCreateTaskPayload,
  buildDependencyGraph,
  canTransitionTask,
  checkDependencyEdge,
  formatDependencyCycle,
  isBlocked,
  isLaunchable,
  parseDependencyCycleMessage,
  type TaskDependencyEdge,
  unsatisfiedDependencies,
} from "./task.js";

describe("canTransitionTask", () => {
  it("allows the core loop transitions", () => {
    expect(canTransitionTask("backlog", "ready").ok).toBe(true);
    expect(canTransitionTask("ready", "running").ok).toBe(true);
    expect(canTransitionTask("running", "review").ok).toBe(true);
    expect(canTransitionTask("review", "done").ok).toBe(true);
    expect(canTransitionTask("running", "parked").ok).toBe(true);
    expect(canTransitionTask("parked", "running").ok).toBe(true);
    expect(canTransitionTask("failed", "running").ok).toBe(true); // retry
    expect(canTransitionTask("review", "running").ok).toBe(true); // request_changes
    expect(canTransitionTask("review", "ready").ok).toBe(true); // reject
  });

  it("rejects illegal transitions with a typed error", () => {
    const cases: [TaskState, TaskState][] = [
      ["backlog", "running"],
      ["ready", "done"],
      ["done", "running"],
      ["running", "done"],
      ["parked", "review"],
    ];
    for (const [from, to] of cases) {
      const r = canTransitionTask(from, to);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe(TaskErrorCode.IllegalTransition);
    }
  });
});

describe("buildCreateTaskPayload", () => {
  it("stamps workspaceId and starts at backlog", () => {
    const r = buildCreateTaskPayload(
      {
        issueId: "i1",
        title: "T",
        agentProfileId: "a1",
        executorProfileId: "e1",
        repositoryId: "r1",
      },
      { workspaceId: "w1" },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.workspaceId).toBe("w1");
      expect(r.data.state).toBe("backlog");
    }
  });
});

describe("isLaunchable", () => {
  it("only ready is launchable", () => {
    expect(isLaunchable("ready")).toBe(true);
    expect(isLaunchable("backlog")).toBe(false);
    expect(isLaunchable("running")).toBe(false);
  });
});

/**
 * Dependency graph (issue #6). Cycle detection is the part with teeth: an edge that would close
 * a cycle must be refused, and an edge that merely *looks* like one — a diamond, a redundant
 * shortcut, a lookalike in a disconnected component — must not be.
 */

/** `a <- b` reads "a is blocked by b", the direction the stored edge points. */
function edge(taskId: string, blockedByTaskId: string): TaskDependencyEdge {
  return { taskId, blockedByTaskId };
}

/** The offending path, or null when the edge was accepted. */
function cyclePath(edges: TaskDependencyEdge[], candidate: TaskDependencyEdge) {
  const result = checkDependencyEdge(buildDependencyGraph(edges), candidate);
  if (result.ok) return null;
  expect(result.error.code).toBe(TaskDependencyErrorCode.Cycle);
  return result.error.path;
}

describe("checkDependencyEdge", () => {
  it("refuses a Task that would block itself", () => {
    expect(cyclePath([], edge("a", "a"))).toEqual(["a", "a"]);
  });

  it("refuses the second edge of a two-cycle and names both hops", () => {
    expect(cyclePath([edge("a", "b")], edge("b", "a"))).toEqual(["b", "a", "b"]);
  });

  it("refuses an edge that closes a long chain and names every hop in order", () => {
    const chain = [edge("a", "b"), edge("b", "c"), edge("c", "d")];
    expect(cyclePath(chain, edge("d", "a"))).toEqual(["d", "a", "b", "c", "d"]);
  });

  it("accepts a diamond, which is not a cycle", () => {
    // a is blocked by both b and c; both are blocked by d. Every edge is legal.
    expect(cyclePath([], edge("a", "b"))).toBeNull();
    expect(cyclePath([edge("a", "b")], edge("a", "c"))).toBeNull();
    const diamond = [edge("a", "b"), edge("a", "c"), edge("b", "d")];
    expect(cyclePath(diamond, edge("c", "d"))).toBeNull();
  });

  it("accepts a redundant edge into an already-reachable Task", () => {
    // a is already transitively blocked by c; saying so directly closes nothing.
    expect(cyclePath([edge("a", "b"), edge("b", "c")], edge("a", "c"))).toBeNull();
  });

  it("does not see a cycle across two disconnected components", () => {
    // x <- y <- x is a cycle over there; it says nothing about a <- b over here.
    const other = [edge("x", "y"), edge("y", "z"), edge("z", "x")];
    expect(cyclePath(other, edge("a", "b"))).toBeNull();
  });

  it("accepts any non-self edge in an empty graph", () => {
    expect(cyclePath([], edge("a", "b"))).toBeNull();
  });

  it("walks a 5000-deep chain without overflowing the stack", () => {
    // Depth is Owner-authored data with no bound, so the DFS must be iterative. A recursive one
    // fails this test by crashing rather than by returning the wrong answer.
    const deep = Array.from({ length: 5000 }, (_, i) => edge(`n${i}`, `n${i + 1}`));
    expect(cyclePath(deep, edge("n5000", "n0"))).toHaveLength(5002);
    expect(cyclePath(deep, edge("n0", "n5000"))).toBeNull();
  });
});

describe("unsatisfiedDependencies", () => {
  it("reports nothing when every predecessor is done", () => {
    const deps = [
      { blockedByTaskId: "b", blockedByState: "done" as const },
      { blockedByTaskId: "c", blockedByState: "done" as const },
    ];
    expect(unsatisfiedDependencies(deps)).toEqual([]);
    expect(isBlocked(deps)).toBe(false);
  });

  it("reports only the predecessors that have not reached done", () => {
    const deps = [
      { blockedByTaskId: "b", blockedByState: "done" as const },
      { blockedByTaskId: "c", blockedByState: "running" as const },
      { blockedByTaskId: "d", blockedByState: "backlog" as const },
    ];
    expect(unsatisfiedDependencies(deps).map((d) => d.blockedByTaskId)).toEqual(["c", "d"]);
    expect(isBlocked(deps)).toBe(true);
  });

  it("treats a Task with no dependencies as unblocked", () => {
    expect(unsatisfiedDependencies([])).toEqual([]);
    expect(isBlocked([])).toBe(false);
  });
});

describe("formatDependencyCycle / parseDependencyCycleMessage", () => {
  it("round-trips a path through the error message", () => {
    const path = ["a", "b", "c", "a"];
    const message = `${TaskDependencyErrorCode.Cycle}: ${formatDependencyCycle(path)}`;
    expect(message).toBe("TASK_DEPENDENCY_CYCLE: a → b → c → a");
    expect(parseDependencyCycleMessage(message)).toEqual(path);
  });

  it("returns null for an error that is not a cycle", () => {
    expect(parseDependencyCycleMessage(TaskErrorCode.NotReady)).toBeNull();
    expect(parseDependencyCycleMessage("TASK_DEPENDENCY_CYCLE: a")).toBeNull();
  });
});
