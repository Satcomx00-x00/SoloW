"use client";

import { RenderError } from "@/components/features/shared/render-error";

/**
 * A page outside the shell failed to render — sign-in, or the shell's own layout. Rendered inside
 * the root layout, so the theme and fonts still apply.
 */
export default function RootError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-[100dvh] flex-col">
      <RenderError {...props} />
    </main>
  );
}
