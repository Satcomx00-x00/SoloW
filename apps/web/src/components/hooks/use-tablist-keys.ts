"use client";

import type { KeyboardEvent } from "react";
import { useCallback } from "react";

/**
 * Roving focus along a `role="tablist"`: ←/→ wrap through the tabs, Home and End jump to the
 * ends, and Tab leaves the group — the keyboard half of the pattern, which `tabIndex={-1}` on
 * the unselected tabs makes mandatory rather than optional. A strip that removes its tabs from
 * the tab order and then offers no arrow keys has removed them from keyboards altogether.
 *
 * Focus moves; selection does not follow it (manual activation). Each strip decides what
 * selecting costs — the Workflow strip fires a query per Step — so Enter or Space is the pick.
 *
 * Queried from the DOM rather than a ref per tab: what has to move is focus, which is a DOM
 * fact, and the tabs may be rendered by a primitive that knows nothing about the strip.
 */
export function useTablistKeys<T extends HTMLElement>() {
  return useCallback((event: KeyboardEvent<T>) => {
    const { key } = event;
    if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Home" && key !== "End") return;
    const tabs = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]:not([disabled])'),
    );
    const at = tabs.indexOf(document.activeElement as HTMLElement);
    if (at === -1) return;
    event.preventDefault();
    const last = tabs.length - 1;
    const next =
      key === "Home"
        ? 0
        : key === "End"
          ? last
          : key === "ArrowLeft"
            ? (at - 1 + tabs.length) % tabs.length
            : (at + 1) % tabs.length;
    tabs[next]?.focus();
  }, []);
}
