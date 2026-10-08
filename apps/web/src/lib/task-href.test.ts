import { describe, expect, test } from "bun:test";
import { taskHref } from "./task-href";

describe("taskHref", () => {
  test("a Task at its gate lands on the Changes view", () => {
    expect(taskHref({ id: "t1", state: "review" })).toBe("/task/t1?tab=changes");
  });
  test("any other state lands on the board", () => {
    for (const state of ["ready", "running", "done"]) {
      expect(taskHref({ id: "t1", state })).toBe("/task/t1");
    }
  });
});
