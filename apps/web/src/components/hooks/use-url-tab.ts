"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

/**
 * A tab strip's selection, kept in the URL (`?tab=…`).
 *
 * So a refresh stays put and a link to the Changes tab is a link to the Changes tab — the
 * same reason a list keeps its page number in the address. Read on every render, written on
 * every pick with `replace` (a tab is not a place in history) and without scrolling.
 *
 * Only a value from `tabs` comes back; anything else in the URL reads as "nothing picked", so
 * a stale or hand-typed value falls through to whatever default the page has.
 */
export function useUrlTab<T extends string>(
  key: string,
  tabs: readonly T[],
): [T | null, (tab: T) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const raw = params.get(key);
  const value = raw !== null && (tabs as readonly string[]).includes(raw) ? (raw as T) : null;
  const set = useCallback(
    (tab: T) => {
      const query = new URLSearchParams(params.toString());
      query.set(key, tab);
      router.replace(`?${query.toString()}`, { scroll: false });
    },
    [params, router, key],
  );
  return [value, set];
}
