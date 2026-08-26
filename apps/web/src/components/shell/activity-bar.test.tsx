/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * The activity rail (track D, WIP badges). `ActivityBar` reads `usePathname` and imports
 * `signOut` from the auth client, so both are stubbed the way `sign-in-form.test.tsx` stubs its
 * own dependencies — nothing here exercises navigation or sign-out, only what the rail renders.
 */

// Complete, not just what this file needs: `mock.module` replaces the module for the rest of
// the bun:test process, and a stub missing a hook breaks whichever other file's component reads
// it next (see issue-detail.test.tsx's fuller account of this leak).
mock.module("next/navigation", () => ({
  usePathname: () => "/projects",
  useRouter: () => ({ replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

// Same completeness reasoning as the next/navigation mock above: sign-in-form.test.tsx's own
// stub of this module has both signIn and signUp, and an incomplete stub registered after it
// leaks a "signUp not found" SyntaxError into whichever file next imports the real specifier.
mock.module("@/lib/auth-client", () => ({
  signOut: async () => {},
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
}));

const { ActivityBar } = await import("./activity-bar");

afterEach(cleanup);

describe("ActivityBar", () => {
  it("offers only the destinations that exist without a project", () => {
    /*
     * The rail used to be five peers — Board, Issues, Projects, Workflows, Settings — which told
     * a newcomer a Project was one more view of the same pile. It is the container the pile lives
     * in, so the rail now holds only what genuinely exists with no Project selected: the Project
     * list, the unassigned escape hatch, and Settings. A board is reached *through* a Project.
     */
    render(
      <TooltipProvider>
        <ActivityBar signedIn={false} />
      </TooltipProvider>,
    );

    for (const name of [/^Projects$/, /^Unassigned$/, /^Settings$/]) {
      expect(screen.getByRole("link", { name })).toBeTruthy();
    }
    // The sections that moved inside a Project must not still be reachable from the rail, or the
    // hierarchy would be contradicted by the one component that states it most often.
    for (const name of [/^Board$/, /^Workflows/]) {
      expect(screen.queryByRole("link", { name })).toBeNull();
    }
  });

  it("carries no WIP badge, because the section that is WIP now lives inside a project", () => {
    // Workflows is still work in progress (F03); it is simply no longer a rail destination. The
    // marker moved to the navigator's project section list, and asserting its absence here is
    // what keeps a stale badge from being left behind on a link that no longer exists.
    render(
      <TooltipProvider>
        <ActivityBar signedIn={false} />
      </TooltipProvider>,
    );

    expect(screen.queryByText("WIP")).toBeNull();
  });
});
