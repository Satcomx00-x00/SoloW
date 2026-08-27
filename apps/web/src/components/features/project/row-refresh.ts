"use client";

import { useCallback } from "react";
import { trpc } from "@/trpc/react";

/**
 * Re-read the rows of a Project after a write, from every query that holds one.
 *
 * A row is assembled from two reads of the same rows — `project.items`, which pages, and
 * `project.allItems`, which walks those pages so the rollup and the roadmap can count. The table
 * uses the second. Every write on this surface named only the first, so a cell edit reached the
 * provider, was mirrored, and then invalidated a query nothing on screen was holding: the value
 * changed on GitHub and did not change in the interface, which reads as the write having failed.
 *
 * Naming both here rather than at each call site is the point. Which of the two a screen happens
 * to read is not something a mutation should have to know, and the last three call sites that
 * tried to know it all guessed the same way and were all wrong.
 */
export function useRowRefresh(): () => void {
  const utils = trpc.useUtils();
  return useCallback(() => {
    void utils.project.allItems.invalidate();
    void utils.project.items.invalidate();
  }, [utils]);
}
