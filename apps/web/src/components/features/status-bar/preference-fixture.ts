import { DEFAULT_SURFACE_LAYOUT, type SurfaceLayout } from "@solow/core";
import type { Handlers } from "@/test/trpc-harness";

/**
 * A stand-in `ui_preference` row for the surfaces that arrange themselves (issue #3, AC-3).
 *
 * Shared by the bar's tests and the Settings section's so both drive the same thing the browser
 * drives — the two preference procedures — rather than a client-side store the product does not
 * have. It keeps the saved arrangement, so a test can click in one component and assert what the
 * next read returns, which is the round trip AC-3 is actually about.
 */
export interface PreferenceFixture {
  handlers: Handlers;
  /** The arrangement as the server would now hold it. */
  saved(): SurfaceLayout;
}

export function preferenceFixture(
  initial: SurfaceLayout = DEFAULT_SURFACE_LAYOUT,
): PreferenceFixture {
  let saved = initial;
  const dto = (surface: unknown) => ({
    surface,
    // Stated by the server from the session, never sent by the client (Principle V).
    workspaceId: "ws-test",
    userId: "user-test",
    layout: saved,
  });

  return {
    saved: () => saved,
    handlers: {
      "preference.getSurfaceLayout": (input) => dto((input as { surface: string }).surface),
      "preference.setSurfaceLayout": (input) => {
        const { surface, layout } = input as { surface: string; layout: SurfaceLayout };
        saved = layout;
        return dto(surface);
      },
    },
  };
}
