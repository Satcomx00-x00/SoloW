"use client";

import { useEffect, useState } from "react";
import { relativeAge } from "@/lib/relative-time";

/**
 * A rendered age that keeps being true.
 *
 * `relativeAge` is computed during render, which is fine for text that appears and goes — a
 * comment in a thread you scroll past. It is not fine for the status bar, which is on screen all
 * day: once its query stops refetching there is nothing left to schedule a render, so the label
 * freezes at whatever it last said. Found exactly that way — a bar reading "synced 1m ago" long
 * after it was one minute, which is the same class of lie as averaging a stale repository away.
 *
 * A tick, not a poll: this re-renders from a local clock and asks the server for nothing. Thirty
 * seconds because the label's own granularity is a minute, so anything finer would be renders
 * that cannot change a character.
 */
export function useRelativeAge(iso: string | null, tickMs = 30_000): string | null {
  const [, tick] = useState(0);

  useEffect(() => {
    // Nothing to keep current when there is no timestamp; the caller renders its own words.
    if (!iso) return;
    const timer = setInterval(() => tick((n) => n + 1), tickMs);
    return () => clearInterval(timer);
  }, [iso, tickMs]);

  return iso ? relativeAge(iso) : null;
}
