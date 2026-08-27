import { describe, expect, it } from "bun:test";
import { TaskDependencyErrorCode, TaskErrorCode, type TaskState } from "@solow/contracts";
import {
  buildCreateTaskPayload,
  buildDependencyGraph,
  canTransitionTask,
  checkDependencyEdge,
  formatDependencyCycle,
  isBlocked,
  isLaunchable,
  nextTaskState,
  parseDependencyCycleMessage,
  previousTaskState,
  primaryTaskRepository,
  type TaskDependencyEdge,
  taskCheckoutBranch,
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

/**
 * Stepping a Task along the lifecycle from the Task page (the header's back/forward arrows).
 *
 * The property under test is that stepping is *derived from* `TRANSITIONS` and the column order,
 * not listed separately. That is the whole point: an arrow that offers a move the server then
 * refuses is worse than no arrow, and the only way the two can stay in agreement as the
 * lifecycle grows is for there to be one statement of it. So these cases assert the seven states
 * in both directions against the transition table's own answer, and pin the four that carry
 * real product meaning — a Task under review moves on to `done`, back to `running`; a `running`
 * Task has nowhere to retreat to; `done` is terminal in both directions.
 */
describe("nextTaskState / previousTaskState", () => {
  const states: TaskState[] = ["backlog", "ready", "running", "review", "parked", "failed", "done"];

  it("steps forward to the nearest legal state ahead", () => {
    const forward: Record<TaskState, TaskState | null> = {
      backlog: "ready",
      ready: "running",
      // Not `done`: `running` may also go to `parked` or `failed`, and the arrow offers the
      // nearest of them, never a fast-forward past the states in between.
      running: "review",
      review: "done",
      // `failed` is where a Task leaves the line, not the state after `parked`. A Task parked on
      // a quota window resumes by itself, so a forward arrow offering "give up on this" as its
      // only meaning is worse than no arrow at all.
      parked: null,
      failed: null,
      done: null,
    };
    for (const state of states) expect(nextTaskState(state)).toBe(forward[state]);
  });

  it("steps back to the nearest legal state behind", () => {
    const back: Record<TaskState, TaskState | null> = {
      backlog: null,
      ready: "backlog",
      // `running` has three exits and every one of them is further along, so there is no way back.
      running: null,
      review: "running",
      parked: "running",
      failed: "running",
      done: null,
    };
    for (const state of states) expect(previousTaskState(state)).toBe(back[state]);
  });

  it("never offers a step the transition table would refuse", () => {
    // The invariant the derivation exists to guarantee: whatever an arrow proposes, the same
    // rule that governs a drag on the board has to accept it.
    for (const state of states) {
      for (const to of [nextTaskState(state), previousTaskState(state)]) {
        if (to === null) continue;
        expect(canTransitionTask(state, to).ok).toBe(true);
      }
    }
  });

  it("leaves the terminal state with nowhere to go", () => {
    expect(nextTaskState("done")).toBeNull();
    expect(previousTaskState("done")).toBeNull();
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
        repositories: [{ repositoryId: "r1" }],
      },
      { workspaceId: "w1" },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.workspaceId).toBe("w1");
      expect(r.data.state).toBe("backlog");
      expect(r.data.repositories).toEqual([{ repositoryId: "r1" }]);
    }
  });
});

/**
 * The Task ↔ Repository join, from the pure side (issue #7). Both functions exist so that
 * "which branch" and "which worktree does the agent run in" have exactly one answer each, and
 * that answer is testable without a database.
 */
describe("taskCheckoutBranch", () => {
  it("derives the branch a Task's worktree sits on from the Task id alone", () => {
    expect(taskCheckoutBranch("abc")).toBe("solow/task-abc");
  });

  it("is deterministic, which is what makes provisioning idempotent across relaunches", () => {
    expect(taskCheckoutBranch("abc")).toBe(taskCheckoutBranch("abc"));
    expect(taskCheckoutBranch("abc")).not.toBe(taskCheckoutBranch("abd"));
  });
});

describe("primaryTaskRepository", () => {
  it("returns the position-0 attachment whatever order the list arrives in", () => {
    // The agent runs in exactly one working directory, so this decides which. Deciding it by
    // array order would make a re-sorted list start the agent somewhere else.
    const attachments = [
      { id: "b", position: 2 },
      { id: "a", position: 0 },
      { id: "c", position: 1 },
    ];
    expect(primaryTaskRepository(attachments).id).toBe("a");
    expect(primaryTaskRepository([...attachments].reverse()).id).toBe("a");
  });

  it("returns the sole attachment of a single-Repository Task", () => {
    expect(primaryTaskRepository([{ id: "only", position: 0 }]).id).toBe("only");
  });

  it("throws rather than returning undefined when nothing is attached", () => {
    // A Task with no attachment cannot be run at all. Returning undefined would move the failure
    // to whichever caller forgot to check, three steps later, with nothing left to point at.
    expect(() => primaryTaskRepository([])).toThrow(/no repository attached/);
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
