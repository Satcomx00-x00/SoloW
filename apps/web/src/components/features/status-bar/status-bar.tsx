"use client";

import { useAppContext } from "@/lib/app-context";
import { ContributionBoundary } from "@/lib/contribution-boundary";
import { statusItemRegistry } from "@/lib/contributions";
import "@/lib/contributions-boot";
import { useSurfaceLayout } from "@/hooks/use-surface-layout";

/**
 * VS-Code-style status bar pinned to the bottom of the shell — and the first real consumer of the
 * contribution registries (issue #3).
 *
 * There is no per-segment code in this file, and there deliberately cannot be: it resolves the
 * status-item registry against the current context and the user's saved arrangement, and renders
 * whatever comes back. The segments themselves live in `status-items.tsx` as registrations, and a
 * feature module anywhere in the tree adds one the same way without this file learning about it.
 *
 * The context comes from the shell, which resolved the session on the server, rather than from a
 * browser query — asking again here would render "dev owner" first and correct itself a moment
 * later, which is the same wrong claim, just briefer.
 *
 * Each segment renders inside its own boundary. The registry already treats a `when` that throws
 * as "not visible"; a component that throws is the same third-party code with more room to fail,
 * and one failing segment must cost its own slot rather than the shell (F19 NFR-2).
 */
export function StatusBar() {
  const appContext = useAppContext();
  const { layout } = useSurfaceLayout(statusItemRegistry.surface);

  const items = statusItemRegistry.resolve(appContext, layout);
  const left = items.filter((item) => item.render.slot === "left");
  const right = items.filter((item) => item.render.slot === "right");

  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t bg-sidebar px-3 text-2xs text-muted-foreground">
      {left.map(({ id, render }) => (
        <ContributionBoundary key={id} contributionId={id}>
          <render.Component />
        </ContributionBoundary>
      ))}
      <div className="ml-auto flex items-center gap-3 tabular-nums">
        {right.map(({ id, render }) => (
          <ContributionBoundary key={id} contributionId={id}>
            <render.Component />
          </ContributionBoundary>
        ))}
      </div>
    </footer>
  );
}
