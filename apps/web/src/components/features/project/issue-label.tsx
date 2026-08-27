"use client";

import { cn } from "@/lib/utils";

/**
 * One label, in the colour its repository gives it.
 *
 * Shared by the project table and the issue drawer so a label cannot be one colour in the grid
 * and another in the panel that opened from it — which is what happens the moment two components
 * each decide how to paint the same string.
 *
 * Soft, like every other badge here: the colour at full strength for the text, mixed into the
 * surface at 8% for the fill and 10% for the border (`.badge-soft`). GitHub fills its repository
 * labels; at the density of a planning table that turns every row into a paint chart, and the
 * soft fill keeps the title the loudest thing on the line.
 */

/** A stored colour as CSS will take it, or null when the provider reported none. */
export function labelColour(color: string | null | undefined): string | null {
  if (!color) return null;
  // GitHub reports bare hex ("d73a4a"); GitLab reports it with the hash.
  if (!/^#?[0-9a-f]{3,8}$/i.test(color)) return null;
  return color.startsWith("#") ? color : `#${color}`;
}

export function IssueLabel({
  name,
  color,
  className,
}: {
  name: string;
  color?: string | null | undefined;
  className?: string;
}) {
  const hex = labelColour(color);
  return (
    <span
      className={cn(
        "badge-soft inline-flex h-5 max-w-full shrink-0 items-center truncate rounded-full border px-1.5 font-medium text-2xs",
        className,
      )}
      // A label whose provider reports no colour falls through to `--badge-color`'s own fallback
      // — a neutral soft badge rather than an invented hue.
      style={hex ? ({ "--badge-color": hex } as React.CSSProperties) : undefined}
      title={name}
    >
      {name}
    </span>
  );
}
