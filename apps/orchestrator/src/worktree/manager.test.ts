import { describe, expect, it } from "bun:test";
import { worktreeBranch, worktreePath } from "./manager.js";

describe("worktree naming", () => {
  it("branch and path are deterministic and task-scoped", () => {
    expect(worktreeBranch("t1")).toBe("gatecontrol/task-t1");
    expect(worktreePath("/wt", "t1")).toBe("/wt/t1");
    expect(worktreeBranch("a")).not.toBe(worktreeBranch("b"));
  });
});
