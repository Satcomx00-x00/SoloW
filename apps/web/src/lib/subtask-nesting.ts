import type { TaskDto } from "@solow/contracts";

/**
 * How deep a column indents sub-tasks before it stops. A column is 288px wide, and a card pushed
 * in much further than this stops having room for its own title — the chain is still in order
 * past it, it just stops stepping right.
 */
export const MAX_SUBTASK_INDENT = 2;

/** One card in a column, in the order the column draws it. */
export interface NestedCard {
  task: TaskDto;
  /**
   * How many of its ancestors sit directly above it in this column, capped at
   * `MAX_SUBTASK_INDENT`. Zero for a top-level Task, and for a sub-task whose parent is in
   * another column — which is what the card's own "Split from" line is for.
   */
  depth: number;
  /** Whether the Task this one was split from is drawn above it, in this same column. */
  parentAbove: boolean;
}

/**
 * A column's cards, with each sub-task folded directly under its parent (issue #56).
 *
 * Only within the column. A sub-task is a Task with its own lifecycle, so a child that has moved
 * on to Review while its parent is still Running sits in Review — pulling it back beside its
 * parent would put a card under a column heading that is not true of it. What a column *can* say
 * is "these two are related" when both happen to be in it, and that is all this does.
 *
 * The column's own order is otherwise kept: a top-level card stays where the list put it, and a
 * parent's children follow it in the order they arrived. A child whose parent is elsewhere is
 * top-level here. `seen` bounds the walk, so a parent chain that is somehow cyclic is drawn once
 * rather than looped on.
 */
export function nestSubtasks(tasks: readonly TaskDto[]): NestedCard[] {
  const here = new Set(tasks.map((t) => t.id));
  const children = new Map<string, TaskDto[]>();
  for (const t of tasks) {
    if (t.parentTaskId === null || !here.has(t.parentTaskId)) continue;
    const siblings = children.get(t.parentTaskId);
    if (siblings) siblings.push(t);
    else children.set(t.parentTaskId, [t]);
  }

  const out: NestedCard[] = [];
  const seen = new Set<string>();
  const visit = (t: TaskDto, depth: number, parentAbove: boolean) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    out.push({ task: t, depth: Math.min(depth, MAX_SUBTASK_INDENT), parentAbove });
    for (const child of children.get(t.id) ?? []) visit(child, depth + 1, true);
  };
  for (const t of tasks) {
    const nestedHere = t.parentTaskId !== null && here.has(t.parentTaskId);
    if (!nestedHere) visit(t, 0, false);
  }
  // Whatever is left sits on a cycle with no root in this column: drawn flat, never dropped.
  for (const t of tasks) visit(t, 0, false);
  return out;
}
