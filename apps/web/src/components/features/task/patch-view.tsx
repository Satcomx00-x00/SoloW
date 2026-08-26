"use client";

import { cn } from "@/lib/utils";

/**
 * A unified diff, rendered.
 *
 * Extracted from `DiffView` so the source-control panel can show one file's section without a
 * second copy of the colouring rules — two renderers of the same text is how a `+` line ends up
 * green in one panel and grey in the other.
 */

/** A line's role in the patch, from its first character. */
export function lineTone(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-muted-foreground/60";
  if (line.startsWith("@@")) return "text-state-parked";
  if (line.startsWith("+")) return "text-diff-added";
  if (line.startsWith("-")) return "text-diff-removed";
  if (line.startsWith("diff --git")) return "text-muted-foreground font-medium";
  return "text-foreground/70";
}

/**
 * A `section` rather than a `div`, and the name on it rather than on the `pre` inside: a bare
 * `pre` has no role, so an `aria-label` there is dropped by the accessibility tree entirely,
 * while a named `section` is a region — which a scrollable block of code genuinely is.
 */
export function PatchView({
  patch,
  truncated = false,
  label,
}: {
  patch: string;
  truncated?: boolean;
  label?: string;
}) {
  return (
    <section
      aria-label={label}
      className="surface-edge flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-[oklch(0.13_0.008_265)]"
    >
      <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-[1.6]">
        {patch.split("\n").map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a patch is positional text whose lines carry no identity of their own, and this renders an immutable string that is never reordered or spliced.
          <div key={index} className={cn("whitespace-pre", lineTone(line))}>
            {line || " "}
          </div>
        ))}
      </pre>
      {truncated && (
        <p className="shrink-0 border-t bg-card px-3 py-1.5 text-2xs text-muted-foreground">
          Patch truncated. The file list above is complete; check out the branch to read the rest.
        </p>
      )}
    </section>
  );
}
