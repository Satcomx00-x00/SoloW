"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Lets a page put its own controls in the shell's header bar.
 *
 * Without this, every page needs its own action row under the header, which is what the board
 * had: two horizontal rules within 90px of each other, splitting the page into bands before any
 * content appears. The page still owns its actions — it just renders them somewhere else.
 *
 * A DOM portal rather than context state: passing `children` through a provider would set state
 * on every render, since a fresh element is a fresh identity each time.
 */
export const HEADER_ACTIONS_ID = "shell-header-actions";

export function HeaderActionsOutlet() {
  return <div id={HEADER_ACTIONS_ID} className="flex items-center gap-1.5" />;
}

export function HeaderActions({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  // After mount, so the outlet exists. On the server this renders nothing, which is correct:
  // the header is client-rendered chrome either way.
  useEffect(() => setHost(document.getElementById(HEADER_ACTIONS_ID)), []);
  return host ? createPortal(children, host) : null;
}
