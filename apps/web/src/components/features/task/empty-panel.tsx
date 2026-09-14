import { Inbox } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The placeholder a panel shows when it has nothing yet.
 *
 * Its own file because several panels use it — the terminal and the task workspace's side
 * columns — and a shared component living inside one of them would make that one the other's
 * dependency for no reason.
 *
 * An icon and, where there is one, a second line saying when the panel tends to fill: a bare
 * grey sentence in an empty box cannot be told from a panel that failed to load. The ink is
 * the subtle token, not a faded one — at 60% opacity the old line sat near 2.3:1 on a light
 * ground, which is invisible to exactly the reader squinting at an empty panel.
 */
export function EmptyPanel({ label, hint }: { label: string; hint?: ReactNode }) {
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground-subtle text-sm">
      <Inbox aria-hidden className="size-5 opacity-70" />
      <p>{label}</p>
      {hint ? <p className="max-w-xs text-xs leading-relaxed">{hint}</p> : null}
    </div>
  );
}
