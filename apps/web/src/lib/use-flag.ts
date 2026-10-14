"use client";

import type { FlagKey } from "@solow/db";
import { trpc } from "@/trpc/react";

/**
 * Whether a feature flag is on for the caller's Workspace, for UI that should be absent rather
 * than disabled when it is off.
 *
 * Reads `flag.list`, which is a `sessionProcedure` and so answers even when `ff-core-program` is
 * off. Until it answers (or if it fails) this says `false`: the flags this exists for ship OFF
 * (decision 0031), so "hidden" is also the safe reading while loading — a surface that appears a
 * moment late beats one that flashes and is taken away.
 */
export function useFlag(key: FlagKey): boolean {
  return useFlagState(key) ?? false;
}

/** The same read, but `undefined` while it is still unknown — for a page that must not flash. */
export function useFlagState(key: FlagKey): boolean | undefined {
  const list = trpc.flag.list.useQuery({}, { retry: false });
  if (list.isError) return false;
  return list.data?.find((f) => f.key === key)?.enabled;
}
