/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import type { TaskDto } from "@solow/contracts";
import { MAX_SUBTASK_INDENT, nestSubtasks } from "./subtask-nesting";

/** Only the two fields the nesting reads; the rest of a Task is irrelevant to the order. */
const t = (id: string, parentTaskId: string | null = null) => ({ id, parentTaskId }) as TaskDto;

const shape = (tasks: TaskDto[]) =>
  nestSubtasks(tasks).map((card) => [card.task.id, card.depth, card.parentAbove]);

describe("nestSubtasks (issue #56)", () => {
  it("leaves a column with no sub-tasks exactly as it was", () => {
    expect(shape([t("a"), t("b"), t("c")])).toEqual([
      ["a", 0, false],
      ["b", 0, false],
      ["c", 0, false],
    ]);
  });

  it("folds each child directly under its parent, wherever the list put it", () => {
    expect(shape([t("child", "a"), t("a"), t("b"), t("grand", "child")])).toEqual([
      ["a", 0, false],
      ["child", 1, true],
      ["grand", 2, true],
      ["b", 0, false],
    ]);
  });

  it("keeps a child whose parent is in another column top-level, and says so", () => {
    expect(shape([t("orphan-here", "elsewhere"), t("b")])).toEqual([
      ["orphan-here", 0, false],
      ["b", 0, false],
    ]);
  });

  it("stops stepping right past the indent cap, but keeps the order", () => {
    const chain = [t("a"), t("b", "a"), t("c", "b"), t("d", "c")];
    const depths = nestSubtasks(chain).map((card) => card.depth);
    expect(depths).toEqual([0, 1, 2, MAX_SUBTASK_INDENT]);
  });

  it("draws every card once, even on a parent chain that is cyclic", () => {
    const cards = nestSubtasks([t("x", "y"), t("y", "x"), t("a")]);
    expect(cards.map((card) => card.task.id).sort()).toEqual(["a", "x", "y"]);
  });
});
