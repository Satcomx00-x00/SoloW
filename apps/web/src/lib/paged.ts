import { PAGE_SIZE_MAX } from "@solow/contracts";

/**
 * Reading a paged list from a screen that wants all of it (issue #82 AC-4).
 *
 * The bound on `issue.list`, `task.list`, `repository.list` and the two profile lists exists for
 * the **MCP surface**: those procedures are also tools, and an unbounded tool hands an agent every
 * row in the Workspace to answer a question about three of them. It was never meant to shorten a
 * screen — so a screen says `...WHOLE_PAGE` and gets the most one request may carry, which is what
 * every one of these callers already assumed it was getting.
 *
 * `truncated` is the other half, and the more important one. A Workspace past `PAGE_SIZE_MAX` is
 * rare and a count that is silently wrong at that point is not — "247 tasks" and "500 tasks" look
 * equally like facts. So a caller that *counts* says `500+`, which is true, rather than `500`,
 * which is not.
 */

/** Ask a paged list for as much as one request may carry. */
export const WHOLE_PAGE = { limit: PAGE_SIZE_MAX } as const;

/** The rows a paged query returned, and whether the answer stopped short of the whole list. */
export function pageRows<T>(data: { items: T[]; nextCursor: string | null } | undefined): {
  rows: T[];
  truncated: boolean;
} {
  return { rows: data?.items ?? [], truncated: data?.nextCursor != null };
}

/**
 * A count that admits it is a floor.
 *
 * `500+` rather than `500`, because the second is a claim this read cannot make — and a status
 * bar is exactly where a number gets believed without being checked.
 */
export function countLabel(count: number, truncated: boolean): string {
  return truncated ? `${count}+` : String(count);
}
