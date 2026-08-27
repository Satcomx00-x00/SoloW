import { z } from "zod";
import { idSchema } from "./common.js";

/**
 * One shape for every paged list (spec F23 NFR-1, issue #82 AC-4).
 *
 * The reason these lists are paged is not the SPA — it is the MCP surface. A tool list is derived
 * from the tRPC router (`apps/web/src/server/mcp/tools.ts`), so every `*.list` procedure is
 * already a tool an agent can call, and an unbounded one hands a model four hundred rows in full
 * to answer a question about three of them. Issue #82 states it plainly: *a tool that returns 400
 * tasks with full bodies has spent the agent's context to tell it nothing.* A bound is therefore
 * a property of the contract, not a courtesy the caller may forget.
 *
 * **A keyset cursor, never an offset.** An offset is only stable while nothing is written, and
 * these tables are written by the poll, the orchestrator and the person reading at the same time
 * — a row created between two pages shifts every offset after it, and the reader skips or repeats
 * a row without either page looking wrong. `listProjectItems` already made this choice and says
 * so; this is the same decision, generalised so there is one answer to it in the codebase.
 *
 * The cursor is **opaque on purpose**. Its contents are `(createdAt, id)` today because that is
 * the ordering every one of these lists uses, but a caller that parsed it would be depending on
 * an ordering the DAL is free to change.
 */

/**
 * How many rows a page holds by default, and the most one may ask for.
 *
 * A hundred is a screen's worth several times over and a small fraction of a context window,
 * which is the trade this number exists to make. The ceiling is what stops `limit` being a way to
 * ask for the unbounded list the bound was added to prevent.
 */
export const PAGE_SIZE_DEFAULT = 100;
export const PAGE_SIZE_MAX = 500;

/**
 * The paging half of a list input, merged into each list's own filters.
 *
 * `limit` is optional here and defaulted in the DAL (`pageLimit`), rather than carrying a zod
 * `.default()`. The guarantee is the same — a caller that says nothing gets `PAGE_SIZE_DEFAULT`,
 * never the unbounded list — but the default is applied by the layer that reads the database, so
 * every caller of the DAL gets it too, not only the ones that came through a parsed router input.
 */
export const pageInputSchema = z.object({
  /** Omitted means `PAGE_SIZE_DEFAULT`. Never "all of them". */
  limit: z.number().int().min(1).max(PAGE_SIZE_MAX).optional(),
  /** Opaque; hand back what the previous page returned. Absent reads from the beginning. */
  cursor: z.string().optional(),
});
export type PageInput = z.infer<typeof pageInputSchema>;

/**
 * One page of `item`.
 *
 * No total. Counting the whole table costs a second query on every read of every list, and none
 * of these callers show a total — the one that does (`projectItemPageDto`) counts because its
 * toolbar states it, which is the only reason worth paying for. "Is there more?" is what a pager
 * actually needs, and `nextCursor` answers it exactly.
 */
export function pageOf<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    /** Null when this was the last page. */
    nextCursor: z.string().nullable(),
  });
}

/** The cursor's contents, for the one layer allowed to know them. */
export const pageCursorSchema = z.object({
  createdAt: z.string(),
  id: idSchema,
});
export type PageCursor = z.infer<typeof pageCursorSchema>;
