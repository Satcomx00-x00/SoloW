import type { ReactNode } from "react";

/**
 * A whole screen that has nothing to show but a sentence and a way out: the 404 and the error
 * boundaries.
 *
 * Next's own versions of these are a bare white page outside the app's theme, with the raw error
 * text in development — the one moment the Owner is already lost is the worst place to stop
 * looking like SoloW. So these use the same tokens as everything else, and every one of them
 * offers an action, because a page that only says what went wrong leaves the reader stuck.
 */
export function StatusScreen({
  code,
  title,
  children,
  actions,
}: {
  /** A short tag above the title — "404", "Error". Decorative; the title carries the meaning. */
  code: string;
  title: string;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-md space-y-4" role="alert">
        <p className="font-mono text-muted-foreground text-xs tracking-wide">{code}</p>
        <h1 className="font-semibold text-xl tracking-[-0.01em]">{title}</h1>
        <div className="space-y-2 text-muted-foreground text-sm leading-relaxed">{children}</div>
        <div className="flex flex-wrap items-center gap-2 pt-2">{actions}</div>
      </div>
    </div>
  );
}
