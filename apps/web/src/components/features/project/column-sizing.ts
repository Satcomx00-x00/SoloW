import { MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH } from "@solow/contracts";

/**
 * Column widths and column order, as pure functions over the stored arrangement.
 *
 * Extracted from the table so the rules can be proven without a DOM: what a drag resolves to, how
 * a width is clamped, and what happens to a column the stored order has never heard of are all
 * decisions, and every one of them has a wrong answer that looks fine on screen.
 */

/** Keep a width inside the bounds the schema will accept, so a drag can never store a refusal. */
export function clampWidth(width: number): number {
  return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(width)));
}

/**
 * Put columns in the person's saved order.
 *
 * A saved order is **partial on purpose**: a column added by a provider sync — or by a project
 * gaining a field yesterday — is not in an order saved last month. Those fall in behind the ones
 * the order names, keeping their own relative sequence, rather than being dropped (which would
 * hide a real column) or shoved to the front (which would rearrange a table nobody touched).
 *
 * Ids in the saved order that no longer exist are ignored, so a field the project deleted cannot
 * leave a hole.
 */
export function orderColumns<T extends { id: string }>(
  columns: readonly T[],
  order: readonly string[],
): T[] {
  const known = new Map(columns.map((c) => [c.id, c]));
  const placed: T[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    const found = known.get(id);
    if (found && !seen.has(id)) {
      placed.push(found);
      seen.add(id);
    }
  }
  return [...placed, ...columns.filter((c) => !seen.has(c.id))];
}

/**
 * Where a column lands when it is dropped on another.
 *
 * Returns the **complete** order, not a patch: the stored order has to name every column after a
 * move, or a column that was previously unnamed (and therefore trailing) would jump position the
 * next time the table rendered — a move the person did not make, one render after the one they
 * did.
 */
export function moveColumn(ids: readonly string[], dragged: string, target: string): string[] {
  if (dragged === target) return [...ids];
  const at = ids.indexOf(target);
  // A target the list does not contain leaves the order alone rather than appending — a drop on
  // something that is not a column is not a request to move anything.
  if (at === -1) return [...ids];

  /*
   * The target's index in the **original** list, not in the list with the dragged column already
   * removed.
   *
   * The difference is the whole behaviour. Removing first and inserting before the target always
   * lands the column *before* it, which is right dragging leftward and wrong dragging rightward:
   * dropping the first column onto the last would put it second-to-last, one short of where the
   * cursor was. Using the original index means the dragged column takes the place the target was
   * occupying, whichever direction it came from.
   */
  const without = ids.filter((id) => id !== dragged);
  const insertAt = Math.min(at, without.length);
  return [...without.slice(0, insertAt), dragged, ...without.slice(insertAt)];
}
