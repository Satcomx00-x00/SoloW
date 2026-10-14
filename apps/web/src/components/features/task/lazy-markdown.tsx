"use client";

import { lazy, Suspense } from "react";

/**
 * `HarnessMarkdown`, loaded on first use rather than with the page.
 *
 * The renderer is `react-markdown`, `remark-gfm` and `rehype-highlight` — and the highlighter
 * brings highlight.js's common grammars with it, ~92 KB gzipped, the largest single chunk any
 * page loaded. Every screen that imports it statically paid for it up front, and most of them
 * only show markdown after a click: the Task page's two "explain" answers, the issue panel on the
 * project table, a comment's preview tab. The Task page paid it on every open for text it might
 * never show.
 *
 * Until the chunk lands, the text is shown as itself — the same characters, wrapped, in the same
 * type size — rather than an empty box. Plain text is the safe reading of untrusted markdown, so
 * the fallback cannot undo any rule `markdown.tsx` enforces.
 */
const loadMarkdown = () => import("./markdown");

const LazyMarkdown = lazy(() =>
  loadMarkdown().then((module) => ({ default: module.HarnessMarkdown })),
);

/**
 * Start fetching the renderer now. For a surface that will certainly show markdown once its read
 * resolves — so the chunk and the data travel together instead of one after the other.
 */
export function preloadHarnessMarkdown(): void {
  void loadMarkdown();
}

export function HarnessMarkdown({ text }: { text: string }) {
  return (
    <Suspense
      fallback={
        <div className="min-w-0 whitespace-pre-wrap break-words text-sm leading-[1.75]">{text}</div>
      }
    >
      <LazyMarkdown text={text} />
    </Suspense>
  );
}
