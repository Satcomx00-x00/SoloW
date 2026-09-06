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
     * in, so the rail holds only what genuinely exists with no Project selected: the Project
     * list, the unassigned escape hatch, Workflows, and Settings. A board is reached *through* a
     * Project; a Workflow is not, because `workflow.list` takes no Project and never did.
     */
    render(
      <TooltipProvider>
        <ActivityBar signedIn={false} />
      </TooltipProvider>,
    );

    for (const name of [/^Projects$/, /^Unassigned$/, /^Workflows/, /^Settings$/]) {
      expect(screen.getByRole("link", { name })).toBeTruthy();
    }
    // The sections that really did move inside a Project must not still be reachable from the
    // rail, or the hierarchy would be contradicted by the component that states it most often.
    expect(screen.queryByRole("link", { name: /^Board$/ })).toBeNull();
  });

  it("marks Workflows as WIP, in the accessible name as well as the badge", () => {
    // F03's Monitor half is not built, so the section is live but unfinished. The badge is
    // `aria-hidden`, which is why the link's own name has to carry the same fact.
    render(
      <TooltipProvider>
        <ActivityBar signedIn={false} />
      </TooltipProvider>,
    );

    expect(screen.getByRole("link", { name: "Workflows (work in progress)" })).toBeTruthy();
    expect(screen.getByText("WIP")).toBeTruthy();
  });
});
